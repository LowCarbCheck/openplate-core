/**
 * The biller's credential reaches three routes and is refused on every other
 * one, ENUMERATED FROM THE ROUTERS rather than from a list somebody typed.
 *
 * WHY AN ENUMERATION AND NOT A SAMPLE. A sample of five refusals proves five
 * refusals. The property that has to hold is "every admin route except three",
 * and the only thing that can still be true after somebody adds another route
 * next quarter is a test that asks the router what routes exist. So
 * `enumerateRoutes` walks `Router.stack`, and a route registered later is
 * therefore asserted against without anybody editing this file. Default deny
 * is what makes that safe: the new route is not in the allow list, so it is
 * refused, and the test stays green for the right reason.
 *
 * THE COUNT IS A DECISION GATE, in the way
 * `tests/unit/admin-no-forbidden-fields.test.ts`'s key whitelist is. Refusing
 * a new route by default is correct but silent, and a route that SHOULD be
 * reachable by the biller would ship refused with nobody finding out until
 * production. Asserting the total makes adding a route to this service a
 * moment where somebody says out loud which principal may call it.
 *
 * THE CONTROL IS THE ALLOW LIST ITSELF. Three assertions here can each go red:
 *   1. every allowed route answers something OTHER than 403 ("an allowed route
 *      is not refused"), so a scope that refused everything fails;
 *   2. every allow-list entry is a route this service actually registers, so a
 *      fake entry typed into `SERVICE_PRINCIPAL_ROUTES` fails here rather than
 *      silently widening nothing;
 *   3. the list is exactly three long, so widening it by accident fails.
 * A fourth, at the bottom, keeps the operator's own token working, because a
 * gate that refused every credential would satisfy the enumeration.
 *
 * THE FEEDBACK SURFACE IS TURNED ON in the harness, deliberately. With
 * `SYNC_FEEDBACK` off those four paths answer 404 to everybody, and a 403
 * asserted against them would be asserting that the scope beat a route which
 * does not exist.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import type { Router } from 'express';
import { startAdminHarness, type AdminHarness } from './admin-harness.js';
import { createAdminRoutes } from '../../src/server/admin-routes.js';
import { createAdminFeedbackRoutes } from '../../src/server/admin-feedback-routes.js';
import { createFakeAdminStore } from './fake-admin-store.js';
import { createFakeInviteStore } from './fake-invite-store.js';
import { createFakeFeedbackAdminStore, createFakeFeedbackImageStore } from './feedback-harness.js';
import { createAuthFixture } from './auth-context-fixture.js';
import { createSilentLogger } from '../../src/logger.js';
import {
  SERVICE_PRINCIPAL_ROUTES,
  SERVICE_SCOPE_REFUSAL,
  type AdminRouteRef,
} from '../../src/server/service-principal-scope.js';
import { createFakeBlobRollbackStore } from './fake-blob-rollback-store.js';

/** Generated, as the operator is told to generate theirs. Long enough to pass `MIN_ADMIN_TOKEN_LENGTH`. */
const BILLING_TOKEN = 'billing-2f7c4a1e9b3d6058ac71fe42';
const ADMIN_TOKEN = 'admin-9d41c7b8e0a25f36471dcb9e';

/**
 * How many routes the whole admin surface has today: fifteen account and
 * invite routes, four operator feedback routes. See the header, this is the
 * decision gate rather than a fact that happens to be pinned.
 *
 * M224 took it from seventeen to nineteen with the blob restore path
 * (`GET .../blob/versions` and `POST .../blob/rollback`, ADR-0009). The
 * decision it forced: NEITHER is on the biller's allow list. A subscription
 * buys an allowance, and nothing a biller pays for gives it a reason to read
 * somebody's blob history or to delete their accepted writes.
 */
const ADMIN_ROUTE_COUNT = 19;

let harness: AdminHarness;
let routes: AdminRouteRef[];
let targetId: number;

/**
 * Every route the two admin routers register, as the verb and the
 * mount-relative path express matches it under.
 *
 * A route registered with two handlers, as the PATCH is because it carries its
 * own `express.json`, appears once per handler in `route.stack`, so the pairs
 * are de-duplicated.
 */
function enumerateRoutes(routers: readonly Router[]): AdminRouteRef[] {
  const seen = new Map<string, AdminRouteRef>();
  for (const router of routers) {
    for (const layer of router.stack) {
      const route = layer.route;
      if (route === undefined) continue;
      for (const handler of route.stack) {
        const ref: AdminRouteRef = { method: handler.method.toUpperCase(), path: route.path };
        seen.set(`${ref.method} ${ref.path}`, ref);
      }
    }
  }
  return [...seen.values()];
}

