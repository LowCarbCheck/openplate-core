/**
 * The AI usage counters expire on a schedule the SERVICE owns, and the ninety
 * days they expire after is the same ninety the operator's activity strip can
 * show.
 *
 * TWO PROPERTIES, AND THEY ARE DIFFERENT ONES. The integration file beside this
 * (`tests/integration/ai-usage-retention.test.ts`) proves an over-age row is
 * genuinely gone from a real Postgres and that a deleted account leaves none
 * behind. It cannot prove that anything ever RUNS: a purge function nobody
 * calls passes every row-count assertion ever written. So this file starts the
 * real sweep on a millisecond interval and waits for the deletion to happen
 * with no test and no operator asking for it.
 *
 * AND IT PINS THE NUMBER TO ONE PLACE. `AI_USAGE_RETENTION_DAYS` decides both
 * what the sweep deletes and how long a strip an operator may ask for. Two
 * copies of that number is a strip that shows zeroes for days whose rows were
 * pruned, which reads as a person who stopped using the app.
 *
 * NO TIMER MAY SURVIVE THIS FILE. Every sweep started here is stopped in a
 * `finally`, and `startAiUsageRetention` unrefs its interval on top of that.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import {
  AI_USAGE_RETENTION_DAYS,
  aiUsageRetentionCutoffDay,
  startAiUsageRetention,
} from '../../src/ai/usage-retention.js';
import { AI_USAGE_RETENTION_DAYS as EXPORTED_FROM_PACKAGE } from '../../src/index.js';
import { activityWindow, clampActivityWindowDays } from '../../src/admin/account-activity.js';
import { utcDayKey, utcDayKeyDaysBefore } from '../../src/lib/utc-day.js';
import type { AiQuotaStore, ReserveResult } from '../../src/ai/quota-store.js';
import type { LogFields, Logger } from '../../src/logger.js';

const NOW = new Date('2026-09-07T12:00:00.000Z');

/** How long a polling assertion waits before it gives up. Generous: a slow machine must not fail a real sweep. */
const WAIT_TIMEOUT_MS = 2_000;

/** How often it looks. Short, so a passing test is quick. */
const WAIT_POLL_MS = 5;

interface RecordedLine {
  message: string;
  fields: LogFields | undefined;
}

function createRecordingLogger(lines: RecordedLine[]): Logger {
  return {
    debug: (message, fields) => lines.push({ message, fields }),
    info: (message, fields) => lines.push({ message, fields }),
    warn: (message, fields) => lines.push({ message, fields }),
    error: (message, fields) => lines.push({ message, fields }),
  };
}

/**
 * An in-memory quota store holding one day key per row, so a deletion is
 * visible as rows that are no longer there rather than as a returned number.
 */
function createFakeQuota(days: string[]): AiQuotaStore {
  return {
    async reserve(): Promise<ReserveResult> {
      return { ok: true, used: 1, limit: 1 };
    },
    async release(): Promise<void> {},
    async countRequestsOn(): Promise<number> {
      return days.length;
    },
    async purgeUsageBefore(input: { day: string }): Promise<number> {
      const survivors = days.filter((day) => day >= input.day);
      const deleted = days.length - survivors.length;
      days.splice(0, days.length, ...survivors);
      return deleted;
    },
  };
}

/** Polls until the condition holds, or fails with the caller's sentence. Bounded, never a `while (true)`. */
async function waitFor(input: { until: () => boolean; describe: string }): Promise<void> {
  const deadline = Date.now() + WAIT_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (input.until()) return;
    await delay(WAIT_POLL_MS);
  }
  assert.fail(`timed out after ${WAIT_TIMEOUT_MS}ms waiting for: ${input.describe}`);
}

test('the retention window and the activity window are one number, read from one place', () => {
  // The value the barrel publishes is the SAME binding the sweep deletes on,
  // not a copy that could fall behind.
  assert.equal(EXPORTED_FROM_PACKAGE, AI_USAGE_RETENTION_DAYS);

  // The oldest day the sweep keeps IS the oldest day a full-length strip
  // starts at. If these two ever disagree, an operator is shown a zero for a
  // day whose row was deleted, and a zero means "did nothing" to the person
  // reading it.
  const fullWindow = activityWindow({ now: NOW, days: AI_USAGE_RETENTION_DAYS });
  assert.equal(aiUsageRetentionCutoffDay(NOW), fullWindow.fromDay);

  // And the window really is ninety days counting today, not eighty-nine and
  // not ninety-one.
  assert.equal(fullWindow.toDay, utcDayKey(NOW));
  assert.equal(fullWindow.fromDay, utcDayKeyDaysBefore(NOW, AI_USAGE_RETENTION_DAYS - 1));
});

