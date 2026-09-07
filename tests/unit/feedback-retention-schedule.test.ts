/**
 * The retention promise is kept by the SERVICE, on a schedule, and the number
 * it keeps is the number the consent wording states.
 *
 * TWO PROPERTIES, AND THEY ARE DIFFERENT ONES. The integration test beside this
 * (`tests/integration/feedback-retention.test.ts`) proves an over-age report is
 * genuinely gone from a real Postgres, image included. It cannot prove that
 * anything ever RUNS: a purge function nobody calls passes it every time. So
 * this file starts the real sweep, on a millisecond interval instead of an
 * hourly one, and waits for the deletion to happen with no test and no operator
 * asking for it.
 *
 * AND IT PINS THE NUMBER TO ONE PLACE. `FEEDBACK_RETENTION_DAYS` is what the
 * client's consent dialog tells a person and what the sweep deletes on. Two
 * copies of that number is one wrong sentence shown to somebody who hands over
 * a photograph on the strength of it, so the assertions below check that the
 * milliseconds, the cutoff and the value the package exports are all derived
 * from the same constant rather than written out again.
 *
 * NO TIMER MAY SURVIVE THIS FILE. Every sweep started here is stopped in a
 * `finally`, and `startFeedbackRetention` unrefs its interval on top of that, so
 * a forgotten `stop()` cannot hold the test runner open and hide itself.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import {
  FEEDBACK_RETENTION_DAYS,
  FEEDBACK_RETENTION_MS,
  feedbackRetentionCutoff,
  startFeedbackRetention,
} from '../../src/feedback/feedback-retention.js';
import { FEEDBACK_RETENTION_DAYS as EXPORTED_FROM_PACKAGE } from '../../src/index.js';
import { createFakeFeedbackAdminStore, createFakeFeedbackImageStore } from './feedback-harness.js';
import type { FeedbackReportDetail } from '../../src/feedback/feedback-admin-store.js';
import type { LogFields, Logger } from '../../src/logger.js';

const MS_PER_DAY = 24 * 60 * 60 * 1000;

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

/** Polls until the condition holds, or fails with the caller's sentence. Bounded, never a `while (true)`. */
async function waitFor(input: { until: () => boolean; describe: string }): Promise<void> {
  const deadline = Date.now() + WAIT_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (input.until()) return;
    await delay(WAIT_POLL_MS);
  }
  assert.fail(`timed out after ${WAIT_TIMEOUT_MS}ms waiting for: ${input.describe}`);
}

function sampleReport(input: { id: number; createdAt: Date }): FeedbackReportDetail {
  return {
    id: input.id,
    accountId: 1,
    hasImage: true,
    measurements: { carbohydrateGrams: 12 },
    consentAgreedAt: input.createdAt,
    consentWordingVersion: 'feedback-consent:v1',
    createdAt: input.createdAt,
  };
}

test('the window and the consent wording read the same number from one place', () => {
  // The milliseconds are DERIVED, not a second literal that could be edited to
  // disagree with the days.
  assert.equal(FEEDBACK_RETENTION_MS, FEEDBACK_RETENTION_DAYS * MS_PER_DAY);

  // The cutoff the sweep deletes on is that same number and nothing else, so
  // "thirty days" in a dialog and "deleted after thirty days" in the service
  // cannot drift apart.
  const now = new Date('2026-09-07T12:00:00.000Z');
  assert.deepEqual(feedbackRetentionCutoff(now), new Date(now.getTime() - FEEDBACK_RETENTION_DAYS * MS_PER_DAY));

  // And the value the package publishes for the client's wording is the SAME
  // binding, not a copy in the barrel that could fall behind.
  assert.equal(EXPORTED_FROM_PACKAGE, FEEDBACK_RETENTION_DAYS);
});

test('the sweep deletes an over-age report on its own, with nobody asking', async () => {
  const now = new Date('2026-09-07T12:00:00.000Z');
  const overAge = new Date(now.getTime() - (FEEDBACK_RETENTION_DAYS + 1) * MS_PER_DAY);
  const fresh = new Date(now.getTime() - MS_PER_DAY);

  const rows = [sampleReport({ id: 1, createdAt: overAge }), sampleReport({ id: 2, createdAt: fresh })];
  const reports = createFakeFeedbackAdminStore(rows);
  const images = createFakeFeedbackImageStore();
  images.images.set(1, { contentType: 'image/jpeg', bytes: Buffer.from([1, 2, 3]) });
  images.images.set(2, { contentType: 'image/jpeg', bytes: Buffer.from([4, 5, 6]) });

  const lines: RecordedLine[] = [];
  // Five milliseconds instead of an hour. Everything else is the production
  // path: the same function the timer calls, called by the same timer.
  const sweep = startFeedbackRetention({
    reports,
    images,
    logger: createRecordingLogger(lines),
    now: () => now,
    intervalMs: 5,
  });

  try {
    // NOTHING IN THIS BLOCK ASKS FOR A DELETION. No `runOnce`, no store call.
    // If the timer is not wired up, this times out.
    await waitFor({ until: () => rows.length === 1, describe: 'the over-age report to be deleted by the schedule' });

    assert.deepEqual(
      rows.map((row) => row.id),
      [2],
      'the report inside the window must survive',
    );
    assert.equal(images.images.has(1), false, 'the over-age image must be gone, not merely orphaned');
    assert.equal(images.images.has(2), true, 'the image inside the window must survive');

    const swept = lines.find((line) => line.message.includes('retention window'));
    assert.ok(swept, 'a sweep that deleted something must say so');
    assert.equal(swept.fields?.deleted, 1);
    assert.equal(swept.fields?.retentionDays, FEEDBACK_RETENTION_DAYS);
  } finally {
    sweep.stop();
  }
});

test('a stopped sweep stops deleting, so shutdown really stops it', async () => {
  const now = new Date('2026-09-07T12:00:00.000Z');
  const overAge = new Date(now.getTime() - (FEEDBACK_RETENTION_DAYS + 1) * MS_PER_DAY);
  const rows = [sampleReport({ id: 1, createdAt: overAge })];
  const reports = createFakeFeedbackAdminStore(rows);

  const sweep = startFeedbackRetention({
    reports,
    images: createFakeFeedbackImageStore(),
    logger: createRecordingLogger([]),
    now: () => now,
    intervalMs: 5,
  });
  sweep.stop();

  // Long enough for many ticks to have fired had the timer still been running.
  await delay(60);
  assert.deepEqual(
    rows.map((row) => row.id),
    [1],
    'a stopped sweep must not delete anything',
  );
});

test('a failing sweep is logged and the process survives it', async () => {
  const broken = createFakeFeedbackAdminStore([]);
  const lines: RecordedLine[] = [];
  const sweep = startFeedbackRetention({
    // A database that is briefly unreachable must not take the service down:
    // an hour later the same rows are still over age and still get deleted.
    reports: {
      ...broken,
      listExpiredIds: () => Promise.reject(new Error('connection terminated unexpectedly')),
    },
    images: createFakeFeedbackImageStore(),
    logger: createRecordingLogger(lines),
    now: () => new Date(),
    intervalMs: 5,
  });

  try {
    await waitFor({
      until: () => lines.some((line) => line.message === 'Feedback retention sweep failed'),
      describe: 'the failure to be logged rather than thrown out of the timer',
    });
  } finally {
    sweep.stop();
  }
});
