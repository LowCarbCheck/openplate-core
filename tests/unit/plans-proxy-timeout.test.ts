/**
 * A biller that hangs, a biller that is not there, and a biller that answers
 * something this service will not relay. All three are a 502 with a machine
 * code, and the hang is bounded by a timeout this service sets.
 *
 * THE TIMEOUT IS NOT A NICETY. Node's global `fetch` is undici, which applies
 * a 300 second headers timeout that an `AbortSignal` can only TIGHTEN. Without
 * an explicit signal a stuck biller is five minutes of a spinner on a checkout
 * button, and then an error naming no knob. The bound below is asserted as
 * elapsed WALL TIME, because a constant read out of the module under test
 * proves only that the constant exists.
 *
 * THE HANG IS WATCHED IN MILLISECONDS. `PLANS_UPSTREAM_TIMEOUT_MS` is ten
 * seconds, and a suite that waited ten real seconds is a suite nobody runs, so
 * the harness overrides it through the one option `PlansUpstreamConfig` has
 * for the purpose. What is under test is that the configured value is APPLIED,
 * which is the half that can break.
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { startPlansHarness, type PlansHarness } from './plans-harness.js';
import {
  PLANS_UPSTREAM_INVALID,
  PLANS_UPSTREAM_TIMEOUT,
  PLANS_UPSTREAM_TIMEOUT_MS,
  PLANS_UPSTREAM_UNREACHABLE,
} from '../../src/server/plans-proxy.js';

/** Short enough that a hang is watched rather than waited out, long enough that a healthy call finishes inside it. */
const TEST_TIMEOUT_MS = 400;

const harnesses: PlansHarness[] = [];

after(async () => {
  await Promise.all(harnesses.map((harness) => harness.close()));
});

async function startHanging(): Promise<PlansHarness> {
  const harness = await startPlansHarness({ configured: true, timeoutMs: TEST_TIMEOUT_MS });
  harnesses.push(harness);
  return harness;
}

test('a hanging upstream becomes a 502 inside the configured timeout, not a five minute wait', async () => {
  const lit = await startHanging();
  lit.reply.hang = true;

  const startedAt = Date.now();
  const response = await lit.request({ method: 'GET', path: '/v1/plans/me', token: lit.accessToken });
  const elapsed = Date.now() - startedAt;

  assert.equal(response.status, 502);
  assert.deepEqual(await response.json(), { error: PLANS_UPSTREAM_TIMEOUT });
  assert.equal(lit.received.length, 1, 'the request did reach the upstream, which is what made it a hang');
  // A generous ceiling: the assertion is "bounded by the configured value",
  // not "fast". Ten times the bound still catches a signal that was never
  // attached, which is a wait of 300 seconds.
  assert.ok(elapsed < TEST_TIMEOUT_MS * 10, `the wait was ${elapsed}ms, which is not bounded by the timeout`);
});

test('a healthy upstream answers well inside the same bound, so the timeout is not simply always firing', async () => {
  // THE CONTROL for the test above. A proxy that answered 502 unconditionally
  // would pass it.
  const lit = await startHanging();

  const response = await lit.request({ method: 'GET', path: '/v1/plans/me', token: lit.accessToken });

  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { ok: true });
});

test('an upstream nothing listens on is a 502 with its own code', async () => {
  const lit = await startPlansHarness({ configured: true, unreachable: true });
  harnesses.push(lit);

  const response = await lit.request({ method: 'GET', path: '/v1/plans/me', token: lit.accessToken });

  assert.equal(response.status, 502);
  assert.deepEqual(await response.json(), { error: PLANS_UPSTREAM_UNREACHABLE });
  // The fake upstream is running in this harness too, and it heard nothing:
  // the proxy called the configured URL rather than guessing.
  assert.deepEqual(lit.received, []);
});

test('an upstream answering something that is not JSON is a 502, never a relayed document', async () => {
  const lit = await startHanging();
  lit.reply.status = 200;
  lit.reply.contentType = 'text/html';
  lit.reply.body = '<html><body>Bad Gateway</body></html>';

  const response = await lit.request({ method: 'GET', path: '/v1/plans/me', token: lit.accessToken });

  assert.equal(response.status, 502, 'a 200 carrying HTML is not a plan');
  assert.deepEqual(await response.json(), { error: PLANS_UPSTREAM_INVALID });
});

test('an upstream answer over the relay cap is a 502 rather than a body buffered whole', async () => {
  const lit = await startHanging();
  lit.reply.status = 200;
  lit.reply.contentType = 'application/json';
  lit.reply.body = JSON.stringify({ padding: 'x'.repeat(200_000) });

  const response = await lit.request({ method: 'GET', path: '/v1/plans/me', token: lit.accessToken });

  assert.equal(response.status, 502);
  assert.deepEqual(await response.json(), { error: PLANS_UPSTREAM_INVALID });
});

test('an answer just under the relay cap still passes through, so the cap is a cap and not a wall', async () => {
  // THE CONTROL for the test above.
  const lit = await startHanging();
  lit.reply.status = 200;
  lit.reply.contentType = 'application/json';
  const payload = { padding: 'x'.repeat(1_000) };
  lit.reply.body = JSON.stringify(payload);

  const response = await lit.request({ method: 'GET', path: '/v1/plans/me', token: lit.accessToken });

  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), payload);
});

test('the shipped timeout is the short one a person waiting on a button needs', async () => {
  // The tests above run on an override, so this is the one assertion about the
  // value every real instance uses. Not a transcription of the literal: the
  // property that matters is that it is far below undici's hidden 300 s cap.
  assert.ok(PLANS_UPSTREAM_TIMEOUT_MS > 0);
  assert.ok(PLANS_UPSTREAM_TIMEOUT_MS <= 30_000, 'a checkout button cannot wait longer than half a minute');
});
