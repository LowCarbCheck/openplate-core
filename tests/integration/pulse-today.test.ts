/**
 * The community pulse against a real Postgres: the seven fields, the exact
 * contributor count, the five minute cache, the idempotent replay and the
 * prune.
 *
 * WHY A REAL DATABASE. `tests/unit/pulse-*.test.ts` prove the wiring: the order
 * the handler runs its steps in, the limits, the sweep that fires with nobody
 * asking. None of them can prove the SQL. The idempotency guarantee is a unique
 * violation on a primary key, the presence upsert is an `ON CONFLICT DO UPDATE`,
 * the contributor count is a `COUNT` over a composite key, and a fake that
 * reimplemented any of them would be testing itself.
 *
 * COUNTS, NOT GREEN CALLS. Every assertion reads the numbers back through
 * `GET /v1/pulse/today`, which is the surface a client actually has, and the
 * prune assertions read the tables directly because a deleted row has no
 * endpoint.
 */
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { count, eq } from 'drizzle-orm';
import { pulseDayContributors, pulseDays, pulseIdempotency, pulsePresence } from '../../src/db/schema.js';
import { setupTestDatabase, type TestDatabase } from './db-harness.js';
import { sampleAuthHash, startService, type ServiceHarness } from './service-harness.js';
import { createDrizzlePulseStore } from '../../src/pulse/pulse-store.js';
import { PULSE_PRESENCE_TTL_MS, PULSE_RETENTION_DAYS, startPulseRetention } from '../../src/pulse/pulse-retention.js';
import { PULSE_FASTING_INTERVAL_MS } from '../../src/pulse/pulse-rate-limit.js';
import { PULSE_CACHE_TTL_MS } from '../../src/pulse/pulse-cache.js';
import { utcDayKey, utcDayKeyDaysBefore } from '../../src/lib/utc-day.js';
import { createSilentLogger } from '../../src/logger.js';

const ADMIN_TOKEN = 'integration-admin-token-0123456789abcdef';

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
  // THE LIMITER IS IN PROCESS AND THE APP IS SHARED BY THE WHOLE FILE, while
  // `reset` restarts the identity sequence: account id 1 in one test is a
  // different person from account id 1 in the next, and they would share a
  // bucket. Moving the clock past the longest window empties every bucket.
  // Access tokens live 15 minutes, so this happens BEFORE a test mints one.
  service.advance(PULSE_FASTING_INTERVAL_MS + 1_000);
});

let addressCounter = 0;
let keyCounter = 0;

/** A person through the only door there is, and the token their device holds. */
async function seedPerson(): Promise<{ accessToken: string; authHash: string }> {
  addressCounter += 1;
  const authHash = sampleAuthHash(addressCounter + 11);
  const session = await service.signupThroughInvite({
    email: `pulse-${addressCounter}@example.org`,
    authHash,
  });
  return { accessToken: session.tokens.accessToken, authHash };
}

/** A fresh uuid v4 shaped key. Distinct per call, so only a test that WANTS a replay gets one. */
function freshKey(): string {
  keyCounter += 1;
  return `6f1c3a1e-9d7b-4a2f-8b31-${keyCounter.toString(16).padStart(12, '0')}`;
}

interface TodayBody {
  day: string;
  meals: number;
  photos: number;
  kcal: number;
  protein: number;
  contributors: number;
  fastingNow: number;
}

async function today(accessToken: string): Promise<TodayBody> {
  const response = await service.request<TodayBody>({ method: 'GET', path: '/v1/pulse/today', accessToken });
  assert.equal(response.status, 200);
  return response.body;
}

async function post(input: { accessToken: string; path: string; key?: string; body?: unknown }): Promise<number> {
  const response = await service.request<unknown>({
    method: 'POST',
    path: input.path,
    accessToken: input.accessToken,
    headers: { 'idempotency-key': input.key ?? freshKey() },
    body: input.body ?? {},
  });
  return response.status;
}

test('an instance nobody opted in on answers seven fields, all zero', async () => {
  const anna = (await seedPerson()).accessToken;
  const body = await today(anna);

  assert.deepEqual(Object.keys(body).toSorted(), [
    'contributors',
    'day',
    'fastingNow',
    'kcal',
    'meals',
    'photos',
    'protein',
  ]);
  assert.equal(body.day, utcDayKey(new Date(service.now())));
  assert.deepEqual(
    { meals: body.meals, photos: body.photos, kcal: body.kcal, protein: body.protein },
    { meals: 0, photos: 0, kcal: 0, protein: 0 },
  );
  assert.equal(body.contributors, 0);
  assert.equal(body.fastingNow, 0);
});

test('an anonymous caller gets a 401 rather than the numbers', async () => {
  const response = await service.request<unknown>({ method: 'GET', path: '/v1/pulse/today' });
  assert.equal(response.status, 401);
});

