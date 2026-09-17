/**
 * The instance setting (M234), against a real Postgres and the committed
 * migrations.
 *
 * THREE THINGS HERE CANNOT BE PROVEN WITH A FAKE, which is why this file is an
 * integration test rather than another unit one:
 *
 * 1. **The round trip is the point.** A PATCH writes a row and the NEXT
 *    `/health` has to carry the new value. A fake store would prove that the
 *    handler called a method.
 *
 * 2. **A refused value leaves the row alone.** The assertion is on the ROW,
 *    read back out of Postgres, not on the status code. A 400 beside a written
 *    row is exactly the failure this checks for, and the two are
 *    indistinguishable from the response alone.
 *
 * 3. **`/health` survives a dead database.** It is the container's own
 *    healthcheck, so a read of the row there would restart the container on any
 *    database hiccup, and Bay has taken this service down that way before. The
 *    only way to state that property is to genuinely sever the pool, which
 *    needs a real one.
 */
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createDatabase } from '../../src/db/client.js';
import { createDrizzleInstanceSettingsStore } from '../../src/db/settings-store.js';
import { instanceSettings } from '../../src/db/schema.js';
import { setupTestDatabase, testDatabaseUrl, type TestDatabase } from './db-harness.js';
import { startService, type ServiceHarness } from './service-harness.js';

const ADMIN_TOKEN = 'integration-settings-token-0123456789';
const SETTINGS_PATH = '/v1/admin/settings';

interface HealthBody {
  instance?: { name: string; nutrientReferenceBasis?: string };
}

interface SettingsBody {
  settings: { nutrientReferenceBasis: string };
}

interface ErrorBody {
  error: string;
}

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
  // The row is gone with the truncate, so this process is still holding
  // whatever the last test set. Put it back on the boot default, through the
  // same write path a PATCH uses, so each test starts where a fresh instance
  // does.
  await service.settings.set({ nutrientReferenceBasis: 'dge' });
  await database.reset();
});

/** What `/health` publishes right now, or `undefined` when it publishes nothing. */
async function publishedBasis(): Promise<string | undefined> {
  const health = await service.request<HealthBody>({ method: 'GET', path: '/health' });
  assert.equal(health.status, 200, '/health must answer 200');
  return health.body.instance?.nutrientReferenceBasis;
}

/** What the row says, read straight out of Postgres, or `undefined` when there is no row. */
async function storedBasis(): Promise<string | undefined> {
  const rows = await database.db.select({ basis: instanceSettings.nutrientReferenceBasis }).from(instanceSettings);
  return rows[0]?.basis;
}

test('a PATCH round trips: the row is written and the handshake follows', async () => {
  // THE CONTROL. Without this line the assertion below would pass on an
  // instance that was already on `efsa` and on a PATCH that did nothing.
  assert.equal(await publishedBasis(), 'dge', 'a fresh instance publishes the environment default');
  assert.equal(await storedBasis(), undefined, 'and it holds no row until somebody changes something');

  const patched = await service.request<SettingsBody>({
    method: 'PATCH',
    path: SETTINGS_PATH,
    adminToken: ADMIN_TOKEN,
    body: { nutrientReferenceBasis: 'efsa' },
  });

  assert.equal(patched.status, 200);
  assert.equal(patched.body.settings.nutrientReferenceBasis, 'efsa');
  assert.equal(await storedBasis(), 'efsa', 'the row carries the new basis');
  assert.equal(await publishedBasis(), 'efsa', 'and the next handshake publishes it');
});

test('rejects an unknown value with 400 and leaves the stored row exactly as it was', async () => {
  const first = await service.request<SettingsBody>({
    method: 'PATCH',
    path: SETTINGS_PATH,
    adminToken: ADMIN_TOKEN,
    body: { nutrientReferenceBasis: 'us' },
  });
  assert.equal(first.status, 200);
  assert.equal(await storedBasis(), 'us');

  const refused = await service.request<ErrorBody>({
    method: 'PATCH',
    path: SETTINGS_PATH,
    adminToken: ADMIN_TOKEN,
    body: { nutrientReferenceBasis: 'dach' },
  });

  assert.equal(refused.status, 400);
  assert.ok(
    refused.body.error.includes('nutrientReferenceBasis'),
    `the refusal names the field: ${refused.body.error}`,
  );
  // A 400 ALONE PROVES NOTHING. A handler that wrote first and validated
  // afterwards would answer 400 and have changed the instance anyway, so both
  // the row and the handshake are checked after the refusal.
  assert.equal(await storedBasis(), 'us', 'a refused value must not reach the row');
  assert.equal(await publishedBasis(), 'us', 'nor the handshake');
});

test('rejects a patch that names nothing, and changes nothing', async () => {
  const refused = await service.request<ErrorBody>({
    method: 'PATCH',
    path: SETTINGS_PATH,
    adminToken: ADMIN_TOKEN,
    body: {},
  });

  assert.equal(refused.status, 400);
  assert.equal(await storedBasis(), undefined, 'an empty patch writes no row at all');
  assert.equal(await publishedBasis(), 'dge');
});

