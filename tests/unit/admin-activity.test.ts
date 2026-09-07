/**
 * `GET /v1/admin/accounts/:id/activity`: a bounded, zero-filled strip of what
 * one person spent, and nothing else about them.
 *
 * THE PROPERTY THAT MATTERS MOST HERE IS THE ZERO-FILL. `ai_usage_days` holds a
 * row only for a day an account actually spent something on, so an endpoint
 * that returned its rows would make "used nothing on Tuesday" and "Tuesday is
 * not in this answer" the same fact to whoever reads the strip. The question an
 * operator opens this screen with is whether somebody has stopped, and a gap is
 * the answer to it, so the two must not be confusable.
 *
 * THE WINDOW IS THE SERVER'S. A caller asking for a year gets ninety days,
 * because beyond ninety the retention sweep has deleted the rows
 * (`ai/usage-retention.ts`) and a longer strip could only be drawn from the
 * zero-fill, showing an operator a person who stopped in March when what
 * actually stopped was the record.
 *
 * IT GOES THROUGH THE REAL APP. The harness boots `createApp`, so the admin
 * auth in front of this route is the production middleware rather than a
 * router the test assembled, and a call with no credential is refused by the
 * same rule the rest of the tree is refused by.
 */
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { asArray, asNumber, asObject, asString, type JsonValue } from '../../src/lib/json.js';
import { startAdminHarness, type AdminHarness } from './admin-harness.js';
import { AI_USAGE_RETENTION_DAYS } from '../../src/ai/usage-retention.js';
import { utcDayKey, utcDayKeyDaysBefore } from '../../src/lib/utc-day.js';

const ADMIN_TOKEN = 'admin-token-for-the-unit-suite-0123456789';

let harness: AdminHarness;
/** The clock the harness's app runs on, so a test can name the days it expects. */
let now: Date;

before(async () => {
  harness = await startAdminHarness({ adminToken: ADMIN_TOKEN });
  now = harness.fixture.now();
});

after(async () => {
  await harness.close();
});

beforeEach(() => {
  harness.admin.clear();
});

interface ActivityBody {
  accountId: number;
  lastSeenAt: string | null;
  window: { days: number; fromDay: string; toDay: string };
  days: { day: string; count: number }[];
}

/** Decodes the response through `lib/json.ts`, so nothing below trusts a shape it did not check. */
function decodeActivity(value: JsonValue): ActivityBody {
  const body = asObject(value);
  const windowValue = asObject(body?.window);
  const accountId = asNumber(body?.accountId);
  const days = asNumber(windowValue?.days);
  const fromDay = asString(windowValue?.fromDay);
  const toDay = asString(windowValue?.toDay);
  if (accountId === null || days === null || fromDay === null || toDay === null) {
    throw new Error('the activity response did not have the documented shape');
  }

  const strip = (asArray(body?.days) ?? []).map((entry) => {
    const row = asObject(entry);
    const day = asString(row?.day);
    const count = asNumber(row?.count);
    if (day === null || count === null) throw new Error('an activity day did not have the documented shape');
    return { day, count };
  });

  return { accountId, lastSeenAt: asString(body?.lastSeenAt), window: { days, fromDay, toDay }, days: strip };
}

async function fetchActivity(input: { id: number; query?: string }): Promise<{ status: number; body: JsonValue }> {
  const response = await harness.request({
    method: 'GET',
    path: `/v1/admin/accounts/${input.id}/activity${input.query ?? ''}`,
    token: ADMIN_TOKEN,
  });
  // SAFETY: every admin endpoint answers `application/json` by contract, and a
  // body that did not parse throws inside `json()` rather than reaching here.
  return { status: response.status, body: (await response.json()) as JsonValue };
}

test('a day with no row comes back as zero, so a gap and a quiet day are different facts', async () => {
  const yesterday = utcDayKeyDaysBefore(now, 1);
  const twoDaysAgo = utcDayKeyDaysBefore(now, 2);
  harness.admin.seed({
    id: 11,
    email: 'quiet@example.org',
    // Two rows, two days apart, so the day between them has no row at all.
    activity: { [twoDaysAgo]: 4, [utcDayKey(now)]: 1 },
  });

  const answered = await fetchActivity({ id: 11, query: '?days=3' });
  assert.equal(answered.status, 200);
  const body = decodeActivity(answered.body);

  // EVERY day in the window, in order, with the empty one present and zero.
  assert.deepEqual(body.days, [
    { day: twoDaysAgo, count: 4 },
    { day: yesterday, count: 0 },
    { day: utcDayKey(now), count: 1 },
  ]);
  // A zero-filled day is indistinguishable in TYPE from a counted one, which
  // is what lets a caller draw one strip rather than two.
  assert.equal(body.days.length, 3);
});

