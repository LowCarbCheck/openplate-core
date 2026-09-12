/**
 * A replayed pulse write does not double count, and a different key does count.
 *
 * THE SECOND HALF IS THE CONTROL, and it is the reason this file has four
 * tests instead of one. A handler that ignored every write, or a store that
 * dropped every delta, would satisfy "the sum did not move on a replay"
 * perfectly. The only assertion that separates a working idempotency key from a
 * broken route is that a NEW key moves the number.
 *
 * WHY THE REPLAY IS NOT A 429. The claim runs ahead of the rate limiter
 * (`server/register-pulse-routes.ts` says why): a queue drained twice after a
 * flight sends the same key seconds after the original, and the protocol
 * promises that a `200 {"duplicate": true}`. Behind the limiter it would be a
 * `429`, so this file asserts the status as well as the sum.
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { pulseKey, startPulseHarness, type PulseHarness } from './pulse-harness.js';

const harnesses: PulseHarness[] = [];
after(async () => {
  await Promise.all(harnesses.map((harness) => harness.close()));
});

async function start(): Promise<PulseHarness> {
  const harness = await startPulseHarness();
  harnesses.push(harness);
  return harness;
}

test('the same idempotency key twice adds one meal, not two', async () => {
  const harness = await start();
  const key = pulseKey(1);

  const first = await harness.post({
    person: harness.anna,
    path: '/v1/pulse/meal',
    key,
    body: { kcal: 600, protein: 30 },
  });
  assert.equal(first.status, 202);

  const replay = await harness.post({
    person: harness.anna,
    path: '/v1/pulse/meal',
    key,
    body: { kcal: 600, protein: 30 },
  });
  assert.equal(replay.status, 200);
  assert.deepEqual(await replay.json(), { duplicate: true });

  assert.equal(harness.pulse.meals.length, 1, 'a replay must not reach the store');
  const totals = await harness.pulse.totals({ day: '1970-01-01', now: harness.now() });
  assert.equal(totals.meals, 0, 'and the day it was filed under is the server clock, not 1970');
});

test('a different key does count, which is what makes the assertion above mean anything', async () => {
  const harness = await start();

  const first = await harness.post({
    person: harness.anna,
    path: '/v1/pulse/meal',
    key: pulseKey(2),
    body: { kcal: 600, protein: 30 },
  });
  assert.equal(first.status, 202);

  // Past the one-per-minute window, so the limiter is not what this test is
  // measuring.
  harness.advance(61_000);

  const second = await harness.post({
    person: harness.anna,
    path: '/v1/pulse/meal',
    key: pulseKey(3),
    body: { kcal: 600, protein: 30 },
  });
  assert.equal(second.status, 202);

  assert.equal(harness.pulse.meals.length, 2);
  assert.deepEqual(
    harness.pulse.meals.map((meal) => meal.kcal),
    [600, 600],
  );
});

test('a write with no idempotency key at all is refused', async () => {
  const harness = await start();
  const response = await harness.post({
    person: harness.anna,
    path: '/v1/pulse/meal',
    key: null,
    body: { kcal: 600, protein: 30 },
  });
  assert.equal(response.status, 400);
  assert.deepEqual(await response.json(), { error: 'idempotency key required' });
  assert.equal(harness.pulse.meals.length, 0);
});

test('a key that is not a uuid is refused, so one client cannot collide with every other', async () => {
  const harness = await start();
  for (const key of ['1', 'retry', '6f1c3a1e9d7b4a2f8b310f4e9a2c7d55']) {
    const response = await harness.post({
      person: harness.anna,
      path: '/v1/pulse/photo',
      key,
    });
    assert.equal(response.status, 400, `"${key}" must not be accepted as an idempotency key`);
  }
  assert.equal(harness.pulse.photos.length, 0);
});

test('the photo and fasting routes carry the same key rule', async () => {
  const harness = await start();
  const key = pulseKey(4);

  assert.equal((await harness.post({ person: harness.anna, path: '/v1/pulse/photo', key })).status, 202);
  const replay = await harness.post({ person: harness.anna, path: '/v1/pulse/photo', key });
  assert.equal(replay.status, 200);
  assert.deepEqual(await replay.json(), { duplicate: true });
  assert.equal(harness.pulse.photos.length, 1);

  const fastingKey = pulseKey(5);
  assert.equal((await harness.post({ person: harness.anna, path: '/v1/pulse/fasting', key: fastingKey })).status, 202);
  const fastingReplay = await harness.post({ person: harness.anna, path: '/v1/pulse/fasting', key: fastingKey });
  assert.equal(fastingReplay.status, 200);
  assert.equal(harness.pulse.presence.size, 1);
});
