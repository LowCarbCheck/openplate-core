---
name: a-schema-change-reddens-every-integration-test
description: adding a column to src/db/schema.ts turns EVERY integration test red until the migration is generated; the failure reads as "signup answered 500"
metadata:
  type: project
---

`tests/integration/db-harness.ts` builds the test schema by running the
COMMITTED migrations, never from `schema.ts`. So a new column in `schema.ts`
with no generated migration makes every Drizzle statement that names it fail,
and the whole integration tier goes red with
`signup for anna@example.org answered 500: {"error":"internal server error"}`.
Nothing in the output names the missing column.

**Why:** the harness's own doc says a harness that built its schema by any
other route would let a broken migration pass a green suite. That is correct,
and it means schema work and migration generation cannot be separated.

**How to apply:** when a task hands you a schema change but forbids generating
the migration (`drizzle-kit generate` needs a pty for its rename prompt, so a
separate runner does it), the integration tier is BLOCKED, not broken. Verify
your integration tests against a throwaway database instead: point
`TEST_DATABASE_URL` at a scratch name, let `setupTestDatabase()` create and
migrate it, then `ALTER TABLE ... ADD COLUMN` by hand ONCE, run the suites,
and DROP the database afterwards. `reset()` only truncates, so the hand-added
column survives every test. Never do this to
`openplate_sync_test`, which other sessions share.

The generate command is
`pnpm drizzle:generate` (`tsx node_modules/drizzle-kit/bin.cjs generate`).

Related: [[openplate-sync-gate-and-toolbox]].
