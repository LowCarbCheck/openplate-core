/**
 * With `SYNC_FEEDBACK` off, the reported-estimate route does not exist, to
 * anybody.
 *
 * WHY THIS IS THE FIRST TEST AND NOT A LATER HARDENING PASS. This service
 * auto-deploys on push, so the commit that adds this route is the commit that
 * puts it in production, on an instance with real accounts on it. The only
 * thing that makes shipping it before any operator has opted in safe is that an
 * unconfigured deployment is INDISTINGUISHABLE from one where the feature was
 * never written. That is the same bargain ADR-0001 struck for the admin API,
 * ADR-0002 for shares and ADR-0003 for research contributions, and here the
 * stakes are the highest of the four: the mere existence of this tree would
 * tell a prober that this deployment holds photographs.
 *
 * A 401 WOULD BE THE FAILURE. It announces that a credential exists here and is
 * merely locked, which on a service whose threat model assumes the attacker can
 * reach it is an invitation to come back with a wordlist. So every assertion
 * below includes the ANONYMOUS case and the case of a caller holding a
 * perfectly well-formed bearer token, which is what a "did we forget to mount
 * the gate" bug sails through.
 *
 * THE OPERATOR'S SIDE IS GATED TWICE, AND THIS FILE SEPARATES THE TWO GATES.
 * `/v1/admin/feedback*` is behind the admin credential AND behind
 * `SYNC_FEEDBACK`. A dark instance with no `ADMIN_TOKEN` would 404 those paths
 * for the admin middleware's own reason, which proves nothing about the feature
 * flag, so the admin cases below boot an instance that HAS a break-glass
 * credential and present it. What is being asserted there is that a caller who
 * is unquestionably an administrator still finds nothing, because the operator
 * has not turned the feature on.
 *
 * AND THE DOOR IS PROVEN TO OPEN. The last test boots the same app with the
 * feature ON and shows the same path answering something other than 404.
 * Without it, this file would pass unchanged if the route were deleted,
 * misspelled, or never written at all: it would be asserting that an unknown
 * path is unknown.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startFeedbackHarness, type FeedbackHarness } from './feedback-harness.js';
import type { JsonValue } from '../../src/lib/json.js';

/**
 * The request body as a client writes it. Declared in the test rather than
 * exported from the route: the server decodes a `JsonValue` and owns no such
 * type, so a shared one here would claim a contract the handler does not
 * enforce. Every field is optional so a case can leave one out on purpose.
 */
interface FeedbackRequestBody {
  idempotencyKey?: string;
  measurements?: JsonValue;
  consent?: { agreedAt?: string; wordingVersion?: string };
  image?: { contentType: string; data: string } | null;
}

let dark: FeedbackHarness;

/** Every path the feedback family would occupy if it were mounted, plus the subtree around it. */
const FEEDBACK_ROUTES: readonly { method: string; path: string; body?: FeedbackRequestBody }[] = [
  { method: 'POST', path: '/v1/feedback', body: sampleReport() },
  { method: 'GET', path: '/v1/feedback' },
  { method: 'GET', path: '/v1/feedback/1' },
  { method: 'DELETE', path: '/v1/feedback/1' },
  { method: 'GET', path: '/v1/feedback/1/image' },
  { method: 'GET', path: '/v1/feedback/anything-else' },
];

/**
 * Every operator path the feedback family would occupy if it were mounted, plus
 * the subtree around it.
 */
const ADMIN_FEEDBACK_ROUTES: readonly { method: string; path: string }[] = [
  { method: 'GET', path: '/v1/admin/feedback' },
  { method: 'GET', path: '/v1/admin/feedback?limit=10' },
  { method: 'GET', path: '/v1/admin/feedback/1' },
  { method: 'GET', path: '/v1/admin/feedback/1/image' },
  { method: 'DELETE', path: '/v1/admin/feedback/1' },
  { method: 'GET', path: '/v1/admin/feedback/anything-else' },
];

/** A syntactically perfect credential. It must buy nothing, because there is nothing to buy. */
const VALID_LOOKING_TOKEN = 'a'.repeat(48);

/** The break-glass credential the admin-gated cases present. Long enough to be the real thing. */
const ADMIN_TOKEN = 'admin-token-that-is-long-enough-to-be-real';

function sampleReport(): FeedbackRequestBody {
  return {
    idempotencyKey: 'report-1',
    measurements: { carbohydrateGrams: 12 },
    consent: { agreedAt: '2026-09-07T10:00:00.000Z', wordingVersion: 'feedback-consent:v1' },
  };
}

before(async () => {
  dark = await startFeedbackHarness({ enabled: false });
});

after(async () => {
  await dark.close();
});

test('every feedback path 404s for an anonymous caller, never 401', async () => {
  for (const route of FEEDBACK_ROUTES) {
    const response = await dark.request(route);
    assert.equal(
      response.status,
      404,
      `${route.method} ${route.path} must be 404 without a token, not ${response.status}`,
    );
  }
});

test('a well-formed bearer token buys nothing on the feedback tree', async () => {
  for (const route of FEEDBACK_ROUTES) {
    const response = await dark.request({ ...route, token: VALID_LOOKING_TOKEN });
    assert.equal(
      response.status,
      404,
      `${route.method} ${route.path} with a bearer token must be 404, not ${response.status}`,
    );
  }
});

