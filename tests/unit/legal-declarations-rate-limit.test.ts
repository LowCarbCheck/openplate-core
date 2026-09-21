/**
 * `legal/legal-declarations-rate-limit.ts`, mounted on a real Express app on
 * an ephemeral loopback port rather than driven with a hand-built request and
 * response: casting a plain object to `Request`/`Response` is the thing this
 * repo's anti-slop lint refuses, and a REAL app is also what proves the
 * middleware reads `req.ip` and writes `res` the way Express itself calls it,
 * not the way a double happens to.
 *
 * `tests/integration/legal-declarations.test.ts` proves the same limiter
 * wired into the real route (a 6th same-IP request in a minute is refused).
 * This file is what proves the WINDOW itself, with an injected clock: it
 * slides rather than resets on a fixed boundary, and it is scoped per IP.
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import express from 'express';
import { createLegalDeclarationsRateLimit } from '../../src/legal/legal-declarations-rate-limit.js';

const servers: Server[] = [];
after(async () => {
  await Promise.all(servers.map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
});

interface LimiterHarness {
  baseUrl: string;
  advance(ms: number): void;
  close(): Promise<void>;
}

/**
 * `startService`'s own binding pattern (a closed-over `clock` variable the
 * middleware's `now` reads), scoped to just this one route, so a test can
 * move time without sleeping.
 */
async function startLimiterHarness(perMinute: number): Promise<LimiterHarness> {
  let clockMs = 0;
  const app = express();
  app.get('/probe', createLegalDeclarationsRateLimit({ perMinute, now: () => clockMs }), (_req, res) => {
    res.status(200).json({ ok: true });
  });

  const server = createServer(app);
  servers.push(server);
  server.listen(0);
  await new Promise<void>((resolve) => server.once('listening', resolve));
  // SAFETY: `listen(0)` binds a TCP port; Node returns the string form of an
  // address only for a Unix domain socket, which this never opens.
  const { port } = server.address() as AddressInfo;

  return {
    baseUrl: `http://127.0.0.1:${port}`,
    advance(ms: number) {
      clockMs += ms;
    },
    close: () => new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve()))),
  };
}

test('the 6th request inside a minute is refused with a Retry-After', async () => {
  const harness = await startLimiterHarness(5);

  for (let attempt = 1; attempt <= 5; attempt += 1) {
    const response = await fetch(`${harness.baseUrl}/probe`);
    assert.equal(response.status, 200, `attempt ${attempt} must be accepted`);
    await response.body?.cancel();
  }

  const refused = await fetch(`${harness.baseUrl}/probe`);
  assert.equal(refused.status, 429);
  assert.deepEqual(await refused.json(), { error: 'declaration-rate-limited' });
  const retryAfter = refused.headers.get('retry-after');
  assert.notEqual(retryAfter, null);
  assert.ok(Number(retryAfter) >= 1, 'Retry-After must never invite an immediate retry');
});

test('the window slides rather than resets on a fixed boundary', async () => {
  const harness = await startLimiterHarness(2);

  const first = await fetch(`${harness.baseUrl}/probe`);
  assert.equal(first.status, 200);
  await first.body?.cancel();

  harness.advance(59_000);
  const second = await fetch(`${harness.baseUrl}/probe`);
  assert.equal(second.status, 200);
  await second.body?.cancel();

  // The bucket now holds timestamps at 0ms and 59,000ms. One millisecond
  // before the FIRST ages out of the trailing 60s window, a third request is
  // still refused.
  harness.advance(999);
  const third = await fetch(`${harness.baseUrl}/probe`);
  assert.equal(third.status, 429);
  await third.body?.cancel();

  // Once the first timestamp (0ms) has aged past the trailing window, a slot
  // frees, even though the second (59,000ms) has not.
  harness.advance(2);
  const fourth = await fetch(`${harness.baseUrl}/probe`);
  assert.equal(fourth.status, 200);
  await fourth.body?.cancel();
});

test('a freed slot is SPENT by the next accepted request, not merely observed', async () => {
  const harness = await startLimiterHarness(1);

  const first = await fetch(`${harness.baseUrl}/probe`);
  assert.equal(first.status, 200);
  await first.body?.cancel();

  harness.advance(60_001);
  const second = await fetch(`${harness.baseUrl}/probe`);
  assert.equal(second.status, 200, 'the freed slot is accepted');
  await second.body?.cancel();

  // Immediately after, with the clock unmoved, the bucket is full again.
  const third = await fetch(`${harness.baseUrl}/probe`);
  assert.equal(third.status, 429);
  await third.body?.cancel();
});
