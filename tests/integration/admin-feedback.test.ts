/**
 * The operator's side of a reported estimate, against a real Postgres: the
 * queue, one opened report, the photograph, and deleting one now.
 *
 * WHY THE AUDIT ASSERTION USES THE REAL LOGGER AND READS STDOUT. "Every read of
 * an image is logged" is a REQUIREMENT of this spec, and a requirement checked
 * by a human squinting at a terminal is not checked. A recording fake would
 * prove the handler called `logger.info`, which is most of it, but not that the
 * line that actually leaves the process carries a timestamp: `ts` is added by
 * `createLogger`, not by the call site, and "when" is a third of what an audit
 * line is for. So this file swaps `process.stdout.write` for the duration,
 * forwards every chunk on so the runner's own output is untouched, and parses
 * the service's JSON lines out of what went past.
 *
 * WHAT THE DELETE TEST ASSERTS, AND WHY IT IS NOT THE STATUS CODE. A 204 says
 * the handler returned. The image is read BACK through
 * `FeedbackImageStore.get`, on the same connection the service wrote it on,
 * because "the image is gone" is a fact about bytes on disk and not about a
 * response. `feedback_images` cascades from `feedback_reports` today, so this
 * assertion would also pass if the route deleted only the row, which is exactly
 * why the route does not rely on that: the cascade disappears the day the bytes
 * move to an object store. See `server/admin-feedback-routes.ts`.
 */
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { setupTestDatabase, type TestDatabase } from './db-harness.js';
import { sampleAuthHash, startService, type ServiceHarness } from './service-harness.js';
import { createDrizzleFeedbackImageStore } from '../../src/feedback/feedback-image-store.js';
import { createDrizzleFeedbackAdminStore } from '../../src/feedback/feedback-admin-store.js';
import { createLogger } from '../../src/logger.js';
import type { JsonValue } from '../../src/lib/json.js';

const ADMIN_TOKEN = 'integration-admin-token-long-enough';

/** A one-pixel-ish payload. The service never decodes an image, so the bytes only have to be bytes. */
const IMAGE_BYTES = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46]);

/** The component name the captured logger writes, so the runner's own output cannot be mistaken for a log line. */
const LOG_COMPONENT = 'admin-feedback-audit-test';

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

interface AdminSummary {
  id: number;
  accountId: number;
  hasImage: boolean;
  consentWordingVersion: string;
  createdAt: string;
}

interface AdminListResponse {
  reports: AdminSummary[];
  total: number;
  limit: number;
  offset: number;
}

interface AdminDetailResponse {
  report: AdminSummary & {
    measurements: Record<string, JsonValue>;
    consent: { agreedAt: string; wordingVersion: string };
  };
}

/** One captured log line, in the shape `logger.ts` writes it. Only the fields this file asserts are named. */
interface CapturedLine {
  ts: string;
  level: string;
  component: string;
  message: string;
  reportId?: number;
  credential?: string;
  adminAccountId?: number | null;
}

let database: TestDatabase;
let service: ServiceHarness;
let accessToken: string;
let reporterAccountId: number;
let captured: CapturedLine[] = [];
let restoreStdout: (() => void) | null = null;

function sampleReport(overrides: Partial<FeedbackRequestBody> = {}): FeedbackRequestBody {
  return {
    idempotencyKey: 'report-abc',
    measurements: { carbohydrateGrams: 12.5, proteinGrams: 30, note: 'this was not 12 g' },
    consent: { agreedAt: '2026-09-07T10:00:00.000Z', wordingVersion: 'feedback-consent:v1' },
    image: { contentType: 'image/jpeg', data: IMAGE_BYTES.toString('base64') },
    ...overrides,
  };
}

/** Parses one written chunk into log lines this service produced, and ignores everything else on stdout. */
function collectLines(chunk: string): void {
  for (const line of chunk.split('\n')) {
    if (!line.startsWith('{')) continue;
    // SAFETY: the guard above admits only JSON objects, and the shape is
    // re-established below by checking the one field this file keys on. A line
    // from anywhere else is dropped rather than asserted against.
    const parsed = JSON.parse(line) as CapturedLine;
    if (parsed.component === LOG_COMPONENT) captured.push(parsed);
  }
}