test('meals and photographs from two people sum, and contributors counts the people', async () => {
  const anna = (await seedPerson()).accessToken;
  const bert = (await seedPerson()).accessToken;

  assert.equal(await post({ accessToken: anna, path: '/v1/pulse/meal', body: { kcal: 1234, protein: 33 } }), 202);
  assert.equal(await post({ accessToken: bert, path: '/v1/pulse/meal', body: { kcal: 600, protein: 30 } }), 202);
  assert.equal(await post({ accessToken: anna, path: '/v1/pulse/photo' }), 202);

  // Past the cache and past the one-per-minute limits.
  service.advance(PULSE_CACHE_TTL_MS + 1_000);

  const body = await today(anna);
  assert.equal(body.meals, 2);
  assert.equal(body.photos, 1);
  // THE SERVER ROUNDED: 1234 was sent and 1250 was stored, so the sum is 1850
  // rather than 1834. A route that forwarded the exact figure fails here.
  assert.equal(body.kcal, 1850);
  assert.equal(body.protein, 65);
  // TWO PEOPLE, THREE WRITES. A count of writes would say three here, and the
  // client's floor of three would then be met by one person eating three times.
  assert.equal(body.contributors, 2);

  const [contributorRows] = await database.db
    .select({ total: count() })
    .from(pulseDayContributors)
    .where(eq(pulseDayContributors.day, body.day));
  assert.equal(contributorRows?.total, 2, 'one row per account per day, not one per write');
});

test('a second read inside five minutes is the cached one, and the next window is not', async () => {
  const anna = (await seedPerson()).accessToken;

  // The cold read fills the entry with zeroes.
  assert.equal((await today(anna)).meals, 0);

  assert.equal(await post({ accessToken: anna, path: '/v1/pulse/meal', body: { kcal: 600, protein: 30 } }), 202);
  // The row IS in Postgres, whatever the cached answer says.
  const [dayRow] = await database.db.select().from(pulseDays);
  assert.equal(dayRow?.meals, 1);

  service.advance(PULSE_CACHE_TTL_MS - 60_000);
  assert.equal((await today(anna)).meals, 0, 'a write inside the window does not change the answer');

  // THE CONTROL. Past the window the entry reloads.
  service.advance(120_000);
  assert.equal((await today(anna)).meals, 1);
});

test('a replayed key changes nothing, and a fresh one does', async () => {
  const anna = (await seedPerson()).accessToken;
  const key = freshKey();

  assert.equal(await post({ accessToken: anna, path: '/v1/pulse/meal', key, body: { kcal: 600, protein: 30 } }), 202);
  assert.equal(await post({ accessToken: anna, path: '/v1/pulse/meal', key, body: { kcal: 600, protein: 30 } }), 200);

  const [afterReplay] = await database.db.select().from(pulseDays);
  assert.equal(afterReplay?.meals, 1, 'a replay must not reach the counter');
  assert.equal(afterReplay?.kcal, 600);

  // THE CONTROL: past the limiter window, a different key does count. Without
  // this, a route that dropped every write would pass the assertion above.
  service.advance(61_000);
  assert.equal(await post({ accessToken: anna, path: '/v1/pulse/meal', body: { kcal: 600, protein: 30 } }), 202);
  const [afterFresh] = await database.db.select().from(pulseDays);
  assert.equal(afterFresh?.meals, 2);
});

test('two heartbeats leave one presence row, and an expired row stops counting', async () => {
  const anna = (await seedPerson()).accessToken;
  const bert = (await seedPerson()).accessToken;
  const store = createDrizzlePulseStore(database.db);
  const startedAt = new Date(service.now());

  assert.equal(await post({ accessToken: anna, path: '/v1/pulse/fasting' }), 202);
  assert.equal(await post({ accessToken: bert, path: '/v1/pulse/fasting' }), 202);

  // Past the ten minute limiter, and well inside the thirty minute window.
  service.advance(11 * 60_000);
  assert.equal(await post({ accessToken: anna, path: '/v1/pulse/fasting' }), 202);

  const rows = await database.db.select().from(pulsePresence).orderBy(pulsePresence.accountId);
  assert.equal(rows.length, 2, 'two people, two rows, whatever the number of heartbeats');
  const [annaRow, bertRow] = rows;
  assert.ok(annaRow !== undefined && bertRow !== undefined);
  // THE EXPIRY FOLLOWS THE LAST HEARTBEAT. An upsert that left the first value
  // in place gives two equal instants here.
  assert.equal(annaRow.expiresAt.getTime(), startedAt.getTime() + 11 * 60_000 + PULSE_PRESENCE_TTL_MS);
  assert.equal(bertRow.expiresAt.getTime(), startedAt.getTime() + PULSE_PRESENCE_TTL_MS);

  // THE COUNT IS READ AT A NAMED INSTANT rather than by moving the shared clock
  // an hour, because an access token lives 15 minutes and a test that advanced
  // past that would be measuring the bearer middleware. This is the `expires_at
  // > now` predicate itself, against the real rows.
  const day = utcDayKey(startedAt);
  assert.equal((await store.totals({ day, now: startedAt })).fastingNow, 2);
  // Bert is gone and Anna is not, which is the whole difference their eleven
  // minutes made.
  assert.equal((await store.totals({ day, now: new Date(startedAt.getTime() + 31 * 60_000) })).fastingNow, 1);
  assert.equal((await store.totals({ day, now: new Date(startedAt.getTime() + 42 * 60_000) })).fastingNow, 0);
});

