---
name: the-admin-tree-has-a-third-principal
description: BILLING_TOKEN is a scoped AdminPrincipal refused by default at the mount; the scope test enumerates express Router.stack, and two fakes cannot share a deleted row
metadata:
  type: project
---

M213 spec 01 added `{ kind: 'service' }` to `AdminPrincipal`
(`src/server/admin-auth.ts`) and one policy module,
`src/server/service-principal-scope.ts`, holding the three-route allow list,
the two-field PATCH list, and `enforceServicePrincipalScope`. `create-app.ts`
mounts that middleware INSIDE the one `app.use(ADMIN_API_PREFIX, ...)`,
between the auth middleware and both routers, so default deny costs no
database read.

**Why the details bite:**

- The tracker check is `grep -c "'/accounts" service-principal-scope.ts` equal
  to 3. Never write `'/accounts` in a comment in that file; the three allow
  list entries are the only lines allowed to contain it.
- `GET /accounts/expiring` must be registered BEFORE `GET /accounts/:id` in
  `admin-routes.ts`, or express matches the parameterised route and answers
  404.
- Changing `AdminPrincipal` breaks exactly ONE call site that tsc finds:
  `describeAdmin` in `admin-feedback-routes.ts`. `isSelfLockout` already
  narrowed on `kind === 'account'` and needed nothing.
- The admin surface is 17 routes now (13 account/invite, 4 feedback).
  `tests/unit/service-principal-scope.test.ts` pins that count as a DECISION
  gate and enumerates the rest from `Router.stack`: `layer.route.stack[n].method`
  is typed by `@types/express-serve-static-core`, `route.methods` is not, and a
  PATCH with its own `express.json` appears twice, so de-duplicate.

**How to apply:** a route added under `/v1/admin` is refused to the biller by
default and reddens only the count assertion, which is where somebody decides.
A test that erases an account must call the new `FakeAdminStore.forget(id)`:
`fakeAccounts` and `admin` are two fakes over one real table, so a DELETE
through the route leaves the metadata fake still holding the summary and a
"gone account is a 404" assertion fails as a fixture problem. There is no
`deletedAt` column and the spec's "plus deletedAt when the row is gone" was
answered as a plain 404, because erasure is a cascade and a tombstone would
outlive the erasure.

Related: [[an-account-view-field-is-pinned-by-four-lists]],
[[openplate-sync-gate-and-toolbox]].
