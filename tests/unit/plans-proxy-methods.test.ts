/**
 * Only `GET` and `POST` are forwarded. Everything else in the subtree is a 405
 * that never reaches the biller.
 *
 * WHY A WHITELIST AND NOT A PASS-EVERYTHING PROXY. This service does not know
 * what the biller's routes are, and it never will: they are another
 * repository's, changing on another release cycle. Forwarding every verb would
 * make this a general-purpose tunnel into a service holding subscription
 * state, so a `DELETE` somebody sends to `/v1/plans/me` would become a
 * `DELETE` against whatever the biller happens to have at that path on the day.
 * Two verbs are what the three routes of spec 03 need, and the third one is a
 * mistake worth refusing loudly.
 *
 * THE ZERO IS THE ASSERTION. A 405 that the biller nonetheless received is the
 * defect this file exists to catch: the refusal must stand in front of the
 * forward rather than beside it.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startPlansHarness, type PlansHarness } from './plans-harness.js';
import { PLANS_METHOD_NOT_ALLOWED } from '../../src/server/plans-proxy.js';

let lit: PlansHarness;

/** Every verb a client can reach this subtree with that is not forwarded. */
const REFUSED_METHODS: readonly string[] = ['PUT', 'DELETE', 'PATCH', 'HEAD'];

before(async () => {
  lit = await startPlansHarness({ configured: true });
});

after(async () => {
  await lit.close();
});

test('PUT, DELETE, PATCH and HEAD are 405 and the upstream records nothing', async () => {
  const callsBefore = lit.received.length;

  for (const method of REFUSED_METHODS) {
    const response = await lit.request({ method, path: '/v1/plans/me', token: lit.accessToken });
    assert.equal(response.status, 405, `${method} must be 405, not ${response.status}`);
  }

  assert.equal(lit.received.length, callsBefore, 'a refused verb must never reach the biller');
});

test('the refusal carries a machine code and names the verbs that do work', async () => {
  const response = await lit.request({ method: 'DELETE', path: '/v1/plans/me', token: lit.accessToken });

  assert.equal(response.status, 405);
  assert.deepEqual(await response.json(), { error: PLANS_METHOD_NOT_ALLOWED });
  assert.equal(response.headers.get('allow'), 'GET, POST');
});

test('a refused verb does not read the body it was sent', async () => {
  // A parser in front of the refusal would read an arbitrary body off the wire
  // before deciding it wanted none of it.
  const callsBefore = lit.received.length;

  const response = await lit.request({
    method: 'PUT',
    path: '/v1/plans/me',
    token: lit.accessToken,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ allowanceExpiresAt: '2099-01-01T00:00:00.000Z' }),
  });

  assert.equal(response.status, 405);
  assert.equal(lit.received.length, callsBefore);
});

test('a refused verb is still 405 on every path in the subtree, not only the known ones', async () => {
  for (const path of ['/v1/plans', '/v1/plans/checkout', '/v1/plans/whatever-the-biller-adds-next']) {
    const response = await lit.request({ method: 'PATCH', path, token: lit.accessToken });
    assert.equal(response.status, 405, `PATCH ${path}`);
  }
});

test('an anonymous refused verb meets the bearer gate first, and learns nothing about the verbs', async () => {
  // ORDER, NOT PEDANTRY. A 405 answered ahead of authentication would tell an
  // anonymous prober which verbs this subtree implements.
  const response = await lit.request({ method: 'DELETE', path: '/v1/plans/me' });
  assert.equal(response.status, 401);
});

test('GET and POST are forwarded, which is what makes the four refusals above meaningful', async () => {
  // THE CONTROL. Without it every assertion in this file would still pass
  // against a subtree that forwarded nothing at all.
  const callsBefore = lit.received.length;

  const read = await lit.request({ method: 'GET', path: '/v1/plans/me', token: lit.accessToken });
  assert.equal(read.status, 200);

  const written = await lit.request({
    method: 'POST',
    path: '/v1/plans/checkout',
    token: lit.accessToken,
    headers: { 'content-type': 'application/json' },
    body: '{}',
  });
  assert.equal(written.status, 200);

  assert.equal(lit.received.length, callsBefore + 2, 'both forwarded verbs must have reached the biller');
  assert.deepEqual(
    lit.received.slice(-2).map((sent) => sent.method),
    ['GET', 'POST'],
  );
});
