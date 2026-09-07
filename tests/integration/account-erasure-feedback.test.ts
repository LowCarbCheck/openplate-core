/**
 * Erasing an account erases that person's reported estimates AND their
 * photographs.
 *
 * WHY THIS FILE EXISTS WHEN THE SCHEMA ALREADY SAYS SO. Both tables cascade
 * from `accounts`, so `DELETE /v1/admin/accounts/:id` should already carry the
 * reports and the images away with it. "Should" is the problem: a cascade is
 * a line in a migration that nothing in this repo exercised until now, and the
 * moment `feedback_images` gains a row that hangs off something else, or the
 * bytes move to an object store with no foreign key to Postgres, a DSAR
 * erasure quietly starts leaving photographs behind. That defect would be
 * invisible: the account is gone, the admin API reports it gone, and the only
 * way to notice is to ask the image store for bytes it should no longer have.
 *
 * So this test asks. It creates an account through the real invite and signup
 * path, posts a real report with a real image through the real route, erases
 * the account through the DSAR endpoint an operator actually uses, and then
 * READS THE STORE BACK for the row and for the bytes.
 *
 * IT IS THE OTHER HALF OF RETENTION. Retention is the promise that a
 * photograph does not stay forever; erasure is the promise that it goes NOW
 * when a person asks. Neither one covers the other.
 */
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { count } from 'drizzle-orm';
import { setupTestDatabase, type TestDatabase } from './db-harness.js';
import { sampleAuthHash, startService, type ServiceHarness } from './service-harness.js';
import { feedbackImages, feedbackReports } from '../../src/db/schema.js';
import { createDrizzleFeedbackImageStore } from '../../src/feedback/feedback-image-store.js';
import { createDrizzleFeedbackAdminStore } from '../../src/feedback/feedback-admin-store.js';
import type { JsonValue } from '../../src/lib/json.js';

const ADMIN_TOKEN = 'integration-admin-token-long-enough';
const IMAGE_BYTES = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46]);

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

before(async () => {
  database = await setupTestDatabase();
  await database.reset();
  service = await startService({ db: database.db, feedback: {}, adminToken: ADMIN_TOKEN });
});

after(async () => {
  await service.close();
  await database.close();
});

beforeEach(async () => {
  await database.reset();
});

async function submitReport(input: { accessToken: string; idempotencyKey: string }): Promise<number> {
  const body: FeedbackRequestBody = {
    idempotencyKey: input.idempotencyKey,
    measurements: { carbohydrateGrams: 12.5 },
    consent: { agreedAt: '2026-09-07T10:00:00.000Z', wordingVersion: 'feedback-consent:v1' },
    image: { contentType: 'image/jpeg', data: IMAGE_BYTES.toString('base64') },
  };
  const response = await service.request<ReportResponse>({
    method: 'POST',
    path: '/v1/feedback',
    accessToken: input.accessToken,
    body,
  });
  assert.equal(response.status, 201, `submitting a report answered ${response.status}`);
  return response.body.reportId;
}

test('erasing an account erases its reports and their photographs', async () => {
  const session = await service.signupThroughInvite({ email: 'leaver@example.org', authHash: sampleAuthHash(74) });
  const reportId = await submitReport({ accessToken: session.tokens.accessToken, idempotencyKey: 'report-1' });

  const images = createDrizzleFeedbackImageStore(database.db);
  const reports = createDrizzleFeedbackAdminStore(database.db);
  // Both present first, or the assertions after the erasure prove nothing at
  // all: an empty store passes them whether or not erasure works.
  assert.notEqual(await reports.get(reportId), null, 'the report has to exist before it can be erased');
  assert.deepEqual((await images.get(reportId))?.bytes, IMAGE_BYTES, 'and so does the photograph');

  // THE DSAR PATH AN OPERATOR ACTUALLY USES, not a store call beside it.
  const erased = await service.request({
    method: 'DELETE',
    path: `/v1/admin/accounts/${session.account.id}`,
    adminToken: ADMIN_TOKEN,
  });
  assert.equal(erased.status, 204);

  // READ THE STORE BACK, for the row and for the bytes separately. The row
  // being gone is not evidence about the bytes: that is exactly the failure
  // this file exists to catch.
  assert.equal(await reports.get(reportId), null, 'the report row is gone');
  assert.equal(await images.get(reportId), null, 'the photograph is gone');

  // And nothing is left anywhere in either table, which is the claim an
  // operator answering a DSAR has to be able to make about the whole account
  // rather than about the one id the test happens to hold.
  const remainingReports = await database.db.select({ total: count() }).from(feedbackReports);
  const remainingImages = await database.db.select({ total: count() }).from(feedbackImages);
  assert.equal(remainingReports[0]?.total, 0, 'no report rows survive the erasure');
  assert.equal(remainingImages[0]?.total, 0, 'no image rows survive it either');
});

test('erasing one account leaves another account reports and photographs alone', async () => {
  const leaving = await service.signupThroughInvite({ email: 'leaver@example.org', authHash: sampleAuthHash(74) });
  const staying = await service.signupThroughInvite({ email: 'stayer@example.org', authHash: sampleAuthHash(75) });
  const leavingReport = await submitReport({ accessToken: leaving.tokens.accessToken, idempotencyKey: 'report-1' });
  const stayingReport = await submitReport({ accessToken: staying.tokens.accessToken, idempotencyKey: 'report-1' });

  const images = createDrizzleFeedbackImageStore(database.db);
  const reports = createDrizzleFeedbackAdminStore(database.db);

  const erased = await service.request({
    method: 'DELETE',
    path: `/v1/admin/accounts/${leaving.account.id}`,
    adminToken: ADMIN_TOKEN,
  });
  assert.equal(erased.status, 204);

  assert.equal(await reports.get(leavingReport), null);
  assert.equal(await images.get(leavingReport), null);
  // THE OTHER HALF OF A CASCADE ASSERTION. A `DELETE FROM feedback_reports`
  // with a wrong or missing predicate would satisfy every line above and empty
  // the table for everybody.
  assert.notEqual(await reports.get(stayingReport), null, 'a second account report is not theirs to erase');
  assert.deepEqual((await images.get(stayingReport))?.bytes, IMAGE_BYTES);
});
