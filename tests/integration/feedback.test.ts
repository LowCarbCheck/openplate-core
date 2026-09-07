/**
 * A reported estimate, round-tripped through a real Postgres.
 *
 * WHAT THIS FILE IS FOR, above the obvious. The idempotency guarantee is the
 * reason the client can queue a report durably and retry it from a supermarket
 * car park, and it is NOT provable by a status code: a handler that stored a
 * second row and answered 200 would pass every assertion about the wire. So the
 * duplicate test counts ROWS, in the database, through the same connection the
 * service wrote them on.
 *
 * IT ALSO PINS WHAT IS NOT STORED. The row's own column set is asserted
 * exactly, so a future field added to the request body cannot quietly become a
 * field on disk. On a service that holds photographs of people's food, a column
 * added here is a column an operator can read, and the ADR is where that
 * decision belongs.
 */
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { eq } from 'drizzle-orm';
import { setupTestDatabase, type TestDatabase } from './db-harness.js';
import { sampleAuthHash, startService, type ServiceHarness } from './service-harness.js';
import { feedbackReports } from '../../src/db/schema.js';
import { createDrizzleFeedbackImageStore } from '../../src/feedback/feedback-image-store.js';
import type { JsonValue } from '../../src/lib/json.js';

/** A one-pixel-ish payload. The service never decodes an image, so the bytes only have to be bytes. */
const IMAGE_BYTES = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46]);

/**
 * The request body as a client writes it. Declared in the test rather than
 * exported from the route: the server decodes a `JsonValue` and owns no such
 * type, so a shared one here would claim a contract the handler does not
 * enforce. Every field is optional so a case can leave one out on purpose.
 */
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

function sampleReport(overrides: Partial<FeedbackRequestBody> = {}): FeedbackRequestBody {
  return {
    idempotencyKey: 'report-abc',
    measurements: { carbohydrateGrams: 12.5, proteinGrams: 30, note: 'this was not 12 g' },
    consent: { agreedAt: '2026-09-07T10:00:00.000Z', wordingVersion: 'feedback-consent:v1' },
    image: { contentType: 'image/jpeg', data: IMAGE_BYTES.toString('base64') },
    ...overrides,
  };
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
  const session = await service.signupThroughInvite({
    email: 'reporter@example.org',
    authHash: sampleAuthHash(71),
  });
  accessToken = session.tokens.accessToken;
});

test('a report with a photograph is stored, and the image comes back through the store', async () => {
  const response = await service.request<ReportResponse>({
    method: 'POST',
    path: '/v1/feedback',
    body: sampleReport(),
    accessToken,
  });
  assert.equal(response.status, 201);
  assert.equal(response.body.hasImage, true);

  const rows = await database.db.select().from(feedbackReports);
  assert.equal(rows.length, 1);
  const row = rows[0];
  assert.ok(row);
  assert.equal(row.idempotencyKey, 'report-abc');
  assert.equal(row.hasImage, true);
  assert.deepEqual(row.measurements, {
    carbohydrateGrams: 12.5,
    proteinGrams: 30,
    note: 'this was not 12 g',
  });
  assert.equal(row.consentWordingVersion, 'feedback-consent:v1');
  assert.equal(row.consentAgreedAt.toISOString(), '2026-09-07T10:00:00.000Z');

  // Read back through the INTERFACE, not through a hand-written SELECT: that
  // is the seam a later object store replaces, and a test that went around it
  // would keep passing after the adapter changed and the bytes stopped
  // arriving.
  const images = createDrizzleFeedbackImageStore(database.db);
  const stored = await images.get(row.id);
  assert.ok(stored);
  assert.equal(stored.contentType, 'image/jpeg');
  assert.deepEqual(stored.bytes, IMAGE_BYTES);
});

test('the stored row holds nothing but the figures, the consent and the flag', async () => {
  await service.request({ method: 'POST', path: '/v1/feedback', body: sampleReport(), accessToken });

  const rows = await database.db.select().from(feedbackReports);
  const row = rows[0];
  assert.ok(row);
  // EXACT, not a subset. A field added to the request body must not become a
  // column here without somebody changing this list and the ADR beside it.
  assert.deepEqual(Object.keys(row).toSorted(), [
    'accountId',
    'consentAgreedAt',
    'consentWordingVersion',
    'createdAt',
    'hasImage',
    'id',
    'idempotencyKey',
    'measurements',
  ]);
});

test('a repeated idempotency key stores ONE row and still answers success', async () => {
  const first = await service.request<ReportResponse>({
    method: 'POST',
    path: '/v1/feedback',
    body: sampleReport(),
    accessToken,
  });
  assert.equal(first.status, 201);

  const retry = await service.request<ReportResponse>({
    method: 'POST',
    path: '/v1/feedback',
    body: sampleReport(),
    accessToken,
  });
  // 200 rather than 201, and a SUCCESS either way: a client draining an outbox
  // must not read the second answer as a failure and retry forever.
  assert.equal(retry.status, 200);
  assert.equal(retry.body.reportId, first.body.reportId);

  // THE ROW COUNT IS THE ASSERTION. A handler that stored twice and answered
  // 200 would satisfy everything above.
  const rows = await database.db.select().from(feedbackReports);
  assert.equal(rows.length, 1, 'a retried report is one report');
});

