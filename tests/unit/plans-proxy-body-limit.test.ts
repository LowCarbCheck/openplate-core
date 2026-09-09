/**
 * The request body cap on this subtree, and the property that matters more
 * than the number: it belongs to THIS subtree and to nothing else.
 *
 * THE SECOND HALF IS THE ONE WITH A SCAR. A parser registered on a Router
 * rather than on a route applies to every later route in the app, and the
 * first parser registered wins. A 64 KB limit added for one endpoint once
 * capped every route in this service invisibly, with a green suite. So this
 * file boots two instances, one with a biller configured and one without, and
 * compares an unrelated route's answer to a body far larger than the plans cap.
 * If this router ever registers an unscoped parser, the two answers diverge.
 *
 * A REFUSED BODY IS A 413 AND NOT A 502, because the two mean opposite things
 * to a caller: a 502 says the biller is having a bad day and to try again, and
 * this says what you sent will never be accepted.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startPlansHarness, type PlansHarness } from './plans-harness.js';
import { PLANS_MAX_REQUEST_BYTES, PLANS_REQUEST_TOO_LARGE } from '../../src/server/plans-proxy.js';

/**
 * Comfortably over the plans cap and comfortably under the sync body limit
 * (which is sized for a base64 diary, in megabytes). One size, used against
 * both routes, so the comparison below is about the route and not the size.
 */
const OVERSIZE_BYTES = PLANS_MAX_REQUEST_BYTES * 4;

let lit: PlansHarness;
let dark: PlansHarness;

/** A JSON document of about `bytes` bytes. */
function jsonOfSize(bytes: number): string {
  return JSON.stringify({ padding: 'x'.repeat(bytes) });
}

/** Both instances carry one, so the admin comparison below has a route to compare. */
const ADMIN_TOKEN = 'admin-token-that-is-long-enough-to-be-real';

before(async () => {
  lit = await startPlansHarness({ configured: true, adminToken: ADMIN_TOKEN });
  dark = await startPlansHarness({ configured: false, adminToken: ADMIN_TOKEN });
});

after(async () => {
  await lit.close();
  await dark.close();
});

test('a POST body over the cap is refused before the biller sees any of it', async () => {
  const callsBefore = lit.received.length;

  const response = await lit.request({
    method: 'POST',
    path: '/v1/plans/checkout',
    token: lit.accessToken,
    headers: { 'content-type': 'application/json' },
    body: jsonOfSize(OVERSIZE_BYTES),
  });

  assert.equal(response.status, 413);
  assert.deepEqual(await response.json(), { error: PLANS_REQUEST_TOO_LARGE });
  assert.equal(lit.received.length, callsBefore, 'an oversize body must not be forwarded');
});

test('a POST body under the cap goes through whole, byte for byte', async () => {
  // THE CONTROL. Without it, the test above would pass against a route that
  // refused every body, or against one that did not exist.
  const payload = jsonOfSize(1_000);

  const response = await lit.request({
    method: 'POST',
    path: '/v1/plans/checkout',
    token: lit.accessToken,
    headers: { 'content-type': 'application/json' },
    body: payload,
  });

  assert.equal(response.status, 200);
  assert.equal(lit.received.at(-1)?.body, payload, 'the biller must receive exactly what the client sent');
});

test('an unrelated route accepts a body far larger than the plans cap, with the biller configured', async () => {
  // The sync push route carries a base64 diary and its own limit is measured
  // in megabytes. Whatever it answers to this body, it must not be the plans
  // cap talking.
  const response = await lit.request({
    method: 'POST',
    path: '/v1/sync/blob',
    token: lit.accessToken,
    headers: { 'content-type': 'application/json' },
    body: jsonOfSize(OVERSIZE_BYTES),
  });

  assert.notEqual(response.status, 413, 'the plans cap must not reach the sync tree');
});

test("configuring a biller changes no other route's body limit", async () => {
  // THE COMPARISON, and the reason both instances exist. `dark` has no plans
  // router mounted at all, so its answer is the one this service gave before
  // this feature was written.
  const body = jsonOfSize(OVERSIZE_BYTES);
  const request = {
    method: 'POST',
    path: '/v1/sync/blob',
    headers: { 'content-type': 'application/json' },
    body,
  };

  const withBiller = await lit.request({ ...request, token: lit.accessToken });
  const withoutBiller = await dark.request({ ...request, token: dark.accessToken });

  assert.equal(withBiller.status, withoutBiller.status, 'the same body must get the same status on both instances');
  assert.equal(await withBiller.text(), await withoutBiller.text(), 'and the same body back');
});

test('a route mounted AFTER this router still reads its own body, unchanged', async () => {
  // THE COMPARISON THAT CATCHES THE REAL SHAPE OF THE BUG. Express runs
  // middleware in registration order and the first parser wins, so a parser
  // this router registered on the APP rather than on its own route would be
  // reached first by everything mounted below it. The admin tree is what is
  // mounted below it, and its invite route has a 4 KB parser of its own.
  const body = JSON.stringify({ email: 'boris@example.org' });
  const request = {
    method: 'POST',
    path: '/v1/admin/invites',
    token: ADMIN_TOKEN,
    headers: { 'content-type': 'application/json' },
    body,
  };

  const withBiller = await lit.request(request);
  const withoutBiller = await dark.request(request);

  assert.equal(withBiller.status, withoutBiller.status, 'the admin route must answer the same on both instances');
  assert.notEqual(withBiller.status, 500, 'and it must actually have read its body');
});

test('the cap is small, because what travels here is a plan name and a return URL', async () => {
  // Not a transcription of the literal. The property is that this route is not
  // sized for a photograph the way the AI and feedback routes are.
  assert.ok(PLANS_MAX_REQUEST_BYTES > 0);
  assert.ok(PLANS_MAX_REQUEST_BYTES < 1_000_000, 'nothing on this path is a megabyte');
});
