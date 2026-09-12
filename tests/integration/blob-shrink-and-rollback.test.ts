/**
 * The M224 fix against a real Postgres and the committed migrations: the
 * refusal, its control, the boundary, the pre-shrink pin, the tiered retention
 * and the operator's rollback.
 *
 * ── WHY THESE PROPERTIES NEED A DATABASE ────────────────────────────────────
 *
 * The decisions are pure and are tested as such (`tests/unit/blob-retention.test.ts`,
 * `tests/unit/blob-rollback-plan.test.ts`). What only a real table can show is
 * that they reach ROWS: that a refused push leaves the stored `bytea` byte-for-byte
 * as it was, that `pinned_until` is written on the version the shrink replaced
 * and is honoured by the sweep that runs on every subsequent write, and that a
 * rollback deletes the later rows rather than inserting a copy whose AAD no
 * client could ever verify.
 *
 * EVERY ASSERTION HERE HAS A CONTROL. The refusal is asserted beside the same
 * push acknowledged; the pin is asserted beside a version the flat rule
 * prunes; the rollback is asserted on the rows that remain and the rows that
 * do not.
 */
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { asc, eq } from 'drizzle-orm';
import { syncBlobs } from '../../src/db/schema.js';
import { BLOB_VERSION_RETENTION, SHRINK_REFUSED_ERROR } from '../../src/protocol.js';
import { setupTestDatabase, type TestDatabase } from './db-harness.js';
import { sampleAuthHash, startService, type ServiceHarness } from './service-harness.js';

const ADMIN_TOKEN = 'integration-admin-token-0123456789abcdef';
const EMAIL = 'wiped@example.org';

let database: TestDatabase;
let service: ServiceHarness;

before(async () => {
  database = await setupTestDatabase();
  service = await startService({ db: database.db, adminToken: ADMIN_TOKEN });
});

after(async () => {
  await service.close();
  await database.close();
});

beforeEach(async () => {
  await database.reset();
});

/** Opaque base64 of an exact decoded length. The service reads the length and never the bytes. */
function ciphertext(bytes: number, fill = 7): string {
  return Buffer.alloc(bytes, fill).toString('base64');
}

async function signUp(): Promise<{ accountId: number; accessToken: string }> {
  const session = await service.signupThroughInvite({
    email: EMAIL,
    displayName: 'Wiped Diary',
    authHash: sampleAuthHash(31),
  });
  return { accountId: session.account.id, accessToken: session.tokens.accessToken };
}

interface PushBody {
  newVersion?: number;
  error?: string;
  currentSizeBytes?: number;
}

async function push(input: {
  accessToken: string;
  baseVersion: number;
  bytes: number;
  fill?: number;
  shrinkAcknowledged?: boolean;
}): Promise<{ status: number; body: PushBody }> {
  // The field is OMITTED unless a test names it, because "absent" and "false"
  // must be the same answer on the wire and a test that always sent `false`
  // would never prove it.
  const body =
    input.shrinkAcknowledged === undefined
      ? { baseVersion: input.baseVersion, envelopeVersion: 1, ciphertext: ciphertext(input.bytes, input.fill ?? 7) }
      : {
          baseVersion: input.baseVersion,
          envelopeVersion: 1,
          ciphertext: ciphertext(input.bytes, input.fill ?? 7),
          shrinkAcknowledged: input.shrinkAcknowledged,
        };
  const response = await service.request<PushBody>({
    method: 'POST',
    path: '/v1/sync/blob',
    accessToken: input.accessToken,
    body,
  });
  return { status: response.status, body: response.body };
}

/** Every retained row of one account, oldest first, read straight out of the table. */
async function storedVersions(accountId: number) {
  return database.db
    .select({
      blobVersion: syncBlobs.blobVersion,
      sizeBytes: syncBlobs.sizeBytes,
      ciphertext: syncBlobs.ciphertext,
      pinnedUntil: syncBlobs.pinnedUntil,
    })
    .from(syncBlobs)
    .where(eq(syncBlobs.accountId, accountId))
    .orderBy(asc(syncBlobs.blobVersion));
}

