/**
 * What leaves this process on its way to the biller, recorded by a real
 * upstream off a real socket.
 *
 * THE HEADERS ARE THE FEATURE. A checkout is bound to an account by
 * `X-Account-Id`, and the whole milestone rests on that value being one the
 * browser cannot choose: an `accountId` a client can write is an
 * authorization bug wearing a header's clothes, and a biller that then read
 * that account's address to prefill a form would be an address-disclosure
 * oracle. So the forged cases below are not hardening, they are the
 * requirement.
 *
 * THE CALLER'S OWN ACCESS TOKEN MUST NOT BE THERE. Forwarding it would make
 * the biller a second place a stolen token works, on a service that is not
 * this one, deployed by other people, with its own logs.
 *
 * A REAL SERVER RATHER THAN AN INJECTED `fetch`, because a fake function
 * records what the proxy MEANT to send. The assertions below are about what
 * arrived.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { request as httpRequest } from 'node:http';
import { startPlansHarness, type PlansHarness } from './plans-harness.js';

/** Named here so the test asserts the exact value the operator configured, not merely a non-empty one. */
const SHARED_SECRET = 'the-shared-secret-openplate-billing-checks';

let lit: PlansHarness;

/** Puts a literal path on the socket, without the normalization every URL parser applies. */
async function requestRawPath(path: string): Promise<number> {
  const url = new URL(lit.baseUrl);
  return new Promise<number>((resolve, reject) => {
    const call = httpRequest(
      {
        host: url.hostname,
        port: url.port,
        method: 'GET',
        path,
        headers: { authorization: `Bearer ${lit.accessToken}` },
      },
      (response) => {
        response.resume();
        response.on('end', () => resolve(response.statusCode ?? 0));
      },
    );
    call.on('error', reject);
    call.end();
  });
}

before(async () => {
  lit = await startPlansHarness({ configured: true, secret: SHARED_SECRET });
});

after(async () => {
  await lit.close();
});

test('the three trusted headers carry the session, the account row and the secret', async () => {
  await lit.request({ method: 'GET', path: '/v1/plans/me', token: lit.accessToken });

  const sent = lit.received.at(-1);
  assert.ok(sent !== undefined, 'the upstream must have been called');
  assert.equal(sent.headers['x-account-id'], String(lit.account.id));
  assert.equal(sent.headers['x-account-email'], lit.account.email);
  assert.equal(sent.headers['x-plans-secret'], SHARED_SECRET);
});

test("the account id is the session's, and the address is the row's", async () => {
  // The CONTROL for the test above, which would pass against a proxy that
  // echoed whatever the client sent. Here the client sends a different id and
  // a different address, and both must be ignored rather than merged.
  await lit.request({
    method: 'GET',
    path: '/v1/plans/me',
    token: lit.accessToken,
    headers: {
      'x-account-id': '999999',
      'x-account-email': 'attacker@example.net',
    },
  });

  const sent = lit.received.at(-1);
  assert.ok(sent !== undefined);
  assert.equal(sent.headers['x-account-id'], String(lit.account.id), 'a forged id must not reach the biller');
  assert.notEqual(sent.headers['x-account-id'], '999999');
  assert.equal(sent.headers['x-account-email'], lit.account.email, 'a forged address must not reach the biller');
  assert.notEqual(sent.headers['x-account-email'], 'attacker@example.net');
});

test('a client cannot substitute its own shared secret', async () => {
  await lit.request({
    method: 'GET',
    path: '/v1/plans/me',
    token: lit.accessToken,
    headers: { 'x-plans-secret': 'a-secret-the-client-chose' },
  });

  assert.equal(lit.received.at(-1)?.headers['x-plans-secret'], SHARED_SECRET);
});

test("the caller's access token is not forwarded, in any header", async () => {
  await lit.request({ method: 'GET', path: '/v1/plans/me', token: lit.accessToken });

  const sent = lit.received.at(-1);
  assert.ok(sent !== undefined);
  assert.equal(sent.headers.authorization, undefined, 'the bearer token must not reach the biller');
  // Belt and braces: the token must not appear under ANY name, which is what
  // a copy-then-overwrite of the inbound headers would do.
  const values = Object.values(sent.headers).filter((value): value is string => value !== undefined);
  assert.ok(
    values.every((value) => !value.includes(lit.accessToken)),
    'no forwarded header may contain the access token',
  );
});

test('no header the client invented is copied through', async () => {
  await lit.request({
    method: 'GET',
    path: '/v1/plans/me',
    token: lit.accessToken,
    headers: { 'x-debug-marker': 'client-chose-this', cookie: 'session=stolen' },
  });

  const sent = lit.received.at(-1);
  assert.ok(sent !== undefined);
  assert.equal(sent.headers['x-debug-marker'], undefined);
  assert.equal(sent.headers.cookie, undefined);
});

test('Content-Type is the one inbound header that travels, and the body with it', async () => {
  await lit.request({
    method: 'POST',
    path: '/v1/plans/checkout',
    token: lit.accessToken,
    headers: { 'content-type': 'application/json; charset=utf-8' },
    body: JSON.stringify({ plan: 'annual' }),
  });

  const sent = lit.received.at(-1);
  assert.ok(sent !== undefined);
  assert.equal(sent.headers['content-type'], 'application/json; charset=utf-8');
  assert.equal(sent.body, JSON.stringify({ plan: 'annual' }));
});

test('only Content-Type comes back, and none is invented when the upstream sent none', async () => {
  lit.reply.contentType = 'application/json; charset=utf-8';
  const typed = await lit.request({ method: 'GET', path: '/v1/plans/me', token: lit.accessToken });
  assert.equal(typed.headers.get('content-type'), 'application/json; charset=utf-8');

  // An upstream that sends no content type must not have one written for it:
  // this service would be making a claim about somebody else's document.
  lit.reply.contentType = null;
  const untyped = await lit.request({ method: 'GET', path: '/v1/plans/me', token: lit.accessToken });
  assert.equal(untyped.headers.get('content-type'), null);
});

test('a path that tries to climb out of the configured base is the ordinary 404', async () => {
  const callsBefore = lit.received.length;

  // SENT WITH `node:http` AND NOT `fetch`, deliberately. Express does not
  // normalize `..` out of a URL, but every URL parser does, `fetch` included:
  // a request written with one would collapse the segments in the client and
  // never test the guard. This puts the literal bytes on the socket, which is
  // what a hostile caller does.
  const status = await requestRawPath('/v1/plans/../../v1/admin/accounts');

  assert.equal(status, 404, 'a path outside the configured base is the ordinary unknown path');
  assert.equal(lit.received.length, callsBefore, 'nothing may be forwarded for a path outside the base');
});

test('the same raw-path request DOES reach the upstream when it stays inside the base', async () => {
  // The CONTROL for the test above: without it, a 404 could mean the raw
  // request never arrived at all rather than that the guard refused it.
  const callsBefore = lit.received.length;

  const status = await requestRawPath('/v1/plans/me');

  assert.equal(status, 200);
  assert.equal(lit.received.length, callsBefore + 1);
});
