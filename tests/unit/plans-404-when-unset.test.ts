/**
 * With `PLANS_UPSTREAM_URL` unset, the plans subtree does not exist, to
 * anybody.
 *
 * WHY THIS IS THE FIRST TEST. This service auto-deploys on push, so the commit
 * that adds this subtree is the commit that puts it in production, on an
 * instance with real accounts on it, and on every self-hoster's instance the
 * next time they pull an image. The only thing that makes that safe is that an
 * unconfigured deployment is INDISTINGUISHABLE from one where the feature was
 * never written. It is the bargain ADR-0001 struck for the admin API and the
 * one the share, research, AI and feedback trees all make.
 *
 * A 401 WOULD BE THE FAILURE, and it is the failure this particular subtree
 * invites: unlike the feedback tree, the configured version of this one mounts
 * its OWN bearer middleware, so a terminator written one line too low would
 * stand behind a gate and answer 401 to an anonymous probe. Every case below
 * therefore includes the anonymous caller, a well-formed token this instance
 * never minted, AND the live token of a real account on it.
 *
 * AND THE DOOR IS PROVEN TO OPEN. The last test boots the same app with an
 * upstream configured and shows the same paths answering something other than
 * 404. Without it this file would pass unchanged if the subtree were deleted,
 * misspelled, or never written: it would be asserting that an unknown path is
 * unknown.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startPlansHarness, type PlansHarness } from './plans-harness.js';

let dark: PlansHarness;

/** Every path the plans family occupies, plus the subtree around it and the bare prefix. */
const PLANS_ROUTES: readonly { method: string; path: string; body?: string }[] = [
  { method: 'GET', path: '/v1/plans' },
  { method: 'GET', path: '/v1/plans/me' },
  { method: 'POST', path: '/v1/plans/checkout', body: '{"plan":"monthly"}' },
  { method: 'POST', path: '/v1/plans/portal', body: '{}' },
  { method: 'PUT', path: '/v1/plans/me', body: '{}' },
  { method: 'DELETE', path: '/v1/plans/me' },
  { method: 'GET', path: '/v1/plans/anything-else' },
];

/** A syntactically perfect credential this instance never minted. It must buy nothing. */
const VALID_LOOKING_TOKEN = 'a'.repeat(48);

before(async () => {
  dark = await startPlansHarness({ configured: false });
});

after(async () => {
  await dark.close();
});

test('every plans path 404s for an anonymous caller, never 401', async () => {
  for (const route of PLANS_ROUTES) {
    const response = await dark.request(route);
    assert.equal(
      response.status,
      404,
      `${route.method} ${route.path} must be 404 without a token, not ${response.status}`,
    );
  }
});

test('a well-formed bearer token buys nothing on the plans tree', async () => {
  for (const route of PLANS_ROUTES) {
    const response = await dark.request({ ...route, token: VALID_LOOKING_TOKEN });
    assert.equal(
      response.status,
      404,
      `${route.method} ${route.path} with a bearer token must be 404, not ${response.status}`,
    );
  }
});

test('a signed-in account on this very instance finds nothing either', async () => {
  // THE STRONGEST CASE, and the one a 401-shaped mistake sails through: this
  // token is live here, so every other authenticated route accepts it.
  for (const route of PLANS_ROUTES) {
    const response = await dark.request({ ...route, token: dark.accessToken });
    assert.equal(
      response.status,
      404,
      `${route.method} ${route.path} for a signed-in caller must be 404, not ${response.status}`,
    );
  }

  const account = await dark.request({ method: 'GET', path: '/v1/auth/account', token: dark.accessToken });
  assert.equal(account.status, 200, 'the same token must work elsewhere, or the 404s above prove nothing');
});

test('a plans path is byte-for-byte the answer an unknown path gives', async () => {
  // Compared against the REAL 404 rather than a literal, so a future change to
  // the not-found body cannot make this tree distinguishable while the test
  // still passes.
  const unknown = await dark.request({ method: 'GET', path: '/definitely-not-a-route' });
  const unknownBody = await unknown.text();

  for (const route of PLANS_ROUTES) {
    const response = await dark.request({ ...route, token: dark.accessToken });
    assert.equal(response.status, unknown.status, `${route.path} status`);
    assert.equal(await response.text(), unknownBody, `${route.path} body`);
  }
});

test('the dark instance reaches no upstream, because there is nothing mounted to reach one', async () => {
  assert.deepEqual(dark.received, [], 'an unmounted subtree must not call anything');
});

test('the same paths stop being 404 once an operator configures a biller', async () => {
  // THE ANTI-VACUITY TEST. Everything above asserts an absence, and an absence
  // is what a missing feature also looks like. With an upstream configured,
  // the same paths must answer the bearer gate or the upstream, never the
  // not-found handler.
  const lit = await startPlansHarness({ configured: true });
  try {
    const anonymous = await lit.request({ method: 'GET', path: '/v1/plans/me' });
    assert.equal(anonymous.status, 401, 'the subtree exists here, so an anonymous caller meets the bearer gate');

    const signedIn = await lit.request({ method: 'GET', path: '/v1/plans/me', token: lit.accessToken });
    assert.equal(signedIn.status, 200, 'a signed-in caller reaches the upstream');
    assert.equal(lit.received.length, 1, 'and the upstream really was called');

    const refusedVerb = await lit.request({ method: 'DELETE', path: '/v1/plans/me', token: lit.accessToken });
    assert.equal(refusedVerb.status, 405, 'a verb this subtree does not forward is a 405 here, not a 404');
  } finally {
    await lit.close();
  }
});