test('a caller asking for more than the window is capped at the window, not refused', () => {
  // The cap is the server's, not the caller's: beyond it the sweep has already
  // deleted the rows, so a longer strip could only be zero-fill.
  assert.equal(clampActivityWindowDays(365), AI_USAGE_RETENTION_DAYS);
  assert.equal(clampActivityWindowDays(AI_USAGE_RETENTION_DAYS + 1), AI_USAGE_RETENTION_DAYS);

  // A shorter window is honoured exactly, because a clamp that also raised
  // would be answering a question nobody asked.
  assert.equal(clampActivityWindowDays(7), 7);

  const asked = activityWindow({ now: NOW, days: 10_000 });
  assert.equal(asked.days, AI_USAGE_RETENTION_DAYS);
  assert.equal(asked.fromDay, aiUsageRetentionCutoffDay(NOW));
});

test('the sweep deletes an over-age counter on its own, with nobody asking', async () => {
  const overAge = utcDayKeyDaysBefore(NOW, AI_USAGE_RETENTION_DAYS + 1);
  const oldestKept = aiUsageRetentionCutoffDay(NOW);
  const today = utcDayKey(NOW);
  const days = [overAge, oldestKept, today];

  const lines: RecordedLine[] = [];
  // Five milliseconds instead of an hour. Everything else is the production
  // path: the same function the timer calls, called by the same timer.
  const sweep = startAiUsageRetention({
    quota: createFakeQuota(days),
    logger: createRecordingLogger(lines),
    now: () => NOW,
    intervalMs: 5,
  });

  try {
    // NOTHING IN THIS BLOCK ASKS FOR A DELETION. If the timer is not wired up,
    // this times out.
    await waitFor({ until: () => days.length === 2, describe: 'the over-age counter to be deleted by the schedule' });

    assert.deepEqual(days, [oldestKept, today], 'the days inside the window must survive');

    const swept = lines.find((line) => line.message.includes('retention window'));
    assert.ok(swept, 'a sweep that deleted something must say so');
    assert.equal(swept.fields?.deleted, 1);
    assert.equal(swept.fields?.retentionDays, AI_USAGE_RETENTION_DAYS);
    // The count and the window, never an account id and never a day.
    assert.equal(swept.fields?.accountId, undefined);
  } finally {
    sweep.stop();
  }
});

test('running the sweep twice deletes nothing the second time', async () => {
  const days = [utcDayKeyDaysBefore(NOW, AI_USAGE_RETENTION_DAYS + 5), utcDayKey(NOW)];
  const sweep = startAiUsageRetention({
    quota: createFakeQuota(days),
    logger: createRecordingLogger([]),
    now: () => NOW,
    // An hour, so the timer cannot fire during this test and the two runs below
    // are the only two there are.
    intervalMs: 60 * 60 * 1000,
  });

  try {
    assert.deepEqual(await sweep.runOnce(), { deleted: 1 });
    // IDEMPOTENT: the predicate is a day, not a cursor, so a repeat is a no-op
    // rather than a partial repeat of something.
    assert.deepEqual(await sweep.runOnce(), { deleted: 0 });
    assert.deepEqual(days, [utcDayKey(NOW)]);
  } finally {
    sweep.stop();
  }
});

test('a stopped sweep stops deleting, so shutdown really stops it', async () => {
  const days = [utcDayKeyDaysBefore(NOW, AI_USAGE_RETENTION_DAYS + 1)];
  const sweep = startAiUsageRetention({
    quota: createFakeQuota(days),
    logger: createRecordingLogger([]),
    now: () => NOW,
    intervalMs: 5,
  });
  sweep.stop();

  // Long enough for many ticks to have fired had the timer still been running.
  await delay(60);
  assert.equal(days.length, 1, 'a stopped sweep must not delete anything');
});

test('a failing sweep is logged and the process survives it', async () => {
  const lines: RecordedLine[] = [];
  const broken = createFakeQuota([]);
  const sweep = startAiUsageRetention({
    // A database that is briefly unreachable must not take the service down:
    // an hour later the same rows are still over age and still get deleted.
    quota: { ...broken, purgeUsageBefore: () => Promise.reject(new Error('connection terminated unexpectedly')) },
    logger: createRecordingLogger(lines),
    now: () => NOW,
    intervalMs: 5,
  });

  try {
    await waitFor({
      until: () => lines.some((line) => line.message === 'AI usage retention sweep failed'),
      describe: 'the failure to be logged rather than thrown out of the timer',
    });
  } finally {
    sweep.stop();
  }
});
