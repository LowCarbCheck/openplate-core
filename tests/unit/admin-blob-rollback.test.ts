/**
 * The operator's restore surface: `GET /v1/admin/accounts/:id/blob/versions`
 * and `POST /v1/admin/accounts/:id/blob/rollback` (M224, ADR-0009).
 *
 * ── WHAT THIS FILE IS FOR, AND WHAT IT IS NOT ───────────────────────────────
 *
 * `blob-rollback-plan.test.ts` proves the DECISION. This proves the ROUTE:
 * that an unknown account is the ordinary 404 rather than an empty list, that a
 * refusal arrives as a sentence rather than a status, and that the version list
 * carries a byte count and never a byte. The store underneath is a fake that
 * runs the real planner, so a refusal seen here is the refusal the service
 * makes.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startAdminHarness, type AdminHarness } from './admin-harness.js';
import { ENVELOPE_VERSION } from '../../src/protocol.js';
import type { BlobVersionSummary } from '../../src/lib/blob-rollback.js';

/** The `GET .../blob/versions` body, transcribed from `server/admin-routes.ts`'s `AdminBlobVersionView`. */
interface VersionsBody {
  versions: { blobVersion: number; envelopeVersion: number; sizeBytes: number; createdAt: string; pinnedUntil: string | null }[];
}

/** The `POST .../blob/rollback` bodies, success and refusal. */
interface RollbackBody {
  blobVersion?: number;
  discardedVersions?: number[];
  error?: string;
}

/** Reads a JSON body at the shape the route documents. One place, so the SAFETY note is written once. */
async function readJson<T>(response: Response): Promise<T> {
  // SAFETY: every call below names the §5.20 response shape for the path it
  // asked for, and each assertion that follows fails loudly on anything else.
  return (await response.json()) as T;
}

const ADMIN_TOKEN = 'admin-token-for-the-unit-suite-0123456789';
const CREATED = new Date('2026-09-12T10:00:00.000Z');
const PINNED_UNTIL = new Date('2026-09-26T10:00:00.000Z');

let harness: AdminHarness;

before(async () => {
  harness = await startAdminHarness({ adminToken: ADMIN_TOKEN });
});

after(async () => {
  await harness.close();
});

function version(input: { blobVersion: number; sizeBytes: number; pinnedUntil?: Date | null }): BlobVersionSummary {
  return {
    blobVersion: input.blobVersion,
    envelopeVersion: ENVELOPE_VERSION,
    sizeBytes: input.sizeBytes,
    createdAt: CREATED,
    pinnedUntil: input.pinnedUntil ?? null,
  };
}

/** One account whose diary was wiped: four good versions, then two tiny ones. */
async function seedWipedAccount(email: string): Promise<number> {
  const created = await harness.fakeAccounts.seedAccount({ email, verifier: 'verifier-never-in-a-response' });
  harness.admin.seed({ id: created.id, email, blobSizeBytes: 1588 });
  harness.blobs.seedVersions(created.id, [
    version({ blobVersion: 6, sizeBytes: 1588 }),
    version({ blobVersion: 5, sizeBytes: 1588 }),
    version({ blobVersion: 4, sizeBytes: 5310, pinnedUntil: PINNED_UNTIL }),
    version({ blobVersion: 3, sizeBytes: 5280 }),
  ]);
  return created.id;
}

test('the version list reports sizes, times and the pin, newest first, and no ciphertext', async () => {
  const accountId = await seedWipedAccount('versions@example.org');

  const response = await harness.request({
    method: 'GET',
    path: `/v1/admin/accounts/${accountId}/blob/versions`,
    token: ADMIN_TOKEN,
  });
  assert.equal(response.status, 200);
  const body = await readJson<VersionsBody>(response);

  assert.deepEqual(
    body.versions.map((entry) => entry.blobVersion),
    [6, 5, 4, 3],
  );
  assert.equal(body.versions[0]?.sizeBytes, 1588);
  assert.equal(body.versions[2]?.pinnedUntil, PINNED_UNTIL.toISOString());
  assert.equal(body.versions[0]?.pinnedUntil, null);
  // ADR-0001's projection, restated on a new endpoint: a byte count, never a byte.
  const serialized = JSON.stringify(body);
  assert.equal(serialized.includes('ciphertext'), false);
});

