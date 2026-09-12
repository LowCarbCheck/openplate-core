/**
 * The four push routes against a real Postgres: subscribe, re-subscribe with
 * `replaces`, patch the schedule, delete.
 *
 * WHY A REAL DATABASE. `tests/unit/push-*.test.ts` prove the wiring and the
 * arithmetic: which middleware runs before which, the local day the catch-up is
 * due on, the seven day pause, the cap, the prune. None of them can prove the
 * SQL. The re-registration is an `ON CONFLICT DO UPDATE` on a unique index, the
 * `201` against `200` is decided by comparing the `created_at` that update
 * leaves alone, the `replaces` delete is a two column predicate, and a fake
 * that reimplemented any of them would be testing itself.
 *
 * ROWS, NOT GREEN CALLS. Every assertion reads the table back through the real
 * store, because a subscription is deliberately not readable over HTTP: it is a
 * sending credential and no route returns one.
 */
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { eq } from 'drizzle-orm';
import { accounts, pushSubscriptions } from '../../src/db/schema.js';
import { setupTestDatabase, type TestDatabase } from './db-harness.js';
import { sampleAuthHash, startService, TEST_VAPID_PUBLIC_KEY, type ServiceHarness } from './service-harness.js';
import { createDrizzlePushStore } from '../../src/push/push-store.js';

let database: TestDatabase;
let service: ServiceHarness;

before(async () => {
  database = await setupTestDatabase();
  // OPTED IN, unlike every other suite: an instance with no VAPID keys answers
  // the ordinary unknown-path 404 on this whole subtree, and `tests/unit/
  // push-config.test.ts` owns that half.
  service = await startService({ db: database.db, push: {} });
});

after(async () => {
  await service.close();
  await database.close();
});

beforeEach(async () => {
  await database.reset();
});

let addressCounter = 0;

/** A person through the only door there is, and the token their device holds. */
async function seedPerson(): Promise<string> {
  addressCounter += 1;
  const session = await service.signupThroughInvite({
    email: `push-${addressCounter}@example.org`,
    authHash: sampleAuthHash(addressCounter + 11),
  });
  return session.tokens.accessToken;
}

/** Every field `PUT /v1/push/subscriptions` requires, named, so a case states only what it is about. */
interface RegistrationBody {
  endpoint: string;
  keys: { p256dh: string; auth: string };
  timeZone: string;
  locale: string;
  catchUpMinute: number | null;
  fastTargetEnabled: boolean;
  replaces?: string;
}

/** Every field the route requires, with whatever this case wanted different. */
function registration(overrides: Partial<RegistrationBody> = {}): RegistrationBody {
  return {
    endpoint: 'https://push.example.org/one',
    keys: { p256dh: 'a-device-public-key', auth: 'a-device-auth-secret' },
    timeZone: 'Europe/Berlin',
    locale: 'de',
    catchUpMinute: 8 * 60,
    fastTargetEnabled: true,
    ...overrides,
  };
}

/** The stored row for an endpoint, read through the real store rather than over HTTP. */
async function storedRow(endpoint: string) {
  const [row] = await database.db.select().from(pushSubscriptions).where(eq(pushSubscriptions.endpoint, endpoint));
  return row;
}

test('the config route hands a browser the application server key it needs to subscribe', async () => {
  const accessToken = await seedPerson();
  const response = await service.request<{ publicKey: string }>({
    method: 'GET',
    path: '/v1/push/config',
    accessToken,
  });

  assert.equal(response.status, 200);
  assert.equal(response.body.publicKey, TEST_VAPID_PUBLIC_KEY);
});

test('a first registration is 201 and writes every column the tick reads', async () => {
  const accessToken = await seedPerson();
  const response = await service.request<{ subscribed: boolean }>({
    method: 'PUT',
    path: '/v1/push/subscriptions',
    accessToken,
    body: registration(),
  });

  assert.equal(response.status, 201);
  const row = await storedRow('https://push.example.org/one');
  assert.ok(row !== undefined, 'the row must actually be in Postgres');
  assert.equal(row.timeZone, 'Europe/Berlin');
  assert.equal(row.locale, 'de');
  assert.equal(row.catchUpMinute, 480);
  assert.equal(row.fastTargetEnabled, true);
  assert.equal(row.wakeAt, null);
  assert.equal(row.sendsToday, 0);
  // Stamped in the device's OWN zone, which is what the seven day pause counts
  // in. A `date` column comes back as `YYYY-MM-DD`.
  assert.match(row.lastSeenDay, /^\d{4}-\d{2}-\d{2}$/);
});