test('an account with no usage at all gets a full strip of zeroes, not an empty list', async () => {
  harness.admin.seed({ id: 12, email: 'never-used-ai@example.org' });

  const body = decodeActivity((await fetchActivity({ id: 12, query: '?days=5' })).body);
  assert.equal(body.days.length, 5);
  assert.deepEqual(
    body.days.map((entry) => entry.count),
    [0, 0, 0, 0, 0],
  );
  // An empty `days` array would be the API saying "no answer" where the truth
  // is "five days of nothing", and those are different sentences.
  assert.equal(body.window.days, 5);
});

test('a caller asking for a year is capped at the retention window, and told which window it got', async () => {
  harness.admin.seed({ id: 13, email: 'long-window@example.org' });

  const body = decodeActivity((await fetchActivity({ id: 13, query: '?days=365' })).body);
  assert.equal(body.window.days, AI_USAGE_RETENTION_DAYS);
  assert.equal(body.days.length, AI_USAGE_RETENTION_DAYS);
  assert.equal(body.window.toDay, utcDayKey(now));
  assert.equal(body.window.fromDay, utcDayKeyDaysBefore(now, AI_USAGE_RETENTION_DAYS - 1));
});

test('the default window is the retention window', async () => {
  harness.admin.seed({ id: 14, email: 'default-window@example.org' });

  const body = decodeActivity((await fetchActivity({ id: 14 })).body);
  assert.equal(body.window.days, AI_USAGE_RETENTION_DAYS);
  assert.equal(body.days.length, AI_USAGE_RETENTION_DAYS);
});

test('a days parameter that is not a positive integer is a 400, not a silent default', async () => {
  harness.admin.seed({ id: 15, email: 'bad-parameter@example.org' });

  for (const query of ['?days=banana', '?days=0', '?days=-7', '?days=1.5']) {
    const answered = await fetchActivity({ id: 15, query });
    assert.equal(answered.status, 400, `${query} must be refused`);
  }
});

test('last sign-in crosses the wire as a timestamp, and as null when there has never been one', async () => {
  harness.admin.seed({ id: 16, email: 'signed-in@example.org', lastSeenAt: new Date('2026-09-06T18:30:00.000Z') });
  harness.admin.seed({ id: 17, email: 'never-signed-in@example.org' });

  const seen = decodeActivity((await fetchActivity({ id: 16, query: '?days=1' })).body);
  // A TIMESTAMP, not "yesterday": the API does not decide what a relative
  // phrase means, in which language, or against whose clock.
  assert.equal(seen.lastSeenAt, '2026-09-06T18:30:00.000Z');

  const never = decodeActivity((await fetchActivity({ id: 17, query: '?days=1' })).body);
  // An invited account that never signed in has no honest value, and the
  // screen says so in words rather than rendering an epoch.
  assert.equal(never.lastSeenAt, null);
});

test('an unknown account is the same 404 every other account route gives', async () => {
  const answered = await fetchActivity({ id: 4242 });
  assert.equal(answered.status, 404);
  assert.equal(asString(asObject(answered.body)?.error), 'no such account');
});

test('without the admin credential the activity route answers nothing about the account', async () => {
  harness.admin.seed({ id: 18, email: 'guarded@example.org' });

  // This harness HAS a static token configured, so a missing credential is the
  // documented 401 rather than the 404 an unconfigured instance gives
  // (`server/admin-auth.ts`). What matters for a new route is that it sits
  // behind the same middleware as the rest of the tree, so no account fact
  // reaches an anonymous caller.
  const response = await harness.request({ method: 'GET', path: '/v1/admin/accounts/18/activity', token: null });
  assert.equal(response.status, 401);
  assert.ok(!(await response.text()).includes('guarded@example.org'));
});

test('the activity body carries exactly the documented fields and no account detail beside them', async () => {
  harness.admin.seed({
    id: 19,
    email: 'exact-shape@example.org',
    displayName: 'Exact Shape',
    lastSeenAt: new Date('2026-09-06T18:30:00.000Z'),
  });

  const answered = await fetchActivity({ id: 19, query: '?days=1' });
  const body = asObject(answered.body);
  // A whitelist, not a blacklist: a field added here has to be justified
  // before it can ship, and the address is deliberately not one of them.
  assert.deepEqual(Object.keys(body ?? {}).toSorted(), ['accountId', 'days', 'lastSeenAt', 'window']);
  assert.ok(!JSON.stringify(answered.body).includes('exact-shape@example.org'));
});