// ---------------------------------------------------------------------------
// The refusal, and its control
// ---------------------------------------------------------------------------

test('an unacknowledged wipe is refused and the stored ciphertext is byte-for-byte what it was', async () => {
  const { accountId, accessToken } = await signUp();
  // The incident's own numbers.
  assert.equal((await push({ accessToken, baseVersion: 0, bytes: 5310 })).status, 200);

  const refused = await push({ accessToken, baseVersion: 1, bytes: 1588 });
  assert.equal(refused.status, 400);
  assert.equal(refused.body.error, SHRINK_REFUSED_ERROR);

  const rows = await storedVersions(accountId);
  assert.equal(rows.length, 1, 'a refused push must not write a row');
  assert.equal(rows[0]?.blobVersion, 1, 'and must not consume a version');
  // THE ASSERTION THE WHOLE FIX IS FOR: the bytes, not the status.
  assert.equal(rows[0]?.sizeBytes, 5310);
  assert.deepEqual(Buffer.from(rows[0]?.ciphertext ?? new Uint8Array()), Buffer.alloc(5310, 7));
});

test('THE CONTROL: the identical push carrying shrinkAcknowledged is accepted and stored', async () => {
  const { accountId, accessToken } = await signUp();
  assert.equal((await push({ accessToken, baseVersion: 0, bytes: 5310 })).status, 200);

  const accepted = await push({ accessToken, baseVersion: 1, bytes: 1588, shrinkAcknowledged: true });
  assert.equal(accepted.status, 200);
  assert.equal(accepted.body.newVersion, 2);

  const rows = await storedVersions(accountId);
  assert.equal(rows.at(-1)?.sizeBytes, 1588);
});

test('THE BOUNDARY: a shrink to exactly half is accepted with no acknowledgement at all', async () => {
  const { accountId, accessToken } = await signUp();
  assert.equal((await push({ accessToken, baseVersion: 0, bytes: 1000 })).status, 200);

  const accepted = await push({ accessToken, baseVersion: 1, bytes: 500 });
  assert.equal(accepted.status, 200, 'half is not a large shrink, and ordinary editing must never be refused');
  assert.equal((await storedVersions(accountId)).at(-1)?.sizeBytes, 500);
});

// ---------------------------------------------------------------------------
// The pin
// ---------------------------------------------------------------------------

test('the version before an acknowledged shrink survives a sweep the flat rule would have pruned it in', async () => {
  const { accountId, accessToken } = await signUp();

  // v1 is the good diary. v2 is the wipe, acknowledged, which pins v1.
  assert.equal((await push({ accessToken, baseVersion: 0, bytes: 5310, fill: 1 })).status, 200);
  assert.equal((await push({ accessToken, baseVersion: 1, bytes: 1588, shrinkAcknowledged: true })).status, 200);

  const pinned = (await storedVersions(accountId)).find((row) => row.blobVersion === 1);
  assert.notEqual(pinned?.pinnedUntil, null, 'the pre-shrink version must carry a pin');

  // Six more ordinary pushes, all on the same UTC day. The recent tier holds
  // five and the daily tier holds one of those five, so under the pre-M224
  // rule v1 and v2 would both be gone by now.
  for (let baseVersion = 2; baseVersion <= 7; baseVersion += 1) {
    assert.equal((await push({ accessToken, baseVersion, bytes: 1600 })).status, 200);
  }

  const rows = await storedVersions(accountId);
  const versions = new Set(rows.map((row) => row.blobVersion));
  assert.equal(versions.has(1), true, 'the pinned pre-shrink version must still be there');
  // THE CONTROL FOR THE PIN: version 2 is exactly as old, carries no pin, and
  // is gone. Without it "v1 survived" could just mean nothing was pruned.
  assert.equal(versions.has(2), false, 'the unpinned version beside it must have been pruned');
  assert.equal(rows[0]?.sizeBytes, 5310, 'and what survived is the good diary, not a copy of the wipe');
});

