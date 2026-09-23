/**
 * The Turnstile adapter (M253), against a local server standing in for
 * `siteverify`. Nothing here reaches Cloudflare.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createTurnstileVerifier } from '../../src/accounts/captcha.js';

/** What the fake `siteverify` answers next, and every form body it received. */
interface FakeSiteverify {
  answer: { status: number; body: string };
  received: URLSearchParams[];
}

const fake: FakeSiteverify = { answer: { status: 200, body: '{"success":true}' }, received: [] };
let server: Server;
let url: string;

before(async () => {
  server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      fake.received.push(new URLSearchParams(Buffer.concat(chunks).toString('utf8')));
      res.writeHead(fake.answer.status, { 'content-type': 'application/json' });
      res.end(fake.answer.body);
    });
  });
  server.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', resolve));
  // SAFETY: `listen(0, host)` binds a TCP port, so the address is never the
  // string form Node returns for a Unix socket.
  const { port } = server.address() as AddressInfo;
  url = `http://127.0.0.1:${port}/siteverify`;
});

after(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

function verifier(siteverifyUrl = url): ReturnType<typeof createTurnstileVerifier> {
  return createTurnstileVerifier({
    config: { secretKey: 'the-secret', siteKey: 'the-site' },
    siteverifyUrl,
    timeoutMs: 1_000,
  });
}

test('a token Turnstile accepts passes, and the secret and the token are what was sent', async () => {
  fake.answer = { status: 200, body: '{"success":true}' };
  fake.received = [];
  assert.equal(await verifier().verify({ token: 'a-token' }), 'passed');
  assert.equal(fake.received.length, 1);
  assert.equal(fake.received[0]?.get('secret'), 'the-secret');
  assert.equal(fake.received[0]?.get('response'), 'a-token');
  // The client address is deliberately not handed to Cloudflare.
  assert.equal(fake.received[0]?.has('remoteip'), false);
});

test('a token Turnstile refuses fails', async () => {
  // THE CONTROL for the pass above: an adapter that answered `passed` for any
  // 200 would pass that test and fail this one.
  fake.answer = { status: 200, body: '{"success":false,"error-codes":["invalid-input-response"]}' };
  assert.equal(await verifier().verify({ token: 'a-token' }), 'failed');
});

test('a missing token fails without asking anybody', async () => {
  fake.received = [];
  assert.equal(await verifier().verify({ token: null }), 'failed');
  assert.equal(await verifier().verify({ token: '' }), 'failed');
  assert.equal(fake.received.length, 0);
});

test('Turnstile answering badly or not at all is unavailable, not a failed person', async () => {
  fake.answer = { status: 500, body: 'oops' };
  assert.equal(await verifier().verify({ token: 'a-token' }), 'unavailable');
  fake.answer = { status: 200, body: 'not json' };
  assert.equal(await verifier().verify({ token: 'a-token' }), 'unavailable');
  // A port nothing listens on: the connection is refused.
  assert.equal(await verifier('http://127.0.0.1:9/siteverify').verify({ token: 'a-token' }), 'unavailable');
});