test('the same endpoint again is 200, keeps created_at, and takes the new schedule', async () => {
  const accessToken = await seedPerson();
  await service.request({ method: 'PUT', path: '/v1/push/subscriptions', accessToken, body: registration() });
  const first = await storedRow('https://push.example.org/one');

  const again = await service.request({
    method: 'PUT',
    path: '/v1/push/subscriptions',
    accessToken,
    body: registration({ catchUpMinute: 7 * 60, locale: 'en', fastTargetEnabled: false }),
  });

  assert.equal(again.status, 200, 'a refresh is 200; only a first registration is 201');
  const second = await storedRow('https://push.example.org/one');
  assert.equal(second?.id, first?.id, 'one row, updated, and never a second one');
  // "Since when has this device been subscribed" is the question the column
  // answers, so a re-registration must not restart the clock.
  assert.equal(second?.createdAt.getTime(), first?.createdAt.getTime());
  assert.equal(second?.catchUpMinute, 420);
  assert.equal(second?.locale, 'en');
  assert.equal(second?.fastTargetEnabled, false);
});

test('replaces deletes this account predecessor and leaves another account row alone', async () => {
  const anna = await seedPerson();
  const bert = await seedPerson();

  await service.request({
    method: 'PUT',
    path: '/v1/push/subscriptions',
    accessToken: anna,
    body: registration({ endpoint: 'https://push.example.org/anna-old' }),
  });
  await service.request({
    method: 'PUT',
    path: '/v1/push/subscriptions',
    accessToken: bert,
    body: registration({ endpoint: 'https://push.example.org/bert' }),
  });

  const created = await service.request({
    method: 'PUT',
    path: '/v1/push/subscriptions',
    accessToken: anna,
    body: registration({
      endpoint: 'https://push.example.org/anna-new',
      replaces: 'https://push.example.org/anna-old',
    }),
  });

  assert.equal(created.status, 201);
  assert.equal(await storedRow('https://push.example.org/anna-old'), undefined, 'the predecessor went');
  assert.ok((await storedRow('https://push.example.org/anna-new')) !== undefined);
  assert.ok((await storedRow('https://push.example.org/bert')) !== undefined, 'and nobody else was touched');
});

test('naming another account endpoint as a predecessor deletes nothing', async () => {
  // THE CONTROL, and the one that matters: a `replaces` that ignored the
  // account would make this route a way to unhook any phone on the instance
  // whose endpoint you could read from a log.
  const anna = await seedPerson();
  const bert = await seedPerson();

  await service.request({
    method: 'PUT',
    path: '/v1/push/subscriptions',
    accessToken: bert,
    body: registration({ endpoint: 'https://push.example.org/bert' }),
  });
  await service.request({
    method: 'PUT',
    path: '/v1/push/subscriptions',
    accessToken: anna,
    body: registration({
      endpoint: 'https://push.example.org/anna',
      replaces: 'https://push.example.org/bert',
    }),
  });

  assert.ok((await storedRow('https://push.example.org/bert')) !== undefined, "another account's row survives");
});

test('the patch writes a wake instant, and null clears it', async () => {
  const accessToken = await seedPerson();
  await service.request({ method: 'PUT', path: '/v1/push/subscriptions', accessToken, body: registration() });

  const wakeAt = '2026-01-15T18:30:00.000Z';
  const set = await service.request({
    method: 'PATCH',
    path: '/v1/push/subscriptions',
    accessToken,
    body: { endpoint: 'https://push.example.org/one', wakeAt },
  });

  assert.equal(set.status, 200);
  assert.equal((await storedRow('https://push.example.org/one'))?.wakeAt?.toISOString(), wakeAt);

  const cleared = await service.request({
    method: 'PATCH',
    path: '/v1/push/subscriptions',
    accessToken,
    body: { endpoint: 'https://push.example.org/one', wakeAt: null },
  });

  assert.equal(cleared.status, 200);
  // A fast stopped early must stop being a notification.
  assert.equal((await storedRow('https://push.example.org/one'))?.wakeAt, null);
});

test('the patch changes one field and leaves the rest exactly as they were', async () => {
  const accessToken = await seedPerson();
  await service.request({ method: 'PUT', path: '/v1/push/subscriptions', accessToken, body: registration() });

  await service.request({
    method: 'PATCH',
    path: '/v1/push/subscriptions',
    accessToken,
    body: { endpoint: 'https://push.example.org/one', catchUpMinute: 7 * 60 + 30 },
  });

  const row = await storedRow('https://push.example.org/one');
  assert.equal(row?.catchUpMinute, 450);
  assert.equal(row?.timeZone, 'Europe/Berlin', 'an absent field is unchanged, never defaulted');
  assert.equal(row?.locale, 'de');
  assert.equal(row?.fastTargetEnabled, true);
});

