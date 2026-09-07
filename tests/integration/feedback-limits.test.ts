/**
 * The two bounds that stop a compromised client draining the operator's disk
 * and bandwidth: a maximum payload size and a per-account daily limit.
 *
 * BOTH ARE PROVEN BY COUNTING ROWS, not only by reading a status code. A
 * handler that answered 429 and stored the row anyway would satisfy every
 * assertion about the wire while being exactly the failure the limit exists to
 * prevent.
 *
 * THE SIZE BOUND HAS TWO STAGES, and this file exercises both because they are
 * enforced in different places and only one of them is an operator knob:
 *
 *  1. `express.json({ limit })` refuses an absurd body before the handler runs,
 *     and its 413 comes out of `server/error-middleware.ts`.
 *  2. The handler refuses a decoded image over `MAX_FEEDBACK_IMAGE_BYTES`,
 *     because base64 inflates by 4/3 and the body limit therefore sits ABOVE
 *     the image cap. A body limit set AT the image cap would reject a legal
 *     maximum-size report before any handler saw it, which is the regression
 *     `Config.aiMaxRequestBytes` records for the AI route.
 *
 * Both must be a 413 with the same body, or a client cannot tell an operator
 * "your photo is too large" without knowing which layer answered.
 */
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { setupTestDatabase, type TestDatabase } from './db-harness.js';
import { sampleAuthHash, startService, type ServiceHarness } from './service-harness.js';
import { feedbackReports } from '../../src/db/schema.js';
import { MAX_FEEDBACK_IMAGE_BYTES } from '../../src/feedback/register-feedback-route.js';
import type { JsonValue } from '../../src/lib/json.js';

/** Small enough that the suite is quick, large enough that a real body exceeds it. */
const SMALL_BODY_LIMIT_BYTES = 64 * 1024;

/** Two reports a day: enough to assert the third is refused without writing a loop. */
const DAILY_LIMIT = 2;

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
}

function report(key: string, imageBytes?: Buffer): FeedbackRequestBody {
  return {
    idempotencyKey: key,
    measurements: { carbohydrateGrams: 12 },
    consent: { agreedAt: '2026-09-07T10:00:00.000Z', wordingVersion: 'feedback-consent:v1' },
    image: imageBytes === undefined ? null : { contentType: 'image/jpeg', data: imageBytes.toString('base64') },
  };
}

let database: TestDatabase;
/** The bounded instance: a small body limit and two reports a day. */
let service: ServiceHarness;
let accessToken: string;

before(async () => {
  database = await setupTestDatabase();
  await database.reset();
  service = await startService({
    db: database.db,
    feedback: { dailyLimit: DAILY_LIMIT, maxRequestBytes: SMALL_BODY_LIMIT_BYTES },
  });
});

after(async () => {
  await service.close();
  await database.close();
});

beforeEach(async () => {
  await database.reset();
  const session = await service.signupThroughInvite({
    email: 'bounded@example.org',
    authHash: sampleAuthHash(73),
  });
  accessToken = session.tokens.accessToken;
});

test('a body over the configured limit is a 413 and stores nothing', async () => {
  const oversize = Buffer.alloc(SMALL_BODY_LIMIT_BYTES, 0x41);
  const response = await service.request<{ error: string }>({
    method: 'POST',
    path: '/v1/feedback',
    body: report('too-big', oversize),
    accessToken,
  });
  assert.equal(response.status, 413);
  assert.equal(response.body.error, 'request body exceeds the maximum accepted size');

  const rows = await database.db.select().from(feedbackReports);
  assert.equal(rows.length, 0);
});

test('the third report of a UTC day is refused, and the refusal writes nothing', async () => {
  for (let index = 0; index < DAILY_LIMIT; index += 1) {
    const accepted = await service.request<ReportResponse>({
      method: 'POST',
      path: '/v1/feedback',
      body: report(`within-${index}`),
      accessToken,
    });
    assert.equal(accepted.status, 201, `report ${index} must be accepted`);
  }

  const refused = await service.request<{ error: string }>({
    method: 'POST',
    path: '/v1/feedback',
    body: report('over-the-line'),
    accessToken,
  });
  assert.equal(refused.status, 429);
  // Names the limit and no identifier: an account id in a response body echoes
  // a value back to whoever holds the token.
  assert.match(refused.body.error, /daily limit reached/);
  assert.doesNotMatch(refused.body.error, /\baccount [0-9]+\b/);

  const rows = await database.db.select().from(feedbackReports);
  assert.equal(rows.length, DAILY_LIMIT, 'the refused report must not be on disk');
});

test('a retry of an already-stored report is not refused by the daily limit', async () => {
  for (let index = 0; index < DAILY_LIMIT; index += 1) {
    await service.request({ method: 'POST', path: '/v1/feedback', body: report(`within-${index}`), accessToken });
  }
  // THE ORDER INSIDE THE STORE IS THE POINT. The idempotency lookup happens
  // BEFORE the count, so a client draining an outbox at its limit gets its
  // report acknowledged rather than a 429 it would retry forever.
  const retry = await service.request<ReportResponse>({
    method: 'POST',
    path: '/v1/feedback',
    body: report('within-0'),
    accessToken,
  });
  assert.equal(retry.status, 200);

  const rows = await database.db.select().from(feedbackReports);
  assert.equal(rows.length, DAILY_LIMIT);
});

test('the limit is per account, not per instance', async () => {
  for (let index = 0; index < DAILY_LIMIT; index += 1) {
    await service.request({ method: 'POST', path: '/v1/feedback', body: report(`within-${index}`), accessToken });
  }
  const other = await service.signupThroughInvite({ email: 'unbounded@example.org', authHash: sampleAuthHash(74) });
  const response = await service.request<ReportResponse>({
    method: 'POST',
    path: '/v1/feedback',
    body: report('theirs'),
    accessToken: other.tokens.accessToken,
  });
  assert.equal(response.status, 201, 'one account at its limit must not lock out another');
});

test('an image over the decoded cap is a 413 even when the body fits', async () => {
  // The second stage, and the one a body-parser limit cannot reach: this
  // instance boots with the PRODUCTION body limit, so a 5 MB image arrives
  // intact and the handler is what refuses it.
  const roomy = await startService({ db: database.db, feedback: { dailyLimit: DAILY_LIMIT } });
  try {
    const session = await roomy.signupThroughInvite({ email: 'roomy@example.org', authHash: sampleAuthHash(75) });
    const tooLarge = Buffer.alloc(MAX_FEEDBACK_IMAGE_BYTES + 1, 0x42);
    const response = await roomy.request<{ error: string }>({
      method: 'POST',
      path: '/v1/feedback',
      body: report('big-picture', tooLarge),
      accessToken: session.tokens.accessToken,
    });
    // The SAME status and the SAME sentence body-parser's own refusal produces,
    // so a client does not need to know which layer answered.
    assert.equal(response.status, 413);
    assert.equal(response.body.error, 'request body exceeds the maximum accepted size');

    const rows = await database.db.select().from(feedbackReports);
    assert.equal(rows.length, 0);
  } finally {
    await roomy.close();
  }
});