test('the prune deletes a day outside the window, its contributor rows, expired presence and old keys', async () => {
  const anna = (await seedPerson()).accessToken;
  const accountId = 1;
  const store = createDrizzlePulseStore(database.db);
  const now = new Date(service.now());

  const overAge = utcDayKeyDaysBefore(now, PULSE_RETENTION_DAYS + 3);
  const oldestKept = utcDayKeyDaysBefore(now, PULSE_RETENTION_DAYS - 1);

  // Seeded through the store, because the store is what production writes with.
  await store.addMeal({ day: overAge, accountId, kcal: 500, protein: 25 });
  await store.addMeal({ day: oldestKept, accountId, kcal: 600, protein: 30 });
  await store.markFasting({ accountId, expiresAt: new Date(now.getTime() - 60_000) });
  await store.claim({ key: freshKey(), accountId, now: new Date(now.getTime() - 25 * 60 * 60 * 1000) });
  const liveKey = freshKey();
  await store.claim({ key: liveKey, accountId, now });

  // All of it is genuinely here first, or every assertion below passes against
  // a database that was empty to begin with.
  assert.equal((await database.db.select().from(pulseDays)).length, 2);
  assert.equal((await database.db.select().from(pulseDayContributors)).length, 2);
  assert.equal((await database.db.select().from(pulsePresence)).length, 1);
  assert.equal((await database.db.select().from(pulseIdempotency)).length, 2);

  const sweep = startPulseRetention({
    pulse: store,
    logger: createSilentLogger(),
    now: () => now,
    // An hour, so the timer cannot fire and the run below is the only one.
    intervalMs: 60 * 60 * 1000,
  });
  try {
    const removed = await sweep.runOnce();
    assert.deepEqual(removed, { days: 1, contributors: 1, presence: 1, idempotencyKeys: 1 });
  } finally {
    sweep.stop();
  }

  // THE CONTROLS: the 29 day old day, its contributor row and the fresh key all
  // survive. A sweep that deleted everything would pass the counts above.
  const keptDays = await database.db.select().from(pulseDays);
  assert.deepEqual(
    keptDays.map((row) => row.day),
    [oldestKept],
  );
  assert.equal((await database.db.select().from(pulseDayContributors)).length, 1);
  assert.equal((await database.db.select().from(pulsePresence)).length, 0);
  const keptKeys = await database.db.select().from(pulseIdempotency);
  assert.deepEqual(
    keptKeys.map((row) => row.key),
    [liveKey],
  );

  // And the survivor is readable through the endpoint, which is what a person
  // would see: today has nothing, because both seeded days are in the past.
  assert.equal((await today(anna)).meals, 0);
});

test('an erased account takes its contributor and presence rows with it, and leaves the day sums alone', async () => {
  const anna = await seedPerson();

  assert.equal(
    await post({ accessToken: anna.accessToken, path: '/v1/pulse/meal', body: { kcal: 600, protein: 30 } }),
    202,
  );
  assert.equal(await post({ accessToken: anna.accessToken, path: '/v1/pulse/fasting' }), 202);

  const deleted = await service.request<never>({
    method: 'POST',
    path: '/v1/auth/delete',
    accessToken: anna.accessToken,
    body: { authHash: anna.authHash },
  });
  assert.equal(deleted.status, 204);

  assert.equal((await database.db.select().from(pulseDayContributors)).length, 0, 'the cascade takes the edge');
  assert.equal((await database.db.select().from(pulsePresence)).length, 0);
  assert.equal((await database.db.select().from(pulseIdempotency)).length, 0);

  // THE DAY SUM SURVIVES, on purpose: `pulse_days` references nothing, so an
  // instance wide total for a past day cannot fall when somebody leaves. The
  // contributor count it is read with does fall, which is correct.
  const [dayRow] = await database.db.select().from(pulseDays);
  assert.equal(dayRow?.meals, 1);
});

test('the admin stats report the same numbers a member can read', async () => {
  const anna = (await seedPerson()).accessToken;
  assert.equal(await post({ accessToken: anna, path: '/v1/pulse/meal', body: { kcal: 1234, protein: 33 } }), 202);
  assert.equal(await post({ accessToken: anna, path: '/v1/pulse/fasting' }), 202);

  const stats = await service.request<{
    stats: { pulse: { meals: number; kcal: number; protein: number; contributors: number; fastingNow: number } };
  }>({ method: 'GET', path: '/v1/admin/stats', adminToken: ADMIN_TOKEN });
  assert.equal(stats.status, 200);
  assert.deepEqual(stats.body.stats.pulse, {
    meals: 1,
    photos: 0,
    kcal: 1250,
    protein: 35,
    contributors: 1,
    fastingNow: 1,
  });
  // The operator's body carries no `day`, which the store's shape does: a
  // projection rather than a spread. See `server/admin-routes.ts`.
  assert.equal(Object.keys(stats.body.stats.pulse).includes('day'), false);
});
