/**
 * The pulse rows expire on a schedule the SERVICE owns, and a 29 day old row is
 * the control that proves the sweep is deleting by age rather than by
 * everything.
 *
 * MODELLED ON `ai-usage-retention.test.ts`, and for the same reason it exists
 * beside an integration file: `tests/integration/pulse-today.test.ts` can prove
 * an over-age row is genuinely gone from a real Postgres, and it cannot prove
 * that anything ever RUNS. A prune function nobody calls passes every row count
 * assertion ever written. So this file starts the real sweep on a millisecond
 * interval and waits for the deletion to happen with nobody asking.
 *
 * FOUR PREDICATES, ASSERTED APART. Day sums, contributor rows, presence and
 * idempotency keys have three different windows between them, and a sweep that
 * used one cutoff for all four would pass a test that only counted rows.
 *
 * NO TIMER MAY SURVIVE THIS FILE. Every sweep started here is stopped in a
 * `finally`, and `startPulseRetention` unrefs its interval on top of that.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import {
  PULSE_IDEMPOTENCY_TTL_MS,
  PULSE_RETENTION_DAYS,
  pulseIdempotencyCutoff,
  pulseRetentionCutoffDay,
  startPulseRetention,
} from '../../src/pulse/pulse-retention.js';
import { utcDayKey, utcDayKeyDaysBefore } from '../../src/lib/utc-day.js';
import { createFakePulseStore } from './fake-pulse-store.js';
import { createRecordingLogger, type RecordedLine } from './pulse-harness.js';

const NOW = new Date('2026-09-12T12:00:00.000Z');

/** How long a polling assertion waits before it gives up. Generous: a slow machine must not fail a real sweep. */
const WAIT_TIMEOUT_MS = 2_000;

/** How often it looks. Short, so a passing test is quick. */
const WAIT_POLL_MS = 5;

/** Polls until the condition holds, or fails with the caller's sentence. Bounded, never a `while (true)`. */
async function waitFor(input: { until: () => boolean; describe: string }): Promise<void> {
  const deadline = Date.now() + WAIT_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (input.until()) return;
    await delay(WAIT_POLL_MS);
  }
  assert.fail(`timed out after ${WAIT_TIMEOUT_MS}ms waiting for: ${input.describe}`);
}

test('the window is thirty days counting today, and keys go at twenty-four hours', () => {
  assert.equal(PULSE_RETENTION_DAYS, 30);
  assert.equal(PULSE_IDEMPOTENCY_TTL_MS, 24 * 60 * 60 * 1000);
  // `DAYS - 1`, because the window includes today. A cutoff computed with the
  // full 30 would delete the oldest day the feature promises to keep.
  assert.equal(pulseRetentionCutoffDay(NOW), utcDayKeyDaysBefore(NOW, 29));
  assert.equal(pulseIdempotencyCutoff(NOW).getTime(), NOW.getTime() - PULSE_IDEMPOTENCY_TTL_MS);
});

test('the sweep deletes an over-age day and leaves a 29 day old one alone, with nobody asking', async () => {
  const pulse = createFakePulseStore();
  const overAge = utcDayKeyDaysBefore(NOW, PULSE_RETENTION_DAYS + 1);
  const oldestKept = utcDayKeyDaysBefore(NOW, PULSE_RETENTION_DAYS - 1);
  const today = utcDayKey(NOW);

  await pulse.addMeal({ day: overAge, accountId: 1, kcal: 500, protein: 25 });
  await pulse.addPhoto({ day: overAge, accountId: 2 });
  // THE CONTROL ROWS. A sweep that deleted everything passes the assertion
  // about the over-age day and fails these two.
  await pulse.addMeal({ day: oldestKept, accountId: 1, kcal: 600, protein: 30 });
  await pulse.addMeal({ day: today, accountId: 2, kcal: 700, protein: 35 });

  const lines: RecordedLine[] = [];
  // Five milliseconds instead of an hour. Everything else is the production
  // path: the same function the timer calls, called by the same timer.
  const sweep = startPulseRetention({
    pulse,
    logger: createRecordingLogger(lines),
    now: () => NOW,
    intervalMs: 5,
  });

  try {
    // NOTHING IN THIS BLOCK ASKS FOR A DELETION. If the timer is not wired up,
    // this times out.
    await waitFor({
      until: () => pulse.meals.length === 2 && pulse.photos.length === 0,
      describe: 'the over-age day and its contributor rows to be deleted by the schedule',
    });

    assert.deepEqual(
      pulse.meals.map((meal) => meal.day),
      [oldestKept, today],
      'the 29 day old row and today must survive',
    );

    const swept = lines.find((line) => line.message.includes('retention window'));
    assert.ok(swept, 'a sweep that deleted something must say so');
    assert.equal(swept.fields?.retentionDays, PULSE_RETENTION_DAYS);
    assert.equal(swept.fields?.days, 1);
    assert.equal(swept.fields?.contributors, 2, 'two accounts contributed on the over-age day');
    // A COUNT AND A WINDOW, never an account id and never a day.
    assert.equal(swept.fields?.accountId, undefined);
    assert.equal(swept.fields?.day, undefined);
  } finally {
    sweep.stop();
  }
});

