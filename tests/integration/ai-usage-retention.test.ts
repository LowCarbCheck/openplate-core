/**
 * The AI usage counters against a real Postgres: what the prune removes, what
 * an account deletion leaves behind, and what the activity endpoint draws.
 *
 * WHY THESE THREE BELONG IN ONE FILE. They are three views of one table.
 * `ai_usage_days` grew without bound from the day it was added, M201 gave it an
 * end date, and the endpoint added in the same milestone shows an operator
 * exactly the window that survives. A prune tested apart from the window it
 * feeds is a prune that can drift a day away from the strip and pass.
 *
 * COUNTS, NOT GREEN CALLS. Every assertion below reads the table back. A
 * `DELETE` that matched nothing returns 204 as happily as one that erased a
 * person, and a sweep that deleted the wrong side of the cutoff logs the same
 * line as one that worked. The unit file beside this
 * (`tests/unit/ai-usage-retention.test.ts`) proves the timer runs at all; only
 * a real database can prove the rows are gone.
 *
 * THE ROWS ARE WRITTEN DIRECTLY, because `ai_usage_days` is written by the AI
 * proxy and this file is not about the proxy. The day column is the whole input
 * to the cutoff, so seeding it is naming the fixture rather than reaching around
 * the code under test.
 */
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { and, eq } from 'drizzle-orm';
import { accounts, aiUsageDays } from '../../src/db/schema.js';
import { setupTestDatabase, type TestDatabase } from './db-harness.js';
import { sampleAuthHash, startService, type ServiceHarness } from './service-harness.js';
import { createDrizzleAiQuotaStore } from '../../src/ai/quota-store.js';
import { AI_USAGE_RETENTION_DAYS, startAiUsageRetention } from '../../src/ai/usage-retention.js';
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
});

let addressCounter = 0;

/** An account through the only door there is, plus its id. */
async function seedAccount(): Promise<number> {
  addressCounter += 1;
  const session = await service.signupThroughInvite({
    email: `usage-${addressCounter}@example.org`,
    dailyAiLimit: 200,
    authHash: sampleAuthHash(addressCounter + 3),
  });
  return session.account.id;
}

/** Writes one counter row for a day, the way the proxy's reservation would have left it. */
async function seedUsage(input: { accountId: number; day: string; count: number }): Promise<void> {
  await database.db.insert(aiUsageDays).values({ accountId: input.accountId, day: input.day, count: input.count });
}

/** How many counter rows this account still has. The assertion, in every test below. */
async function countUsageRows(accountId: number): Promise<number> {
  const rows = await database.db
    .select({ day: aiUsageDays.day })
    .from(aiUsageDays)
    .where(eq(aiUsageDays.accountId, accountId));
  return rows.length;
}

test('the prune deletes a counter outside the window and keeps one inside it', async () => {
  const accountId = await seedAccount();
  const now = new Date();
  const overAge = utcDayKeyDaysBefore(now, AI_USAGE_RETENTION_DAYS + 3);
  const oldestKept = utcDayKeyDaysBefore(now, AI_USAGE_RETENTION_DAYS - 1);
  const today = utcDayKey(now);

  await seedUsage({ accountId, day: overAge, count: 5 });
  await seedUsage({ accountId, day: oldestKept, count: 7 });
  await seedUsage({ accountId, day: today, count: 2 });
  // All three are genuinely here first, or every assertion below passes
  // vacuously.
  assert.equal(await countUsageRows(accountId), 3);

  const quota = createDrizzleAiQuotaStore(database.db);
  const sweep = startAiUsageRetention({
    quota,
    logger: createSilentLogger(),
    now: () => now,
    // An hour, so the only runs are the ones this test asks for and the counts
    // below cannot be a second tick's work.
    intervalMs: 60 * 60 * 1000,
  });

  try {
    assert.deepEqual(await sweep.runOnce(), { deleted: 1 });

    // READ THE TABLE BACK. Which rows survived is the property; the returned
    // count alone would pass for a statement that deleted the wrong one.
    const remaining = await database.db
      .select({ day: aiUsageDays.day })
      .from(aiUsageDays)
      .where(eq(aiUsageDays.accountId, accountId))
      .orderBy(aiUsageDays.day);
    assert.deepEqual(
      remaining.map((row) => row.day),
      [oldestKept, today],
      'the oldest day inside the window must survive the prune that took the day before it',
    );

    // IDEMPOTENT against the real statement, not only against a fake.
    assert.deepEqual(await sweep.runOnce(), { deleted: 0 });
    assert.equal(await countUsageRows(accountId), 2);
  } finally {
    sweep.stop();
  }
});