before(async () => {
  database = await setupTestDatabase();
  await database.reset();

  const originalWrite = process.stdout.write.bind(process.stdout);
  // Forwards everything, so the test runner's own TAP output is unaffected and
  // a failure here still reads normally.
  process.stdout.write = (chunk: string | Uint8Array, ...rest: unknown[]): boolean => {
    // SAFETY: `Buffer.from` accepts both of Node's chunk shapes, a string
    // (encoded utf8) and a byte array (copied), so the assertion only picks one
    // arm of an overload set and never claims a shape the value does not have.
    collectLines(Buffer.from(chunk as Uint8Array).toString('utf8'));
    // SAFETY: `rest` is the (encoding, callback) tail of Node's own overloads,
    // passed straight back to the function it came from.
    return (originalWrite as (chunk: string | Uint8Array, ...args: unknown[]) => boolean)(chunk, ...rest);
  };
  restoreStdout = () => {
    process.stdout.write = originalWrite;
  };

  service = await startService({
    db: database.db,
    feedback: {},
    adminToken: ADMIN_TOKEN,
    logger: createLogger({ component: LOG_COMPONENT, level: 'info' }),
  });
});

after(async () => {
  await service.close();
  await database.close();
  restoreStdout?.();
});

beforeEach(async () => {
  await database.reset();
  captured = [];
  const session = await service.signupThroughInvite({ email: 'reporter@example.org', authHash: sampleAuthHash(71) });
  accessToken = session.tokens.accessToken;
  reporterAccountId = session.account.id;
});

/** Posts one report as the signed-in reporter and answers its id. The production path, over the wire. */
async function submitReport(overrides: Partial<FeedbackRequestBody> = {}): Promise<number> {
  const response = await service.request<ReportResponse>({
    method: 'POST',
    path: '/v1/feedback',
    accessToken,
    body: sampleReport(overrides),
  });
  assert.equal(response.status, 201, `submitting a report answered ${response.status}`);
  return response.body.reportId;
}

test('the queue lists reports newest first, and carries no image bytes', async () => {
  const first = await submitReport({ idempotencyKey: 'report-1' });
  const second = await submitReport({ idempotencyKey: 'report-2' });

  const listed = await service.request<AdminListResponse>({
    method: 'GET',
    path: '/v1/admin/feedback',
    adminToken: ADMIN_TOKEN,
  });

  assert.equal(listed.status, 200);
  assert.equal(listed.body.total, 2);
  assert.deepEqual(
    listed.body.reports.map((report) => report.id),
    [second, first],
    'newest first, so the operator sees what just arrived',
  );

  // The whole serialized page, against the image that IS stored: a base64 or
  // byte-array field added to the list later fails here rather than becoming a
  // page that downloads every photograph on the instance.
  const serialized = JSON.stringify(listed.body);
  assert.equal(serialized.includes(IMAGE_BYTES.toString('base64')), false, 'no image bytes in a list');
  assert.equal(serialized.includes('measurements'), false, 'no figures in a list either');
  assert.deepEqual(listed.body.reports[0], {
    id: second,
    accountId: reporterAccountId,
    hasImage: true,
    consentWordingVersion: 'feedback-consent:v1',
    createdAt: listed.body.reports[0]?.createdAt ?? '',
  });
});

test('an opened report carries the figures and the consent record beside them', async () => {
  const reportId = await submitReport();

  const opened = await service.request<AdminDetailResponse>({
    method: 'GET',
    path: `/v1/admin/feedback/${reportId}`,
    adminToken: ADMIN_TOKEN,
  });

  assert.equal(opened.status, 200);
  assert.deepEqual(opened.body.report.measurements, {
    carbohydrateGrams: 12.5,
    proteinGrams: 30,
    note: 'this was not 12 g',
  });
  assert.deepEqual(opened.body.report.consent, {
    agreedAt: '2026-09-07T10:00:00.000Z',
    wordingVersion: 'feedback-consent:v1',
  });
  assert.equal(opened.body.report.hasImage, true);
});

