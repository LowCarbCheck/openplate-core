/**
 * An over-age report is GONE from a real Postgres, row and photograph, and
 * nobody asked for it.
 *
 * TWO THINGS ARE BEING PROVEN AT ONCE, and they need each other.
 * `tests/unit/feedback-retention-schedule.test.ts` proves the timer runs and
 * that the window is one number; it does it against in-memory fakes, so it
 * cannot see a `DELETE` that matches nothing or a cascade that does not fire.
 * This file runs the SAME `startFeedbackRetention` against the committed schema
 * and then READS THE STORE BACK.
 *
 * READS THE STORE BACK, and that phrase is the whole design of the assertions
 * below. A status column, a returned count or a "deleted: 1" log line are all
 * things a broken implementation can produce while the bytes sit on disk. The
 * only honest question is "is it still there", asked of
 * `FeedbackImageStore.get` and `FeedbackAdminStore.get`, on the same database
 * the service wrote to.
 *
 * THE CLOCK IS THE ROW'S, NOT THE SWEEP'S. A report is aged by writing an old
 * `created_at`, because that is the column the sweep keys on and because moving
 * the sweep's clock forward instead would leave the test unable to say which of
 * the two it had actually exercised.
 */
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { eq } from 'drizzle-orm';
import { setTimeout as delay } from 'node:timers/promises';
import { setupTestDatabase, type TestDatabase } from './db-harness.js';
import { sampleAuthHash, startService, type ServiceHarness } from './service-harness.js';
import { feedbackReports } from '../../src/db/schema.js';
import { createDrizzleFeedbackImageStore } from '../../src/feedback/feedback-image-store.js';
import { createDrizzleFeedbackAdminStore } from '../../src/feedback/feedback-admin-store.js';
import { FEEDBACK_RETENTION_DAYS, startFeedbackRetention } from '../../src/feedback/feedback-retention.js';
import { createSilentLogger } from '../../src/logger.js';
import type { JsonValue } from '../../src/lib/json.js';

const MS_PER_DAY = 24 * 60 * 60 * 1000;
const IMAGE_BYTES = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46]);

/** How long a polling assertion waits before it gives up. Generous: a slow database must not fail a real sweep. */
const WAIT_TIMEOUT_MS = 5_000;

interface FeedbackRequestBody {
  idempotencyKey?: string;
  measurements?: JsonValue;
  consent?: { agreedAt?: string; wordingVersion?: string };
  image?: { contentType: string; data: string } | null;
}

interface ReportResponse {
  reportId: number;
  hasImage: boolean;
  createdAt: string;
}

let database: TestDatabase;
let service: ServiceHarness;
let accessToken: string;

before(async () => {
  database = await setupTestDatabase();
  await database.reset();
  service = await startService({ db: database.db, feedback: {} });
});

after(async () => {
  await service.close();
  await database.close();
});

beforeEach(async () => {
  await database.reset();
  const session = await service.signupThroughInvite({ email: 'reporter@example.org', authHash: sampleAuthHash(73) });
  accessToken = session.tokens.accessToken;
});

async function submitReport(idempotencyKey: string): Promise<number> {
  const body: FeedbackRequestBody = {
    idempotencyKey,
    measurements: { carbohydrateGrams: 12.5 },
    consent: { agreedAt: '2026-09-07T10:00:00.000Z', wordingVersion: 'feedback-consent:v1' },
    image: { contentType: 'image/jpeg', data: IMAGE_BYTES.toString('base64') },
  };
  const response = await service.request<ReportResponse>({
    method: 'POST',
    path: '/v1/feedback',
    accessToken,
    body,
  });
  assert.equal(response.status, 201, `submitting a report answered ${response.status}`);
  return response.body.reportId;
}

/** Rewrites the one column the sweep keys on, so a test can be a month old without waiting a month. */
async function ageReport(input: { reportId: number; days: number }): Promise<void> {
  await database.db
    .update(feedbackReports)
    .set({ createdAt: new Date(Date.now() - input.days * MS_PER_DAY) })
    .where(eq(feedbackReports.id, input.reportId));
}

/** Polls until the condition holds, or fails with the caller's sentence. Bounded, never a `while (true)`. */
async function waitFor(input: { until: () => Promise<boolean>; describe: string }): Promise<void> {
  const deadline = Date.now() + WAIT_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (await input.until()) return;
    await delay(20);
  }
  assert.fail(`timed out after ${WAIT_TIMEOUT_MS}ms waiting for: ${input.describe}`);
}

test('an over-age report is deleted by the schedule, image and row, with nobody asking', async () => {
  const stale = await submitReport('report-stale');
  const recent = await submitReport('report-recent');
  await ageReport({ reportId: stale, days: FEEDBACK_RETENTION_DAYS + 1 });
  await ageReport({ reportId: recent, days: FEEDBACK_RETENTION_DAYS - 1 });

  const images = createDrizzleFeedbackImageStore(database.db);
  const reports = createDrizzleFeedbackAdminStore(database.db);
  // Both have to be here first, or every assertion below passes vacuously.
  assert.notEqual(await images.get(stale), null);
  assert.notEqual(await images.get(recent), null);

  // The production sweep, on a 10 ms interval instead of an hourly one. Nothing
  // in the block below asks for a deletion.
  const sweep = startFeedbackRetention({
    reports,
    images,
    logger: createSilentLogger(),
    now: () => new Date(),
    intervalMs: 10,
  });

  try {
    await waitFor({
      until: async () => (await reports.get(stale)) === null,
      describe: 'the over-age report to be deleted by the schedule',
    });

    // READ BACK. The row is gone AND the bytes are gone, asked for by id rather
    // than inferred from a count or a status.
    assert.equal(await reports.get(stale), null, 'the over-age row is gone');
    assert.equal(await images.get(stale), null, 'and so is its photograph');

    // The report inside the window is untouched, which is what shows the cutoff
    // is a cutoff and not a truncation.
    assert.notEqual(await reports.get(recent), null, 'a report inside the window survives');
    assert.deepEqual((await images.get(recent))?.bytes, IMAGE_BYTES, 'with its photograph intact');
  } finally {
    sweep.stop();
  }
});

test('a report one day inside the window is not touched by a sweep', async () => {
  const reportId = await submitReport('report-fresh');
  await ageReport({ reportId, days: FEEDBACK_RETENTION_DAYS - 1 });

  const images = createDrizzleFeedbackImageStore(database.db);
  const reports = createDrizzleFeedbackAdminStore(database.db);
  const sweep = startFeedbackRetention({
    reports,
    images,
    logger: createSilentLogger(),
    now: () => new Date(),
    intervalMs: 10,
  });

  try {
    // No polling to do here: the assertion is an ABSENCE of change, so the test
    // has to give the timer real chances to fire and then look.
    await delay(120);
    assert.notEqual(await reports.get(reportId), null, 'a report inside the window must survive many ticks');
    assert.notEqual(await images.get(reportId), null);
  } finally {
    sweep.stop();
  }
});