test('an expired presence row goes and a live one stays', async () => {
  const pulse = createFakePulseStore();
  // Two rows that differ only in their expiry: one a minute past, one a minute
  // to come.
  await pulse.markFasting({ accountId: 1, expiresAt: new Date(NOW.getTime() - 60_000) });
  await pulse.markFasting({ accountId: 2, expiresAt: new Date(NOW.getTime() + 60_000) });

  const sweep = startPulseRetention({
    pulse,
    logger: createRecordingLogger([]),
    now: () => NOW,
    // An hour, so the timer cannot fire and the run below is the only one.
    intervalMs: 60 * 60 * 1000,
  });

  try {
    const removed = await sweep.runOnce();
    assert.equal(removed.presence, 1);
    assert.deepEqual([...pulse.presence.keys()], [2], 'the unexpired row is the control and must survive');

    // IDEMPOTENT: the predicates are instants and a day, not cursors, so a
    // repeat is a no-op rather than a partial repeat of something.
    assert.deepEqual(await sweep.runOnce(), { days: 0, contributors: 0, presence: 0, idempotencyKeys: 0 });
  } finally {
    sweep.stop();
  }
});

test('an idempotency key older than twenty-four hours goes and a fresh one stays', async () => {
  const pulse = createFakePulseStore();
  await pulse.claim({
    key: 'stale',
    accountId: 1,
    now: new Date(NOW.getTime() - PULSE_IDEMPOTENCY_TTL_MS - 60_000),
  });
  await pulse.claim({ key: 'fresh', accountId: 1, now: new Date(NOW.getTime() - 60_000) });

  const sweep = startPulseRetention({
    pulse,
    logger: createRecordingLogger([]),
    now: () => NOW,
    intervalMs: 60 * 60 * 1000,
  });

  try {
    const removed = await sweep.runOnce();
    assert.equal(removed.idempotencyKeys, 1);

    // The stale key is forgotten, so a write carrying it is accepted again.
    assert.equal(await pulse.claim({ key: 'stale', accountId: 1, now: NOW }), 'claimed');
    // THE CONTROL: the fresh one is still remembered, so a replay is still a
    // no-op. A sweep that deleted both would pass the assertion above alone.
    assert.equal(await pulse.claim({ key: 'fresh', accountId: 1, now: NOW }), 'duplicate');
  } finally {
    sweep.stop();
  }
});

test('a failing sweep is logged and the process survives it', async () => {
  const lines: RecordedLine[] = [];
  const broken = createFakePulseStore();
  const sweep = startPulseRetention({
    // A database that is briefly unreachable must not take the service down:
    // an hour later the same rows are still over age and still get deleted.
    pulse: { ...broken, prune: () => Promise.reject(new Error('connection terminated unexpectedly')) },
    logger: createRecordingLogger(lines),
    now: () => NOW,
    intervalMs: 5,
  });

  try {
    await waitFor({
      until: () => lines.some((line) => line.message === 'Community pulse retention sweep failed'),
      describe: 'the failure to be logged rather than thrown out of the timer',
    });
  } finally {
    sweep.stop();
  }
});

test('a stopped sweep stops deleting, so shutdown really stops it', async () => {
  const pulse = createFakePulseStore();
  await pulse.addMeal({
    day: utcDayKeyDaysBefore(NOW, PULSE_RETENTION_DAYS + 1),
    accountId: 1,
    kcal: 500,
    protein: 25,
  });
  const sweep = startPulseRetention({
    pulse,
    logger: createRecordingLogger([]),
    now: () => NOW,
    intervalMs: 5,
  });
  sweep.stop();

  // Long enough for many ticks to have fired had the timer still been running.
  await delay(60);
  assert.equal(pulse.meals.length, 1, 'a stopped sweep must not delete anything');
});
