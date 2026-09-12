/**
 * Two heartbeats from one account leave one row, the row expires 30 minutes
 * after the LAST heartbeat, and `fastingNow` counts only unexpired rows.
 *
 * THE THREE PROPERTIES ARE DIFFERENT ONES and each has its own control:
 *
 *  - The upsert: two heartbeats, one row. A store that appended would give two,
 *    and `fastingNow` would then say two people are fasting when one is.
 *  - The extension: the second heartbeat's expiry replaces the first's rather
 *    than being ignored. A route that wrote the row only when absent passes the
 *    count assertion and fails this one.
 *  - The expiry: a row whose instant has passed is not counted, and the control
 *    is the same row a minute earlier, which IS counted.
 *
 * THE CLOCK IS MOVED, NEVER SLEPT THROUGH, and the second person is here so a
 * count of one cannot be mistaken for a count of "whatever rows exist".
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { PULSE_PRESENCE_TTL_MS } from '../../src/pulse/pulse-retention.js';
import { pulseKey, startPulseHarness, type PulseHarness } from './pulse-harness.js';

const harnesses: PulseHarness[] = [];
after(async () => {
  await Promise.all(harnesses.map((harness) => harness.close()));
});

async function start(): Promise<PulseHarness> {
  // A ONE MILLISECOND CACHE, because this file is about presence and not about
  // the cache. With the production five minutes, a read taken two minutes after
  // an expiry would be served the answer from before it, and the assertion
  // would be measuring `pulse-cache.ts` instead. `pulse-writes.test.ts` owns
  // the window itself.
  const harness = await startPulseHarness({ cacheTtlMs: 1 });
  harnesses.push(harness);
  return harness;
}

/** Reads `fastingNow` the way a client does, through `GET /v1/pulse/today`. */
async function fastingNow(harness: PulseHarness): Promise<number> {
  const response = await harness.get({ person: harness.anna, path: '/v1/pulse/today' });
  assert.equal(response.status, 200);
  // SAFETY: the route under test answers this shape and the assertion below
  // fails if it did not.
  const body = (await response.json()) as { fastingNow: number };
  return body.fastingNow;
}

test('the presence window is thirty minutes', () => {
  assert.equal(PULSE_PRESENCE_TTL_MS, 30 * 60 * 1000);
});

test('two heartbeats from one account leave one row, with the later expiry', async () => {
  const harness = await start();
  const start1 = harness.now();

  assert.equal(
    (await harness.post({ person: harness.anna, path: '/v1/pulse/fasting', key: pulseKey(50) })).status,
    202,
  );
  assert.equal(harness.pulse.presence.size, 1);
  const firstExpiry = harness.pulse.presence.get(harness.anna.accountId);
  assert.ok(firstExpiry !== undefined);
  assert.equal(firstExpiry.getTime(), start1.getTime() + PULSE_PRESENCE_TTL_MS);

  // Past the ten minute limiter, and well inside the thirty minute window.
  harness.advance(11 * 60_000);
  assert.equal(
    (await harness.post({ person: harness.anna, path: '/v1/pulse/fasting', key: pulseKey(51) })).status,
    202,
  );

  assert.equal(harness.pulse.presence.size, 1, 'a second heartbeat must replace the row, never append one');
  const secondExpiry = harness.pulse.presence.get(harness.anna.accountId);
  assert.ok(secondExpiry !== undefined);
  assert.equal(
    secondExpiry.getTime(),
    harness.now().getTime() + PULSE_PRESENCE_TTL_MS,
    'the expiry must move with the LAST heartbeat',
  );
  assert.ok(secondExpiry.getTime() > firstExpiry.getTime());
});

test('an expired row is not counted, and the same row a minute earlier is', async () => {
  const harness = await start();

  await harness.post({ person: harness.anna, path: '/v1/pulse/fasting', key: pulseKey(60) });
  await harness.post({ person: harness.bert, path: '/v1/pulse/fasting', key: pulseKey(61) });
  assert.equal(await fastingNow(harness), 2, 'two people who just sent a heartbeat are two');

  // THE CONTROL: one minute before the expiry, the rows still count. A reader
  // that ignored the instant entirely would pass the assertion below by
  // accident.
  harness.advance(PULSE_PRESENCE_TTL_MS - 60_000);
  assert.equal(await fastingNow(harness), 2);

  // And past it, they do not, with no prune having run: the reader ignores an
  // expired row rather than waiting for the sweep.
  harness.advance(120_000);
  assert.equal(await fastingNow(harness), 0);
  assert.equal(harness.pulse.presence.size, 2, 'the rows are still there; they simply stopped counting');
});

test('one person fasting and one person not is one, not two', async () => {
  const harness = await start();

  await harness.post({ person: harness.anna, path: '/v1/pulse/fasting', key: pulseKey(70) });
  // Bert sends a meal instead, which touches no presence row at all.
  await harness.post({
    person: harness.bert,
    path: '/v1/pulse/meal',
    key: pulseKey(71),
    body: { kcal: 500, protein: 25 },
  });

  assert.equal(await fastingNow(harness), 1);
});