/** The two routers, built over fakes purely so their route tables can be read. */
function buildAdminRouters(): Router[] {
  const fixture = createAuthFixture();
  return [
    createAdminFeedbackRoutes({
      surface: { reports: createFakeFeedbackAdminStore([]), images: createFakeFeedbackImageStore() },
      logger: createSilentLogger(),
    }),
    createAdminRoutes({
      metadata: createFakeAdminStore(),
      invites: createFakeInviteStore(),
      accounts: fixture.store,
      blobs: createFakeBlobRollbackStore(),
      mailer: fixture.mailer,
      mailConfigured: false,
      links: null,
      aiInstanceDailyLimit: null,
      memberInvites: false,
      mintResetToken: fixture.ctx.mintResetToken,
      now: fixture.now,
      logger: createSilentLogger(),
    }),
  ];
}

/** A callable path for a route pattern: `:id` becomes the account both stores were seeded with. */
function concretePath(route: AdminRouteRef): string {
  return `/v1/admin${route.path.replaceAll(':id', String(targetId))}`;
}

function isAllowed(route: AdminRouteRef): boolean {
  return SERVICE_PRINCIPAL_ROUTES.some((allowed) => allowed.method === route.method && allowed.path === route.path);
}

before(async () => {
  routes = enumerateRoutes(buildAdminRouters());
  harness = await startAdminHarness({
    adminToken: ADMIN_TOKEN,
    billingToken: BILLING_TOKEN,
    feedbackEnabled: true,
  });

  // Seeded in BOTH stores: the metadata store the reads go through, and the
  // account store the patch writes to. An out-of-scope route must answer 403
  // for a target that really exists, or the refusal could be a 404 in disguise.
  const account = await harness.fakeAccounts.seedAccount({ email: 'payer@example.org', role: 'member' });
  targetId = account.id;
  harness.admin.seed({
    id: account.id,
    email: 'payer@example.org',
    dailyAiLimit: 50,
    allowanceExpiresAt: new Date('2099-01-01T00:00:00.000Z'),
  });
});

after(async () => {
  await harness.close();
});

test('the admin surface has the number of routes this scope was decided against', () => {
  assert.equal(
    routes.length,
    ADMIN_ROUTE_COUNT,
    'a route was added or removed: decide whether the billing principal may call it, then update ADMIN_ROUTE_COUNT',
  );
});

test('every admin route outside the allow list refuses the service principal with 403', async () => {
  const refused: string[] = [];
  for (const route of routes) {
    if (isAllowed(route)) continue;
    const response = await harness.request({
      method: route.method,
      path: concretePath(route),
      token: BILLING_TOKEN,
    });
    const body = await response.json();
    assert.equal(response.status, 403, `${route.method} ${route.path} must be 403, not ${response.status}`);
    assert.deepEqual(body, { error: SERVICE_SCOPE_REFUSAL }, `${route.method} ${route.path} body`);
    refused.push(`${route.method} ${route.path}`);
  }
  // The enumeration must have had something to say: a router that registered
  // nothing would satisfy every assertion in the loop above.
  assert.equal(refused.length, ADMIN_ROUTE_COUNT - SERVICE_PRINCIPAL_ROUTES.length);
});

test('an allowed route is not refused', async () => {
  const read = await harness.request({
    method: 'GET',
    path: `/v1/admin/accounts/${targetId}`,
    token: BILLING_TOKEN,
  });
  assert.equal(read.status, 200, 'the single read must answer');

  const list = await harness.request({ method: 'GET', path: '/v1/admin/accounts/expiring', token: BILLING_TOKEN });
  assert.equal(list.status, 200, 'the reconciliation list must answer');

  const patch = await harness.request({
    method: 'PATCH',
    path: `/v1/admin/accounts/${targetId}`,
    token: BILLING_TOKEN,
    body: { dailyAiLimit: 60 },
  });
  assert.equal(patch.status, 200, 'the patch must answer');
});

test('every entry in the allow list is a route this service actually registers', () => {
  for (const allowed of SERVICE_PRINCIPAL_ROUTES) {
    const registered = routes.some((route) => route.method === allowed.method && route.path === allowed.path);
    assert.ok(registered, `${allowed.method} ${allowed.path} is in the allow list but is not a registered route`);
  }
});

test('the allow list is exactly three routes', () => {
  assert.equal(SERVICE_PRINCIPAL_ROUTES.length, 3);
});

test('the operator token still reaches a route the billing principal is refused', async () => {
  const response = await harness.request({ method: 'GET', path: '/v1/admin/stats', token: ADMIN_TOKEN });
  assert.equal(response.status, 200);
});
