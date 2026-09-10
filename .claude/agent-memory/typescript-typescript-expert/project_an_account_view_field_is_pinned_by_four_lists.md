---
name: an-account-view-field-is-pinned-by-four-lists
description: adding one field to AccountView means editing four frozen key lists and two projections; the compiler catches only half of them
metadata:
  type: project
---

`AccountView` in `src/protocol.ts` is emitted by TWO builders, both named
`toAccountView`: the auth one in `src/accounts/auth-handlers.ts` (over
`AccountRecord`) and the admin one in `src/server/admin-routes.ts` (over
`AdminAccountSummary`). A new field therefore travels through
`accounts/account-store.ts` + `db/account-store.ts`'s `mapAccountRow`, AND
`admin/admin-store.ts` + `db/admin-store.ts`'s `IDENTITY_COLUMNS` and
`summarize`, plus both fakes (`tests/unit/fake-account-store.ts`,
`fake-admin-store.ts`).

**Why:** tsc finds every one of those. What it does NOT find are three
`assert.deepEqual(Object.keys(view).toSorted(), [...])` whitelists that fail at
RUN time: `tests/unit/auth-handlers.test.ts`,
`tests/unit/admin-accounts.test.ts`, `tests/unit/admin-no-forbidden-fields.test.ts`.
The third one is a deliberate gate: a new field has to be justified against
ADR-0001 before it can ship.

**How to apply:** after a green typecheck, run the unit suite before claiming
anything. Also `tests/integration/admin-api.test.ts` carries a hand-written
`AccountBody` decode interface that should grow the field for honesty even
though nothing forces it.

Related: [[a-schema-change-reddens-every-integration-test]].