test('the retention sweep keeps the recent tier and prunes below it', async () => {
  const { accountId, accessToken } = await signUp();
  // Nine ordinary pushes on one UTC day: the daily tier can hold only the
  // newest, which the recent tier already holds, so the count is the cap.
  for (let baseVersion = 0; baseVersion < 9; baseVersion += 1) {
    assert.equal((await push({ accessToken, baseVersion, bytes: 4000 + baseVersion })).status, 200);
  }
  const versions = (await storedVersions(accountId)).map((row) => row.blobVersion);
  assert.deepEqual(versions, [5, 6, 7, 8, 9]);
  assert.equal(versions.length, BLOB_VERSION_RETENTION);
});

// ---------------------------------------------------------------------------
// The rollback
// ---------------------------------------------------------------------------

test('an account rolled back has the intended version current, and the later rows are gone', async () => {
  const { accountId, accessToken } = await signUp();
  assert.equal((await push({ accessToken, baseVersion: 0, bytes: 5310, fill: 1 })).status, 200);
  assert.equal((await push({ accessToken, baseVersion: 1, bytes: 1588, shrinkAcknowledged: true })).status, 200);
  assert.equal((await push({ accessToken, baseVersion: 2, bytes: 1600 })).status, 200);

  const listed = await service.request<{ versions: { blobVersion: number; sizeBytes: number }[] }>({
    method: 'GET',
    path: `/v1/admin/accounts/${accountId}/blob/versions`,
    adminToken: ADMIN_TOKEN,
  });
  assert.equal(listed.status, 200);
  assert.deepEqual(
    listed.body.versions.map((entry) => entry.blobVersion),
    [3, 2, 1],
  );

  const rolled = await service.request<{ blobVersion: number; discardedVersions: number[] }>({
    method: 'POST',
    path: `/v1/admin/accounts/${accountId}/blob/rollback`,
    adminToken: ADMIN_TOKEN,
    body: { targetVersion: 1 },
  });
  assert.equal(rolled.status, 200);
  assert.deepEqual(rolled.body, { blobVersion: 1, discardedVersions: [2, 3] });

  // The rows, not the response: the later versions are deleted and the good
  // diary is the maximum again, which is what a client's next pull reads.
  const rows = await storedVersions(accountId);
  assert.deepEqual(
    rows.map((row) => row.blobVersion),
    [1],
  );
  assert.deepEqual(Buffer.from(rows[0]?.ciphertext ?? new Uint8Array()), Buffer.alloc(5310, 1));

  // And a pull says the same thing, byte for byte, at the version the AAD binds.
  const pulled = await service.request<{ blobVersion: number; ciphertext: string }>({
    method: 'GET',
    path: '/v1/sync/blob',
    accessToken,
  });
  assert.equal(pulled.status, 200);
  assert.equal(pulled.body.blobVersion, 1);
  assert.equal(pulled.body.ciphertext, ciphertext(5310, 1));
});

test('a rollback to a version that is not there changes nothing, and says why', async () => {
  const { accountId, accessToken } = await signUp();
  assert.equal((await push({ accessToken, baseVersion: 0, bytes: 4000 })).status, 200);
  assert.equal((await push({ accessToken, baseVersion: 1, bytes: 4100 })).status, 200);

  const refused = await service.request<{ error: string }>({
    method: 'POST',
    path: `/v1/admin/accounts/${accountId}/blob/rollback`,
    adminToken: ADMIN_TOKEN,
    body: { targetVersion: 9 },
  });
  assert.equal(refused.status, 400);
  assert.match(refused.body.error, /pruned/i);
  assert.equal((await storedVersions(accountId)).length, 2, 'a refused rollback deletes nothing');
});
