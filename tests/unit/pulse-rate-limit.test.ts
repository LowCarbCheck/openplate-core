/**
 * The three pulse write limits hold at their stated intervals, and a second
 * call inside the window is refused with a `Retry-After` a client can act on.
 *
 * THE CONTROL IN EVERY TEST HERE is the call after the window: a limiter that
 * refused everything, or a route that was never mounted, would pass the refusal
 * assertion on its own. Each test therefore moves the clock past the interval
 * and asserts the next write is accepted.
 *
 * THE WINDOWS ARE DIFFERENT NUMBERS on purpose, and the fasting one is ten
 * times the others, so a limiter that quietly used one constant for all three
 * fails here rather than in production as a heartbeat somebody could not send.
 *
 * THE CLOCK IS MOVED, NEVER SLEPT THROUGH. Ten minutes of real waiting is not a
 * test.
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import {
  PULSE_FASTING_INTERVAL_MS,
  PULSE_MEAL_INTERVAL_MS,
  PULSE_PHOTO_INTERVAL_MS,
} from '../../src/pulse/pulse-rate-limit.js';
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

test('the stated intervals are one minute, one minute and ten minutes', () => {
  // Transcribed rather than derived: a test that computed the numbers it checks
  // would pass against any pair of them.
  assert.equal(PULSE_MEAL_INTERVAL_MS, 60_000);
  assert.equal(PULSE_PHOTO_INTERVAL_MS, 60_000);
  assert.equal(PULSE_FASTING_INTERVAL_MS, 600_000);
});

test('a second meal inside the minute is 429 with a Retry-After, and the next minute is accepted', async () => {
  const harness = await start();
  const meal = { kcal: 500, protein: 25 };

  assert.equal(
    (await harness.post({ person: harness.anna, path: '/v1/pulse/meal', key: pulseKey(10), body: meal })).status,
    202,
  );

  harness.advance(30_000);
  const refused = await harness.post({
    person: harness.anna,
    path: '/v1/pulse/meal',
    key: pulseKey(11),
    body: meal,
  });
  assert.equal(refused.status, 429);
  const retryAfter = Number(refused.headers.get('retry-after'));
  assert.ok(retryAfter >= 1 && retryAfter <= 30, `Retry-After must be the seconds left, got ${retryAfter}`);
  // The refusal names no identifier, exactly as the AI limiter's does not.
  // SAFETY: the route under test answers this shape and the assertion below
  // fails if it did not.
  const body = (await refused.json()) as { error: string };
  assert.ok(!body.error.includes(String(harness.anna.accountId)));
  assert.equal(harness.pulse.meals.length, 1, 'a refused write must not reach the store');

  // THE CONTROL. Past the window, the same account writes again.
  harness.advance(31_000);
  assert.equal(
    (await harness.post({ person: harness.anna, path: '/v1/pulse/meal', key: pulseKey(12), body: meal })).status,
    202,
  );
  assert.equal(harness.pulse.meals.length, 2);
});

test('a second photo inside the minute is refused, and the next minute is accepted', async () => {
  const harness = await start();

  assert.equal((await harness.post({ person: harness.anna, path: '/v1/pulse/photo', key: pulseKey(20) })).status, 202);
  assert.equal((await harness.post({ person: harness.anna, path: '/v1/pulse/photo', key: pulseKey(21) })).status, 429);

  harness.advance(PULSE_PHOTO_INTERVAL_MS + 1);
  assert.equal((await harness.post({ person: harness.anna, path: '/v1/pulse/photo', key: pulseKey(22) })).status, 202);
  assert.equal(harness.pulse.photos.length, 2);
});

test('a fasting heartbeat is refused for ten minutes, not for one', async () => {
  const harness = await start();

  assert.equal(
    (await harness.post({ person: harness.anna, path: '/v1/pulse/fasting', key: pulseKey(30) })).status,
    202,
  );

  // A minute later, which is past the OTHER two windows. A limiter that used
  // one constant for all three routes accepts this and fails the assertion.
  harness.advance(61_000);
  const stillRefused = await harness.post({
    person: harness.anna,
    path: '/v1/pulse/fasting',
    key: pulseKey(31),
  });
  assert.equal(stillRefused.status, 429);
  assert.ok(Number(stillRefused.headers.get('retry-after')) > 500, 'most of the ten minutes must still be left');

  harness.advance(PULSE_FASTING_INTERVAL_MS);
  assert.equal(
    (await harness.post({ person: harness.anna, path: '/v1/pulse/fasting', key: pulseKey(32) })).status,
    202,
  );
});

test('the limit is per account, so one busy device cannot refuse another person', async () => {
  const harness = await start();
  const meal = { kcal: 500, protein: 25 };

  assert.equal(
    (await harness.post({ person: harness.anna, path: '/v1/pulse/meal', key: pulseKey(40), body: meal })).status,
    202,
  );
  assert.equal(
    (await harness.post({ person: harness.anna, path: '/v1/pulse/meal', key: pulseKey(41), body: meal })).status,
    429,
  );
  // Bert's bucket is untouched by Anna's. Keying on an IP rather than on the
  // resolved account would fail here, because both requests come from 127.0.0.1.
  assert.equal(
    (await harness.post({ person: harness.bert, path: '/v1/pulse/meal', key: pulseKey(42), body: meal })).status,
    202,
  );
});

test('a refused write gives its idempotency key back, so the retry is not swallowed', async () => {
  const harness = await start();
  const meal = { kcal: 500, protein: 25 };
  const key = pulseKey(50);

  assert.equal(
    (await harness.post({ person: harness.anna, path: '/v1/pulse/meal', key: pulseKey(49), body: meal })).status,
    202,
  );
  // Refused, and the key it carried must not be remembered: a limit postpones a
  // write, it must never swallow one.
  assert.equal((await harness.post({ person: harness.anna, path: '/v1/pulse/meal', key, body: meal })).status, 429);

  harness.advance(61_000);
  const retry = await harness.post({ person: harness.anna, path: '/v1/pulse/meal', key, body: meal });
  // A 200 `{"duplicate": true}` here would be the defect: the meal would be
  // silently dropped because a refusal had claimed its key.
  assert.equal(retry.status, 202);
  assert.equal(harness.pulse.meals.length, 2);
});
