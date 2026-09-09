/**
 * With no `ADMIN_TOKEN`, the admin API does not exist — to anybody.
 *
 * WHY THIS IS THE FIRST TEST AND NOT A LATER HARDENING PASS. This service
 * auto-deploys on push, so the commit that adds an admin route is the commit
 * that puts it in production, on an instance with real accounts on it. The
 * only thing that makes shipping the feature safe before anyone has decided to
 * enable it is that an unconfigured deployment is INDISTINGUISHABLE from one
 * where the feature was never written. That has to be true in the same commit
 * as the first route, not retrofitted after somebody notices.
 *
 * A 401 would be the failure. It announces that a credential exists here and
 * is merely locked, which on a service whose threat model assumes the attacker
 * can reach it is an invitation to come back with a wordlist. So every admin
 * path must answer exactly what an unknown path answers — same status, same
 * body — including for a caller who presents a perfectly well-formed bearer
 * token, which is the case a "did we forget to mount auth" bug would sail
 * through.
 *
 * M213 ADDS A SECOND VARIABLE TO THE SAME RULE. `BILLING_TOKEN` is a third
 * credential on this tree, and the bargain is unchanged: with NEITHER token
 * configured the whole subtree is still the ordinary unknown-path 404, to a
 * caller presenting a perfectly well-formed billing token as much as to
 * anybody. A self-hoster who configured nothing gained no surface when the
 * feature shipped. The control for that is at the bottom of this file: with
 * `BILLING_TOKEN` set and a WRONG value presented the same paths answer 401,
 * so the 404 above is the absence of a credential and not a broken mount.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startAdminHarness, type AdminHarness } from './admin-harness.js';

let harness: AdminHarness;

/** Every path the admin API would occupy if it were mounted. */
const ADMIN_PATHS: readonly { method: string; path: string }[] = [
  { method: 'GET', path: '/v1/admin/accounts' },
  { method: 'GET', path: '/v1/admin/accounts/1' },
  { method: 'PATCH', path: '/v1/admin/accounts/1' },
  { method: 'GET', path: '/v1/admin/accounts/expiring' },
  { method: 'DELETE', path: '/v1/admin/accounts/1' },
  { method: 'GET', path: '/v1/admin/stats' },
  { method: 'GET', path: '/v1/admin/invites' },
  { method: 'POST', path: '/v1/admin/invites' },
  { method: 'DELETE', path: '/v1/admin/invites/1' },
  { method: 'GET', path: '/v1/admin' },
  { method: 'GET', path: '/v1/admin/anything-else' },
];

/** A syntactically perfect credential. It must buy nothing, because there is nothing to buy. */
const VALID_LOOKING_TOKEN = 'a'.repeat(48);

/** What a billing service would present. It must buy nothing either, because nothing was configured. */
const VALID_LOOKING_BILLING_TOKEN = 'billing-0c48e17a9d2b365fe0a7c134';

before(async () => {
  harness = await startAdminHarness({ adminToken: null, billingToken: null });
  harness.admin.seed({ id: 1, email: 'seeded@example.org', allowanceExpiresAt: new Date('2099-01-01T00:00:00.000Z') });
});

after(async () => {
  await harness.close();
});

test('every admin path 404s when no admin token is configured', async () => {
  for (const route of ADMIN_PATHS) {
    const response = await harness.request(route);
    assert.equal(response.status, 404, `${route.method} ${route.path} must be 404, not ${response.status}`);
  }
});

test('a well-formed bearer token buys nothing — still 404, never 401', async () => {
  for (const route of ADMIN_PATHS) {
    const response = await harness.request({ ...route, token: VALID_LOOKING_TOKEN });
    assert.equal(
      response.status,
      404,
      `${route.method} ${route.path} with a bearer token must be 404, not ${response.status}`,
    );
  }
});

test('an admin path is byte-for-byte the answer an unknown path gives', async () => {
  // Compared against the real 404 rather than against a literal, so a future
  // change to the not-found body cannot make the admin tree distinguishable
  // while both tests still pass.
  const unknown = await harness.request({ method: 'GET', path: '/definitely-not-a-route' });
  const unknownBody = await unknown.text();

  for (const route of ADMIN_PATHS) {
    const response = await harness.request({ ...route, token: VALID_LOOKING_TOKEN });
    const body = await response.text();
    assert.equal(response.status, unknown.status, `${route.path} status`);
    // DELETE answers with no body on a 204 elsewhere; here every case is a 404
    // and must carry the identical body.
    assert.equal(body, unknownBody, `${route.path} body`);
  }
});

test('a well-formed billing token buys nothing either, because BILLING_TOKEN is unset', async () => {
  for (const route of ADMIN_PATHS) {
    const response = await harness.request({ ...route, token: VALID_LOOKING_BILLING_TOKEN });
    assert.equal(
      response.status,
      404,
      `${route.method} ${route.path} with a billing token must be 404, not ${response.status}`,
    );
  }
});

test('with BILLING_TOKEN set, a wrong value is 401 and the 404 above was not vacuous', async () => {
  // THE CONTROL FOR THIS WHOLE FILE'S NEW HALF. Without it, every assertion
  // above would still pass on a service that had lost the ability to
  // authenticate a billing credential at all.
  const configured = await startAdminHarness({ adminToken: null, billingToken: VALID_LOOKING_BILLING_TOKEN });
  try {
    configured.admin.seed({ id: 1, email: 'seeded@example.org' });

    const wrong = await configured.request({
      method: 'GET',
      path: '/v1/admin/accounts/1',
      token: 'billing-0c48e17a9d2b365fe0a7c135',
    });
    assert.equal(wrong.status, 401, 'a configured instance answers 401 to a wrong value, never 404');

    // And the log line carries no part of what was presented.
    const rejections = configured.logLines.filter((line) => line.message === 'Admin request rejected');
    assert.ok(rejections.length > 0, 'a configured instance logs the failure');
    for (const line of rejections) {
      const serialized = JSON.stringify(line);
      assert.ok(!serialized.includes('0c48e17a'), 'no part of the presented value may reach the log');
    }

    const right = await configured.request({
      method: 'GET',
      path: '/v1/admin/accounts/1',
      token: VALID_LOOKING_BILLING_TOKEN,
    });
    assert.equal(right.status, 200, 'and the right value reaches the one route it may');
  } finally {
    await configured.close();
  }
});

test('nothing about the admin surface is logged, because nothing was reached', async () => {
  await harness.request({ method: 'GET', path: '/v1/admin/accounts', token: VALID_LOOKING_TOKEN });

  const rejections = harness.logLines.filter((line) => line.message === 'Admin request rejected');
  assert.deepEqual(rejections, [], 'an unmounted admin API must not log admin auth failures');
});