test('the prune leaves other accounts alone', async () => {
  const stale = await seedAccount();
  const fresh = await seedAccount();
  const now = new Date();
  await seedUsage({ accountId: stale, day: utcDayKeyDaysBefore(now, AI_USAGE_RETENTION_DAYS + 1), count: 1 });
  await seedUsage({ accountId: fresh, day: utcDayKey(now), count: 1 });

  const sweep = startAiUsageRetention({
    quota: createDrizzleAiQuotaStore(database.db),
    logger: createSilentLogger(),
    now: () => now,
    intervalMs: 60 * 60 * 1000,
  });

  try {
    await sweep.runOnce();
    assert.equal(await countUsageRows(stale), 0);
    assert.equal(await countUsageRows(fresh), 1, "a cutoff is a date, never a neighbour's row");
  } finally {
    sweep.stop();
  }
});

test('a deleted account leaves zero usage rows and no last_seen_at, counted rather than assumed', async () => {
  const accountId = await seedAccount();
  const now = new Date();

  await seedUsage({ accountId, day: utcDayKeyDaysBefore(now, 2), count: 3 });
  await seedUsage({ accountId, day: utcDayKey(now), count: 4 });
  // The same store method a login calls, so the column is written by the
  // production path rather than by a hand-rolled UPDATE.
  await service.authContext.store.touchLastSeen({ accountId, seenAt: now });

  assert.equal(await countUsageRows(accountId), 2, 'the fixture must hold rows for the deletion to erase');
  const [seenBeforeDelete] = await database.db
    .select({ lastSeenAt: accounts.lastSeenAt })
    .from(accounts)
    .where(eq(accounts.id, accountId));
  assert.notEqual(seenBeforeDelete?.lastSeenAt, null, 'and a last_seen_at, or the absence below means nothing');

  const response = await service.request({
    method: 'DELETE',
    path: `/v1/admin/accounts/${accountId}`,
    adminToken: ADMIN_TOKEN,
  });
  assert.equal(response.status, 204);

  // THE COUNT IS THE ASSERTION. A 204 is what a delete that matched nothing
  // answers too, and the erasure claim is about rows on disk.
  assert.equal(await countUsageRows(accountId), 0);
  assert.deepEqual(await database.db.select({ id: accounts.id }).from(accounts).where(eq(accounts.id, accountId)), []);
});

test('a deleted account leaves no usage row behind for a later account to inherit', async () => {
  const first = await seedAccount();
  const day = utcDayKey(new Date());
  await seedUsage({ accountId: first, day, count: 9 });

  await service.request({ method: 'DELETE', path: `/v1/admin/accounts/${first}`, adminToken: ADMIN_TOKEN });

  // Serial ids are not reused, but the query an operator's screen runs is by
  // account id and day, so this is the shape a leftover row would surface in.
  const orphans = await database.db
    .select({ accountId: aiUsageDays.accountId })
    .from(aiUsageDays)
    .where(and(eq(aiUsageDays.accountId, first), eq(aiUsageDays.day, day)));
  assert.deepEqual(orphans, []);
});

test('the activity endpoint draws the real rows, zero-filled, from the real table', async () => {
  const accountId = await seedAccount();
  const now = new Date();
  const twoDaysAgo = utcDayKeyDaysBefore(now, 2);
  const today = utcDayKey(now);

  await seedUsage({ accountId, day: twoDaysAgo, count: 6 });
  await seedUsage({ accountId, day: today, count: 1 });
  await service.authContext.store.touchLastSeen({ accountId, seenAt: now });

  const answered = await service.request<{
    accountId: number;
    lastSeenAt: string | null;
    window: { days: number; fromDay: string; toDay: string };
    days: { day: string; count: number }[];
  }>({
    method: 'GET',
    path: `/v1/admin/accounts/${accountId}/activity?days=3`,
    adminToken: ADMIN_TOKEN,
  });

  assert.equal(answered.status, 200);
  assert.equal(answered.body.accountId, accountId);
  assert.equal(answered.body.window.days, 3);
  assert.deepEqual(answered.body.days, [
    { day: twoDaysAgo, count: 6 },
    // The day between them has no row at all, and comes back as a zero rather
    // than as an absence. That distinction is the whole point of the strip.
    { day: utcDayKeyDaysBefore(now, 1), count: 0 },
    { day: today, count: 1 },
  ]);
  // A timestamp, parseable, not a phrase.
  assert.ok(Number.isFinite(Date.parse(answered.body.lastSeenAt ?? '')));
});

test('the activity endpoint caps a long window at the retention window', async () => {
  const accountId = await seedAccount();

  const answered = await service.request<{ window: { days: number }; days: { day: string; count: number }[] }>({
    method: 'GET',
    path: `/v1/admin/accounts/${accountId}/activity?days=400`,
    adminToken: ADMIN_TOKEN,
  });

  assert.equal(answered.status, 200);
  // Beyond this the prune above has already taken the rows, so a longer strip
  // could only be zero-fill an operator would read as a person who stopped.
  assert.equal(answered.body.window.days, AI_USAGE_RETENTION_DAYS);
  assert.equal(answered.body.days.length, AI_USAGE_RETENTION_DAYS);
});