test('a version list for an account that does not exist is the ordinary 404, not an empty list', async () => {
  const response = await harness.request({
    method: 'GET',
    path: '/v1/admin/accounts/98765/blob/versions',
    token: ADMIN_TOKEN,
  });
  assert.equal(response.status, 404);
});

test('rolling back to the pinned pre-wipe version makes it current and removes the later ones', async () => {
  const accountId = await seedWipedAccount('rollback@example.org');

  const response = await harness.request({
    method: 'POST',
    path: `/v1/admin/accounts/${accountId}/blob/rollback`,
    token: ADMIN_TOKEN,
    body: { targetVersion: 4 },
  });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { blobVersion: 4, discardedVersions: [5, 6] });

  // THE INTENDED VERSION IS CURRENT AND THE LATER ROWS ARE GONE, read back
  // through the same surface an operator would read it through.
  const listed = await harness.request({
    method: 'GET',
    path: `/v1/admin/accounts/${accountId}/blob/versions`,
    token: ADMIN_TOKEN,
  });
  const body = await readJson<VersionsBody>(listed);
  assert.deepEqual(
    body.versions.map((entry) => entry.blobVersion),
    [4, 3],
  );
});

test('a rollback to a version the service no longer holds is refused in words, and changes nothing', async () => {
  const accountId = await seedWipedAccount('refused@example.org');

  const response = await harness.request({
    method: 'POST',
    path: `/v1/admin/accounts/${accountId}/blob/rollback`,
    token: ADMIN_TOKEN,
    body: { targetVersion: 2 },
  });
  assert.equal(response.status, 400);
  const body = await readJson<RollbackBody>(response);
  assert.match(body.error ?? '', /pruned/i, 'the refusal has to tell the operator what to do next');

  const listed = await harness.request({
    method: 'GET',
    path: `/v1/admin/accounts/${accountId}/blob/versions`,
    token: ADMIN_TOKEN,
  });
  const versions = await readJson<VersionsBody>(listed);
  assert.equal(versions.versions.length, 4, 'a refused rollback must delete nothing');
});

test('a rollback to the version that is already current is refused rather than reported as done', async () => {
  const accountId = await seedWipedAccount('already@example.org');
  const response = await harness.request({
    method: 'POST',
    path: `/v1/admin/accounts/${accountId}/blob/rollback`,
    token: ADMIN_TOKEN,
    body: { targetVersion: 6 },
  });
  assert.equal(response.status, 400);
  assert.match(await readJson<RollbackBody>(response).then((body) => body.error ?? ''), /already the current one/i);
});

test('a missing or non-integer targetVersion is a 400 about the body', async () => {
  const accountId = await seedWipedAccount('bad-body@example.org');
  const badBodies: unknown[] = [{}, { targetVersion: 0 }, { targetVersion: 'four' }, { targetVersion: 1.5 }];
  for (const body of badBodies) {
    const response = await harness.request({
      method: 'POST',
      path: `/v1/admin/accounts/${accountId}/blob/rollback`,
      token: ADMIN_TOKEN,
      body,
    });
    assert.equal(response.status, 400, `expected a 400 for ${JSON.stringify(body)}`);
  }
});

test('the restore surface needs the admin credential, exactly as every other route here does', async () => {
  const accountId = await seedWipedAccount('unauthenticated@example.org');
  const listed = await harness.request({ method: 'GET', path: `/v1/admin/accounts/${accountId}/blob/versions` });
  const rolled = await harness.request({
    method: 'POST',
    path: `/v1/admin/accounts/${accountId}/blob/rollback`,
    body: { targetVersion: 4 },
  });
  assert.notEqual(listed.status, 200);
  assert.notEqual(rolled.status, 200);
});