test('an unauthenticated PATCH is refused and changes nothing', async () => {
  // The control: the same body with the credential works, two lines down, in
  // every other test in this file. Here it must not.
  const refused = await service.request<ErrorBody>({
    method: 'PATCH',
    path: SETTINGS_PATH,
    body: { nutrientReferenceBasis: 'efsa' },
  });

  assert.equal(refused.status, 401, 'this instance has an ADMIN_TOKEN, so a missing credential is a 401');
  assert.equal(await storedBasis(), undefined, 'no row may be written without the credential');
  assert.equal(await publishedBasis(), 'dge', 'and the handshake must not move');
});

/**
 * THE CONTROL THAT MATTERS, and the reason the process-local copy exists.
 *
 * The pool is genuinely ended, which is proven in the middle of the test by a
 * store read that rejects and by a PATCH that fails: if the severing were
 * theatre, those two lines would go green and this test would be asserting
 * nothing. With the database dead, `/health` still answers 200 and still names
 * the basis this instance booted on.
 *
 * A `/health` that read the row would fail here. In production it would fail
 * against the container's healthcheck instead, which restarts the container,
 * which is the incident this is written to prevent.
 */
test('health survives a dead database and keeps reporting the environment default', async () => {
  // Its OWN pool, so ending it cannot break the suite's shared one.
  const handle = createDatabase({ connectionString: testDatabaseUrl(), ssl: false });
  const store = createDrizzleInstanceSettingsStore(handle.db);
  // `us` rather than the default `dge`, so a `/health` that hardcoded the
  // default would pass the assertion below for the wrong reason.
  const severed = await startService({
    db: handle.db,
    adminToken: ADMIN_TOKEN,
    nutrientReferenceBasis: 'us',
  });

  try {
    const alive = await severed.request<HealthBody>({ method: 'GET', path: '/health' });
    assert.equal(alive.status, 200);
    assert.equal(alive.body.instance?.nutrientReferenceBasis, 'us', 'the live instance publishes its boot default');

    // SEVER IT.
    await handle.close();

    // Proof that the severing is real, in both directions. A read through the
    // store rejects...
    await assert.rejects(async () => store.read(), 'the pool must genuinely be dead');
    // ...and the write path, which does touch the database, fails too.
    const write = await severed.request<ErrorBody>({
      method: 'PATCH',
      path: SETTINGS_PATH,
      adminToken: ADMIN_TOKEN,
      body: { nutrientReferenceBasis: 'efsa' },
    });
    assert.ok(write.status >= 500, `a write with no database must fail, saw ${write.status}`);

    // And yet the healthcheck is fine, twice, because it reads a variable.
    for (const attempt of [1, 2]) {
      const health = await severed.request<HealthBody>({ method: 'GET', path: '/health' });
      assert.equal(health.status, 200, `/health must stay 200 with no database (attempt ${attempt})`);
      assert.equal(health.body.instance?.nutrientReferenceBasis, 'us');
    }
  } finally {
    await severed.close();
  }
});

/**
 * The boot path when the row cannot be read at all: the environment default,
 * an error in the log, and a service that started.
 */
test('a service that cannot read the row boots on the environment default', async () => {
  const handle = createDatabase({ connectionString: testDatabaseUrl(), ssl: false });
  // Dead BEFORE the service boots, so the boot read is the thing that fails.
  await handle.close();

  const booted = await startService({ db: handle.db, adminToken: ADMIN_TOKEN, nutrientReferenceBasis: 'efsa' });
  try {
    const health = await booted.request<HealthBody>({ method: 'GET', path: '/health' });
    assert.equal(health.status, 200, 'an unreadable row is never a refusal to start');
    assert.equal(health.body.instance?.nutrientReferenceBasis, 'efsa');
  } finally {
    await booted.close();
  }
});

/**
 * The second replica. It never saw the PATCH, so its copy is stale until the
 * refresh timer runs; with a short interval the test can watch it catch up.
 */
test('a replica that served no write picks the change up on the refresh', async () => {
  const replica = await startService({
    db: database.db,
    adminToken: ADMIN_TOKEN,
    settingsRefreshIntervalMs: 20,
  });
  try {
    assert.equal(
      (await replica.request<HealthBody>({ method: 'GET', path: '/health' })).body.instance?.nutrientReferenceBasis,
      'dge',
      'the control: it starts on the environment default',
    );

    // Written by the OTHER process, straight to the row the replica polls.
    const patched = await service.request<SettingsBody>({
      method: 'PATCH',
      path: SETTINGS_PATH,
      adminToken: ADMIN_TOKEN,
      body: { nutrientReferenceBasis: 'efsa' },
    });
    assert.equal(patched.status, 200);

    const deadline = Date.now() + 5_000;
    let seen: string | undefined;
    while (Date.now() < deadline) {
      const health = await replica.request<HealthBody>({ method: 'GET', path: '/health' });
      seen = health.body.instance?.nutrientReferenceBasis;
      if (seen === 'efsa') break;
      await new Promise((sleep) => setTimeout(sleep, 20));
    }
    assert.equal(seen, 'efsa', 'the replica must catch up on its own refresh');
  } finally {
    await replica.close();
  }
});
