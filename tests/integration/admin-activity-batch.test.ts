/**
 * `AdminMetadataStore.activityForAccounts` against a real Postgres and the
 * committed migrations.
 *
 * THE CLAIM THIS FILE EXISTS TO PROVE IS "ONE QUERY, MANY ACCOUNTS". The
 * endpoint above it (`GET /v1/admin/activity`) was added because drawing a
 * strip per row of the people list one request at a time is N+1; a store
 * method that quietly looped would move the N+1 down a layer and leave the
 * endpoint looking fixed. So the store is built over a Drizzle handle with a
 * COUNTING logger, and the assertion is on the number of statements the
 * database was actually sent, not on the answer being correct by accident.
 *
 * The grouping itself is pure and is tested without a database in
 * `tests/unit/admin-activity-list.test.ts`. What only Postgres can show is
 * that the day range is a DATE comparison rather than a string one, and that
 * an account outside the `IN (...)` contributes nothing.
 */
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { drizzle } from 'drizzle-orm/node-postgres';
import { accounts, aiUsageDays } from '../../src/db/schema.js';
import * as schema from '../../src/db/schema.js';
import { createDrizzleAdminStore } from '../../src/db/admin-store.js';
import type { AdminMetadataStore } from '../../src/admin/admin-store.js';
import { setupTestDatabase, type TestDatabase } from './db-harness.js';
import { sampleKdfDescriptor } from './service-harness.js';

let database: TestDatabase;
let store: AdminMetadataStore;
/** Every statement the store sent since the last reset, counted by Drizzle's own logger. */
let statements: string[];

before(async () => {
  database = await setupTestDatabase();
  statements = [];
  const counting = drizzle(database.pool, {
    schema,
    logger: { logQuery: (query: string) => void statements.push(query) },
  });
  store = createDrizzleAdminStore(counting);
});

after(async () => {
  await database.close();
});

beforeEach(async () => {
  await database.reset();
  statements = [];
});

/** Three accounts, ids ascending, with no usage rows of their own yet. */
async function seedThreeAccounts(): Promise<number[]> {
  const rows = await database.db
    .insert(accounts)
    .values(
      ['first', 'second', 'third'].map((name) => ({
        email: `${name}@example.org`,
        verifier: `verifier-${name}`,
        kdfDescriptor: sampleKdfDescriptor(),
      })),
    )
    .returning({ id: accounts.id });
  return rows.map((row) => row.id);
}

test('one statement serves three accounts, and each gets only its own rows', async () => {
  const [first, second, third] = await seedThreeAccounts();
  assert.ok(first !== undefined && second !== undefined && third !== undefined);

  await database.db.insert(aiUsageDays).values([
    { accountId: first, day: '2026-09-06', count: 1 },
    { accountId: first, day: '2026-09-08', count: 4 },
    { accountId: second, day: '2026-09-07', count: 2 },
    // The third account has no rows at all, which is the case a strip has to
    // report as zeroes rather than as an absence.
  ]);

  statements = [];
  const rows = await store.activityForAccounts({
    accountIds: [first, second, third],
    fromDay: '2026-09-06',
    toDay: '2026-09-08',
  });

  // THE POINT OF THE WHOLE ENDPOINT: three accounts, one round trip.
  assert.equal(statements.length, 1, `expected one statement, got ${statements.length}`);
  assert.deepEqual(rows, [
    { accountId: first, day: '2026-09-06', count: 1 },
    { accountId: first, day: '2026-09-08', count: 4 },
    { accountId: second, day: '2026-09-07', count: 2 },
  ]);
});

test('a day outside the range and an account outside the list both contribute nothing', async () => {
  const [first, second, third] = await seedThreeAccounts();
  assert.ok(first !== undefined && second !== undefined && third !== undefined);

  await database.db.insert(aiUsageDays).values([
    { accountId: first, day: '2026-09-01', count: 11 },
    { accountId: first, day: '2026-09-07', count: 3 },
    { accountId: first, day: '2026-09-30', count: 12 },
    // Not asked about below.
    { accountId: third, day: '2026-09-07', count: 13 },
  ]);

  const rows = await store.activityForAccounts({
    accountIds: [first, second],
    fromDay: '2026-09-06',
    toDay: '2026-09-08',
  });

  // `day` is a `date` column, so both ends are date comparisons in Postgres
  // and neither the earlier nor the later row can reach the caller.
  assert.deepEqual(rows, [{ accountId: first, day: '2026-09-07', count: 3 }]);
});

test('an empty page asks the database nothing at all', async () => {
  statements = [];
  const rows = await store.activityForAccounts({ accountIds: [], fromDay: '2026-09-06', toDay: '2026-09-08' });

  assert.deepEqual(rows, []);
  // An empty `IN ()` is not valid SQL, and a page with no accounts has nothing
  // to ask about.
  assert.equal(statements.length, 0);
});