test('two retries that arrive together still store one row', async () => {
  // The advisory lock and the unique index are both meant to survive this; a
  // read-then-write with no lock is what it fails against.
  const responses = await Promise.all([
    service.request<ReportResponse>({ method: 'POST', path: '/v1/feedback', body: sampleReport(), accessToken }),
    service.request<ReportResponse>({ method: 'POST', path: '/v1/feedback', body: sampleReport(), accessToken }),
    service.request<ReportResponse>({ method: 'POST', path: '/v1/feedback', body: sampleReport(), accessToken }),
  ]);
  for (const response of responses) {
    assert.ok(response.status === 200 || response.status === 201, `unexpected ${response.status}`);
  }
  const rows = await database.db.select().from(feedbackReports);
  assert.equal(rows.length, 1);
});

test('a report whose photograph was already evicted still goes, flagged as having none', async () => {
  const response = await service.request<ReportResponse>({
    method: 'POST',
    path: '/v1/feedback',
    body: sampleReport({ image: null }),
    accessToken,
  });
  assert.equal(response.status, 201);
  assert.equal(response.body.hasImage, false);

  const rows = await database.db.select().from(feedbackReports);
  assert.equal(rows.length, 1);
  assert.equal(rows[0]?.hasImage, false);

  const images = createDrizzleFeedbackImageStore(database.db);
  assert.equal(await images.get(response.body.reportId), null);
});

test('the same key belongs to each account separately', async () => {
  const other = await service.signupThroughInvite({ email: 'second@example.org', authHash: sampleAuthHash(72) });

  await service.request({ method: 'POST', path: '/v1/feedback', body: sampleReport(), accessToken });
  const second = await service.request<ReportResponse>({
    method: 'POST',
    path: '/v1/feedback',
    body: sampleReport(),
    accessToken: other.tokens.accessToken,
  });
  // A globally unique key would have let the first account burn 'report-abc'
  // for everybody else on the instance.
  assert.equal(second.status, 201);

  const rows = await database.db.select().from(feedbackReports);
  assert.equal(rows.length, 2);
});

test('an anonymous caller is refused, and stores nothing', async () => {
  const response = await service.request({ method: 'POST', path: '/v1/feedback', body: sampleReport() });
  assert.equal(response.status, 401);
  const rows = await database.db.select().from(feedbackReports);
  assert.equal(rows.length, 0);
});

test('a malformed body is a 400, and every field is required', async () => {
  const cases: { name: string; body: FeedbackRequestBody }[] = [
    { name: 'no idempotency key', body: sampleReport({ idempotencyKey: undefined }) },
    { name: 'no measurements', body: sampleReport({ measurements: undefined }) },
    { name: 'measurements is not an object', body: sampleReport({ measurements: 'twelve grams' }) },
    { name: 'no consent at all', body: sampleReport({ consent: undefined }) },
    {
      name: 'consent with no wording version',
      body: sampleReport({ consent: { agreedAt: '2026-09-07T10:00:00.000Z' } }),
    },
    {
      name: 'consent with an unparseable instant',
      body: sampleReport({ consent: { agreedAt: 'thursday', wordingVersion: 'feedback-consent:v1' } }),
    },
    {
      name: 'an image type a reviewer would be opening a document in',
      body: sampleReport({ image: { contentType: 'image/svg+xml', data: IMAGE_BYTES.toString('base64') } }),
    },
  ];

  for (const testCase of cases) {
    const response = await service.request({
      method: 'POST',
      path: '/v1/feedback',
      body: testCase.body,
      accessToken,
    });
    assert.equal(response.status, 400, `${testCase.name} must be 400, not ${response.status}`);
  }

  const rows = await database.db.select().from(feedbackReports);
  assert.equal(rows.length, 0, 'a refused report leaves nothing behind');
});

test('erasing the account takes the report and the photograph with it', async () => {
  const stored = await service.request<ReportResponse>({
    method: 'POST',
    path: '/v1/feedback',
    body: sampleReport(),
    accessToken,
  });
  assert.equal(stored.status, 201);

  const rows = await database.db.select().from(feedbackReports).where(eq(feedbackReports.id, stored.body.reportId));
  assert.equal(rows.length, 1);

  // The same cascade `sync_blobs` relies on. Erasure is an obligation, and a
  // photograph that survived it would be the worst row on this service.
  await service.authContext.store.deleteAccount(rows[0]?.accountId ?? 0);

  assert.deepEqual(await database.db.select().from(feedbackReports), []);
  const images = createDrizzleFeedbackImageStore(database.db);
  assert.equal(await images.get(stored.body.reportId), null);
});