test('a patch for another account endpoint is a 404 and changes nothing', async () => {
  const anna = await seedPerson();
  const bert = await seedPerson();
  await service.request({
    method: 'PUT',
    path: '/v1/push/subscriptions',
    accessToken: bert,
    body: registration({ endpoint: 'https://push.example.org/bert' }),
  });

  const response = await service.request({
    method: 'PATCH',
    path: '/v1/push/subscriptions',
    accessToken: anna,
    body: { endpoint: 'https://push.example.org/bert', catchUpMinute: 0 },
  });

  assert.equal(response.status, 404);
  assert.equal((await storedRow('https://push.example.org/bert'))?.catchUpMinute, 480, 'untouched');
});

test('a delete removes this account row and answers the same to a repeat', async () => {
  const accessToken = await seedPerson();
  await service.request({ method: 'PUT', path: '/v1/push/subscriptions', accessToken, body: registration() });

  const first = await service.request({
    method: 'DELETE',
    path: '/v1/push/subscriptions',
    accessToken,
    body: { endpoint: 'https://push.example.org/one' },
  });
  assert.equal(first.status, 200);
  assert.equal(await storedRow('https://push.example.org/one'), undefined);

  // IDEMPOTENT: a device unsubscribing twice, or one the tick already pruned,
  // gets the same answer rather than a 404 that reports on rows it does not own.
  const second = await service.request({
    method: 'DELETE',
    path: '/v1/push/subscriptions',
    accessToken,
    body: { endpoint: 'https://push.example.org/one' },
  });
  assert.equal(second.status, 200);
});

test('a delete cannot reach another account row', async () => {
  const anna = await seedPerson();
  const bert = await seedPerson();
  await service.request({
    method: 'PUT',
    path: '/v1/push/subscriptions',
    accessToken: bert,
    body: registration({ endpoint: 'https://push.example.org/bert' }),
  });

  await service.request({
    method: 'DELETE',
    path: '/v1/push/subscriptions',
    accessToken: anna,
    body: { endpoint: 'https://push.example.org/bert' },
  });

  assert.ok((await storedRow('https://push.example.org/bert')) !== undefined);
});

test('an unknown time zone is refused at write time, so the tick can never meet one', async () => {
  const accessToken = await seedPerson();
  const response = await service.request({
    method: 'PUT',
    path: '/v1/push/subscriptions',
    accessToken,
    body: registration({ timeZone: 'Middle/Earth' }),
  });

  assert.equal(response.status, 400);
  assert.equal(await storedRow('https://push.example.org/one'), undefined, 'and nothing was written');
});

test('a minute outside the day is refused by the route and by the table', async () => {
  const accessToken = await seedPerson();
  const response = await service.request({
    method: 'PUT',
    path: '/v1/push/subscriptions',
    accessToken,
    body: registration({ catchUpMinute: 1440 }),
  });

  assert.equal(response.status, 400);
  assert.equal(await storedRow('https://push.example.org/one'), undefined);
});

test('erasing an account takes its subscriptions with it', async () => {
  // THE CASCADE, exercised by deleting the ACCOUNT and never the subscription:
  // a person who leaves must stop being woken, and the foreign key is the only
  // thing that makes that true without anybody remembering it.
  const accessToken = await seedPerson();
  await service.request({ method: 'PUT', path: '/v1/push/subscriptions', accessToken, body: registration() });
  const row = await storedRow('https://push.example.org/one');
  assert.ok(row !== undefined, 'the row must exist for the cascade to have something to reach');

  await database.db.delete(accounts).where(eq(accounts.id, row.accountId));

  assert.equal(await storedRow('https://push.example.org/one'), undefined);
});

test('the store stats count what the operator sees, and never a row', async () => {
  const accessToken = await seedPerson();
  await service.request({ method: 'PUT', path: '/v1/push/subscriptions', accessToken, body: registration() });
  await service.request({
    method: 'PUT',
    path: '/v1/push/subscriptions',
    accessToken,
    body: registration({ endpoint: 'https://push.example.org/two' }),
  });

  const store = createDrizzlePushStore(database.db);
  const today = new Date().toISOString().slice(0, 10);
  assert.deepEqual(await store.stats({ day: today }), { subscriptions: 2, sentToday: 0 });

  await store.markCatchUpSent({
    endpoint: 'https://push.example.org/one',
    localDay: today,
    sendsDay: today,
    sends: 1,
  });
  assert.deepEqual(await store.stats({ day: today }), { subscriptions: 2, sentToday: 1 });
});
