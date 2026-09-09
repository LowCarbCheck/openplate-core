/**
 * With an upstream configured, the plans subtree is ORDINARY AUTHENTICATED
 * SURFACE: an anonymous caller gets the same 401 the rest of this service
 * gives, and a signed-in one reaches the biller.
 *
 * WHY THE 401 IS THE ASSERTION AND NOT AN IMPLEMENTATION DETAIL. `/v1/plans`
 * sits OUTSIDE `SYNC_API_PREFIX`, so the bearer middleware `create-app.ts`
 * mounts on the sync prefix never reaches it. Nothing authenticates this
 * subtree by inheritance: if the router forgets its own `requireAuth`, every
 * path here forwards an anonymous stranger to the biller under this service's
 * shared secret, with an account id nobody checked. That defect passes a
 * typecheck, a lint and every other suite in this repo.
 *
 * THE 401 IS COMPARED AGAINST ANOTHER ROUTE'S, byte for byte, rather than
 * against a literal written here. A gate that answered its own bespoke 401
 * would tell a prober that this path is special.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startPlansHarness, type PlansHarness } from './plans-harness.js';

let lit: PlansHarness;

/** A syntactically perfect credential this instance never minted. */
const VALID_LOOKING_TOKEN = 'b'.repeat(48);

before(async () => {
  lit = await startPlansHarness({ configured: true });
});

after(async () => {
  await lit.close();
});

test('an anonymous caller gets the ordinary 401 and the upstream is never called', async () => {
  const callsBefore = lit.received.length;

  for (const path of ['/v1/plans/me', '/v1/plans/checkout']) {
    const response = await lit.request({ method: 'GET', path });
    assert.equal(response.status, 401, `${path} must be 401 without a token`);
    assert.deepEqual(await response.json(), { error: 'authentication required' });
  }

  assert.equal(lit.received.length, callsBefore, 'an unauthenticated request must not reach the biller');
});

test('the 401 is the same one the rest of the authenticated surface gives', async () => {
  // Read off a route that predates this feature, so the plans gate cannot
  // drift into an answer of its own that identifies the path.
  const elsewhere = await lit.request({ method: 'GET', path: '/v1/auth/account' });
  const elsewhereBody = await elsewhere.text();

  const plans = await lit.request({ method: 'GET', path: '/v1/plans/me' });
  assert.equal(plans.status, elsewhere.status);
  assert.equal(await plans.text(), elsewhereBody);
});

test('a token this instance never minted is still a 401, never a 404 and never a forward', async () => {
  const callsBefore = lit.received.length;

  const response = await lit.request({ method: 'GET', path: '/v1/plans/me', token: VALID_LOOKING_TOKEN });
  assert.equal(response.status, 401);
  assert.equal(lit.received.length, callsBefore, 'an unknown token must not reach the biller');
});

test('a signed-in caller reaches the upstream and gets its status and its body back', async () => {
  lit.reply.status = 201;
  lit.reply.body = JSON.stringify({ url: 'https://checkout.example/session-1' });
  const callsBefore = lit.received.length;

  const response = await lit.request({
    method: 'POST',
    path: '/v1/plans/checkout',
    token: lit.accessToken,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ plan: 'monthly' }),
  });

  assert.equal(response.status, 201, "the upstream's status passes through, not a 200 this service chose");
  assert.deepEqual(await response.json(), { url: 'https://checkout.example/session-1' });
  assert.equal(lit.received.length, callsBefore + 1);
  assert.equal(lit.received.at(-1)?.body, JSON.stringify({ plan: 'monthly' }), 'the body passes through unread');
});

test("an upstream refusal is the caller's refusal, with its own status", async () => {
  // A 402 or a 409 from the biller is a real answer about the caller's plan,
  // and turning it into a 502 would hide it behind "the biller is broken".
  lit.reply.status = 402;
  lit.reply.body = JSON.stringify({ error: 'payment-required' });

  const response = await lit.request({ method: 'GET', path: '/v1/plans/me', token: lit.accessToken });

  assert.equal(response.status, 402);
  assert.deepEqual(await response.json(), { error: 'payment-required' });
});

test('the path and the query reach the upstream unchanged', async () => {
  lit.reply.status = 200;
  lit.reply.body = JSON.stringify({ ok: true });

  await lit.request({ method: 'GET', path: '/v1/plans/me?locale=de', token: lit.accessToken });

  // The prefix is this service's; everything after it is appended to the
  // configured base, which ends in `/plans` because that is where spec 03 puts
  // the biller's internal surface. `GET /v1/plans/me` is `GET /plans/me` there.
  assert.equal(lit.received.at(-1)?.url, '/plans/me?locale=de');
});