test('a feedback path is byte-for-byte the answer an unknown path gives', async () => {
  // Compared against the REAL 404 rather than a literal, so a future change to
  // the not-found body cannot make the feedback tree distinguishable while
  // this test still passes.
  const unknown = await dark.request({ method: 'GET', path: '/definitely-not-a-route' });
  const unknownBody = await unknown.text();

  for (const route of FEEDBACK_ROUTES) {
    const response = await dark.request({ ...route, token: VALID_LOOKING_TOKEN });
    assert.equal(response.status, unknown.status, `${route.path} status`);
    assert.equal(await response.text(), unknownBody, `${route.path} body`);
  }
});

test('the dark instance stores nothing, because nothing was reached', async () => {
  await dark.request({ method: 'POST', path: '/v1/feedback', body: sampleReport(), token: VALID_LOOKING_TOKEN });
  assert.deepEqual(dark.reports.submitted, [], 'an unmounted route must not reach the store');
  assert.equal(dark.images.images.size, 0);
});

test('the same paths stop being 404 once the operator turns the feature on', async () => {
  // THE ANTI-VACUITY TEST. Everything above asserts an absence, and an absence
  // is what a missing feature also looks like. With `SYNC_FEEDBACK` on, the one
  // path the route occupies must answer the bearer gate (401 for a token this
  // instance never minted) rather than the not-found handler.
  const lit = await startFeedbackHarness({ enabled: true });
  try {
    const anonymous = await lit.request({ method: 'POST', path: '/v1/feedback', body: sampleReport() });
    assert.equal(anonymous.status, 401, 'the route exists here, so an anonymous caller meets the bearer gate');

    const bogusToken = await lit.request({
      method: 'POST',
      path: '/v1/feedback',
      body: sampleReport(),
      token: VALID_LOOKING_TOKEN,
    });
    assert.equal(bogusToken.status, 401, 'a token this instance never minted is still a 401, never a 404');

    // A path the route does NOT occupy stays an ordinary 404 even here, which
    // is what shows the mount is one route and not a whole subtree of them.
    const neighbour = await lit.request({ method: 'GET', path: '/v1/feedback/1/image', token: VALID_LOOKING_TOKEN });
    assert.equal(neighbour.status, 404, 'spec 06 owns the read side; it does not exist yet');
  } finally {
    await lit.close();
  }
});

test('an administrator with a real credential still finds nothing on a dark instance', async () => {
  // THE POINT OF THE `adminToken` HERE. Without one, `/v1/admin/*` answers 404
  // for the admin middleware's own reason and this test would pass on a service
  // where the feature gate was never written. With one, every 404 below is
  // `SYNC_FEEDBACK` and nothing else: the same credential reaches `/v1/admin/stats`
  // on this very instance, asserted at the end.
  const guarded = await startFeedbackHarness({ enabled: false, adminToken: ADMIN_TOKEN });
  try {
    const unknown = await guarded.request({ method: 'GET', path: '/definitely-not-a-route' });
    const unknownBody = await unknown.text();

    for (const route of ADMIN_FEEDBACK_ROUTES) {
      const response = await guarded.request({ ...route, token: ADMIN_TOKEN });
      assert.equal(response.status, 404, `${route.method} ${route.path} must be 404 for an admin on a dark instance`);
      assert.equal(await response.text(), unknownBody, `${route.path} body must be the ordinary unknown-path body`);
    }

    const stats = await guarded.request({ method: 'GET', path: '/v1/admin/stats', token: ADMIN_TOKEN });
    assert.equal(stats.status, 200, 'the same credential must work elsewhere, or the 404s above prove nothing');
  } finally {
    await guarded.close();
  }
});

test('the operator paths stop being 404 once the operator turns the feature on', async () => {
  // THE ANTI-VACUITY HALF for the admin surface. Everything above asserts an
  // absence, and an absence is what a feature nobody wrote also looks like.
  const lit = await startFeedbackHarness({ enabled: true, adminToken: ADMIN_TOKEN });
  try {
    const listed = await lit.request({ method: 'GET', path: '/v1/admin/feedback', token: ADMIN_TOKEN });
    assert.equal(listed.status, 200, 'the queue exists on an instance that opted in');
    assert.deepEqual(await listed.json(), { reports: [], total: 0, limit: 50, offset: 0 });

    // A report id nobody stored is a 404 here too, but a DIFFERENT one: the
    // feature answers "no such report" where the dark instance answers the
    // ordinary unknown-path body. Compared as bodies, so a status code alone
    // cannot make the two look alike.
    const missing = await lit.request({ method: 'GET', path: '/v1/admin/feedback/1', token: ADMIN_TOKEN });
    assert.equal(missing.status, 404);
    assert.deepEqual(await missing.json(), { error: 'no such report' });

    // And a caller who is not an administrator gets nothing, feature on or not.
    const notAnAdmin = await lit.request({ method: 'GET', path: '/v1/admin/feedback', token: VALID_LOOKING_TOKEN });
    assert.equal(notAnAdmin.status, 401, 'the admin gate stands in front of the feature gate, not beside it');

    const anonymous = await lit.request({ method: 'GET', path: '/v1/admin/feedback/1/image' });
    assert.equal(anonymous.status, 401, 'an anonymous caller never reaches a photograph');
  } finally {
    await lit.close();
  }
});