test('reading the image writes an audit line: who, which report, and when', async () => {
  const reportId = await submitReport();

  const response = await fetch(`${service.baseUrl}/v1/admin/feedback/${reportId}/image`, {
    headers: { authorization: `Bearer ${ADMIN_TOKEN}` },
  });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('content-type'), 'image/jpeg');
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.deepEqual(Buffer.from(await response.arrayBuffer()), IMAGE_BYTES, 'the bytes that went in come back');

  const audit = captured.filter((line) => line.message === 'Feedback image read by admin');
  assert.equal(audit.length, 1, 'exactly one line per read of a photograph');
  const line = audit[0];
  assert.ok(line);
  // WHICH REPORT.
  assert.equal(line.reportId, reportId);
  // WHO. The break-glass token is not an account, so it is named as itself
  // rather than left blank.
  assert.equal(line.credential, 'static-token');
  assert.equal(line.adminAccountId, null);
  // WHEN. Written by the logger, not by the call site, which is why this test
  // reads the line that actually left the process.
  assert.ok(!Number.isNaN(new Date(line.ts).getTime()), `the audit line must carry a usable timestamp: ${line.ts}`);
});

test('an image read by an admin ACCOUNT names that account in the audit line', async () => {
  const reportId = await submitReport();
  const operator = await service.signupThroughInvite({
    email: 'operator@example.org',
    role: 'admin',
    authHash: sampleAuthHash(72),
  });

  const response = await fetch(`${service.baseUrl}/v1/admin/feedback/${reportId}/image`, {
    headers: { authorization: `Bearer ${operator.tokens.accessToken}` },
  });
  assert.equal(response.status, 200);

  const line = captured.find((entry) => entry.message === 'Feedback image read by admin');
  assert.ok(line, 'a read through an admin session is still a read');
  assert.equal(line.credential, 'account');
  assert.equal(line.adminAccountId, operator.account.id, 'the person who opened it, by account id');
});

test('a member and an anonymous caller are refused the photograph', async () => {
  const reportId = await submitReport();

  // The reporter's OWN session. A valid credential on this service, and not one
  // for this tree: the image route is the operator's, and a member reaching it
  // would be a member reaching everybody else's photographs.
  const asMember = await fetch(`${service.baseUrl}/v1/admin/feedback/${reportId}/image`, {
    headers: { authorization: `Bearer ${accessToken}` },
  });
  assert.equal(asMember.status, 401);

  const anonymous = await fetch(`${service.baseUrl}/v1/admin/feedback/${reportId}/image`);
  assert.equal(anonymous.status, 401);

  assert.deepEqual(
    captured.filter((line) => line.message === 'Feedback image read by admin'),
    [],
    'a refused request is not a read, and must not write an audit line saying it was',
  );
});

test('deleting one report deletes its row, and the image is gone from the store', async () => {
  const reportId = await submitReport();
  const images = createDrizzleFeedbackImageStore(database.db);
  const reports = createDrizzleFeedbackAdminStore(database.db);
  assert.notEqual(await images.get(reportId), null, 'the image has to be there first, or this proves nothing');

  const deleted = await service.request({
    method: 'DELETE',
    path: `/v1/admin/feedback/${reportId}`,
    adminToken: ADMIN_TOKEN,
  });
  assert.equal(deleted.status, 204);

  // READ THE STORE BACK. Not a status code, not a flag on the row: the bytes
  // and the row are asked for again, on the same database the service wrote to.
  assert.equal(await images.get(reportId), null, 'the image is gone');
  assert.equal(await reports.get(reportId), null, 'and so is the row');

  // Deleting it twice is a 404, not a second 204: an operator who clicked twice
  // must not be told they erased something that was already gone.
  const again = await service.request({
    method: 'DELETE',
    path: `/v1/admin/feedback/${reportId}`,
    adminToken: ADMIN_TOKEN,
  });
  assert.equal(again.status, 404);
});
