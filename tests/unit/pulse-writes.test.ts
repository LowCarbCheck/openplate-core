/**
 * The grid a meal lands on, and the five minute cache in front of the read.
 *
 * THE ROUNDING IS ASSERTED AT TWO LEVELS, and both are needed. The pure
 * function is where the arithmetic lives and is cheap to pin exhaustively. The
 * ROUTE is where it is applied, and a handler that forwarded the client's exact
 * figure would pass every assertion about the pure function while putting an
 * exact 1237 into an instance wide sum. `pulse-harness.ts`'s fake records what
 * the route handed down, which is what makes the second level observable.
 *
 * THE CACHE IS ASSERTED WITH AN INJECTED CLOCK, never by sleeping: the window
 * is five minutes. Its control is the read after the window, which must show
 * the write that the read inside it did not.
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import {
  PULSE_KCAL_STEP,
  PULSE_MAX_KCAL,
  PULSE_MAX_PROTEIN,
  PULSE_PROTEIN_STEP,
  isPulseIdempotencyKey,
  roundPulseKcal,
  roundPulseProtein,
} from '../../src/pulse/pulse-deltas.js';
import { PULSE_CACHE_TTL_MS } from '../../src/pulse/pulse-cache.js';
import { pulseKey, startPulseHarness, type PulseHarness } from './pulse-harness.js';

const harnesses: PulseHarness[] = [];
after(async () => {
  await Promise.all(harnesses.map((harness) => harness.close()));
});

async function start(options: { cacheTtlMs?: number } = {}): Promise<PulseHarness> {
  const harness = await startPulseHarness(options);
  harnesses.push(harness);
  return harness;
}

test('the grid is 50 kcal and 5 g, and the caps are 5000 and 500', () => {
  assert.equal(PULSE_KCAL_STEP, 50);
  assert.equal(PULSE_PROTEIN_STEP, 5);
  assert.equal(PULSE_MAX_KCAL, 5000);
  assert.equal(PULSE_MAX_PROTEIN, 500);
});

test('1234 kcal becomes 1250 and 33 g of protein becomes 35', () => {
  assert.equal(roundPulseKcal(1234), 1250);
  assert.equal(roundPulseProtein(33), 35);
  // Both directions, so a function that only ever rounded up would fail.
  assert.equal(roundPulseKcal(1220), 1200);
  assert.equal(roundPulseProtein(32), 30);
  // Already on the grid, unchanged.
  assert.equal(roundPulseKcal(1250), 1250);
  assert.equal(roundPulseProtein(35), 35);
});

test('a figure outside the range is pulled to the edge rather than refused', () => {
  assert.equal(roundPulseKcal(-1), 0);
  assert.equal(roundPulseProtein(-1), 0);
  assert.equal(roundPulseKcal(999_999), PULSE_MAX_KCAL);
  assert.equal(roundPulseProtein(999_999), PULSE_MAX_PROTEIN);
  // A figure small enough to round to nothing does, which is the honest answer
  // for a 12 kcal coffee on a 50 kcal grid.
  assert.equal(roundPulseKcal(12), 0);
});

test('only a uuid is an idempotency key', () => {
  assert.equal(isPulseIdempotencyKey('6f1c3a1e-9d7b-4a2f-8b31-0f4e9a2c7d55'), true);
  assert.equal(isPulseIdempotencyKey(undefined), false);
  assert.equal(isPulseIdempotencyKey('1'), false);
  assert.equal(isPulseIdempotencyKey('6f1c3a1e9d7b4a2f8b310f4e9a2c7d55'), false);
  // A version 1 uuid is refused: the header's job is to be unpredictable per
  // write, and a time-ordered id is guessable by anybody who knows when.
  assert.equal(isPulseIdempotencyKey('6f1c3a1e-9d7b-1a2f-8b31-0f4e9a2c7d55'), false);
});

test('the route rounds what the device sent, whatever the device sent', async () => {
  const harness = await start();

  const response = await harness.post({
    person: harness.anna,
    path: '/v1/pulse/meal',
    key: pulseKey(90),
    body: { kcal: 1234, protein: 33 },
  });
  assert.equal(response.status, 202);

  const [stored] = harness.pulse.meals;
  assert.ok(stored !== undefined);
  // THE POINT OF THIS FILE. An exact 1234 never reaches the store.
  assert.equal(stored.kcal, 1250);
  assert.equal(stored.protein, 35);
});

test('a body that is not two numbers is refused and writes nothing', async () => {
  const harness = await start();

  for (const body of [{}, { kcal: 500 }, { kcal: 'lots', protein: 30 }, { kcal: 500, protein: null }]) {
    const response = await harness.post({
      person: harness.anna,
      path: '/v1/pulse/meal',
      key: pulseKey(91),
      body,
    });
    assert.equal(response.status, 400, `${JSON.stringify(body)} must be refused`);
    assert.deepEqual(await response.json(), { error: 'invalid request body' });
  }
  assert.equal(harness.pulse.meals.length, 0);
});

test('a write inside the five minute window does not change the GET, and the next window does', async () => {
  assert.equal(PULSE_CACHE_TTL_MS, 5 * 60 * 1000);
  const harness = await start({ cacheTtlMs: PULSE_CACHE_TTL_MS });

  async function today(): Promise<{ meals: number; kcal: number }> {
    const response = await harness.get({ person: harness.anna, path: '/v1/pulse/today' });
    assert.equal(response.status, 200);
    // SAFETY: `GET /v1/pulse/today` answers the seven fields of PROTOCOL.md
    // §5.23; this reads the two the cache assertion is about.
    const body = (await response.json()) as { meals: number; kcal: number };
    return { meals: body.meals, kcal: body.kcal };
  }

  // The cold read, which fills the entry with zeroes.
  assert.deepEqual(await today(), { meals: 0, kcal: 0 });

  await harness.post({
    person: harness.anna,
    path: '/v1/pulse/meal',
    key: pulseKey(92),
    body: { kcal: 600, protein: 30 },
  });
  assert.equal(harness.pulse.meals.length, 1, 'the write really happened');

  // Four minutes later the entry is still warm, so the reader sees the answer
  // from before their own meal. Stated in PROTOCOL.md §5.23 rather than hidden.
  harness.advance(4 * 60_000);
  assert.deepEqual(await today(), { meals: 0, kcal: 0 });

  // THE CONTROL. Past the window the entry reloads, and the meal is there. A
  // cache that never expired would fail here, and one that never cached would
  // have failed above.
  harness.advance(2 * 60_000);
  assert.deepEqual(await today(), { meals: 1, kcal: 600 });
});
