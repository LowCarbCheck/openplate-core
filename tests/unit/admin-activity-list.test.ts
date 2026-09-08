/**
 * `GET /v1/admin/activity`: one strip per person on a page of the accounts
 * list, in the accounts list's own order.
 *
 * WHY THE ENDPOINT EXISTS AT ALL. The console draws a seven-day strip beside
 * every row of the people list, and the only way to get one before this was
 * `GET /v1/admin/accounts/:id/activity`, once per row. A page of fifty is
 * fifty round trips for a screen an operator opens in one go.
 *
 * THE TWO PROPERTIES WORTH TESTING ARE BOTH ABOUT ABSENCE. An account with no
 * usage row at all must still appear, with a strip of zeroes, for the same
 * reason a quiet day is a zero rather than a gap: otherwise "this person did
 * nothing" and "this person was not in the answer" are the same fact. And the
 * order must be the accounts list's, because strip `n` is drawn beside
 * person `n` and a re-sorted answer would put somebody else's week under
 * their name.
 *
 * The pure grouper is tested directly first, without a server, and the route
 * afterwards through the real app (`admin-harness.ts`).
 */
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { asArray, asNumber, asObject, asString, type JsonValue } from '../../src/lib/json.js';
import { startAdminHarness, type AdminHarness } from './admin-harness.js';
import { activityWindow, zeroFillActivityStrips } from '../../src/admin/account-activity.js';
import { AI_USAGE_RETENTION_DAYS } from '../../src/ai/usage-retention.js';
import { MAX_ADMIN_PAGE_LIMIT } from '../../src/server/admin-routes.js';
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

// ── The pure grouper ────────────────────────────────────────────────────────

test('the grouper keeps the order it was given, whatever order the rows arrived in', () => {
  const window = activityWindow({ now: new Date('2026-09-08T12:00:00.000Z'), days: 2 });

  const strips = zeroFillActivityStrips({
    window,
    accountIds: [3, 1, 2],
    // Deliberately in a different order from the ids, and interleaved.
    counted: [
      { accountId: 2, day: '2026-09-08', count: 5 },
      { accountId: 1, day: '2026-09-07', count: 1 },
      { accountId: 3, day: '2026-09-08', count: 9 },
    ],
  });

  assert.deepEqual(
    strips.map((strip) => strip.accountId),
    [3, 1, 2],
  );
  assert.deepEqual(strips[1]?.days, [
    { day: '2026-09-07', count: 1 },
    { day: '2026-09-08', count: 0 },
  ]);
});

test('an account with no rows at all still gets a full strip of zeroes', () => {
  const window = activityWindow({ now: new Date('2026-09-08T12:00:00.000Z'), days: 3 });

  const strips = zeroFillActivityStrips({
    window,
    accountIds: [7, 8],
    counted: [{ accountId: 8, day: '2026-09-08', count: 2 }],
  });

  // Not an omission and not an empty list: three days of nothing, which is a
  // different sentence from "no answer".
  assert.equal(strips.length, 2);
  assert.deepEqual(strips[0], {
    accountId: 7,
    days: [
      { day: '2026-09-06', count: 0 },
      { day: '2026-09-07', count: 0 },
      { day: '2026-09-08', count: 0 },
    ],
  });
});

test('a row outside the window never leaks into a strip', () => {
  const window = activityWindow({ now: new Date('2026-09-08T12:00:00.000Z'), days: 2 });

  const strips = zeroFillActivityStrips({
    window,
    accountIds: [4],
    counted: [
      { accountId: 4, day: '2026-09-01', count: 99 },
      { accountId: 4, day: '2026-09-08', count: 3 },
    ],
  });

  // The loop walks the WINDOW, not the rows, so the count from outside it
  // cannot lengthen the strip or displace a day inside it.
  assert.deepEqual(strips[0]?.days, [
    { day: '2026-09-07', count: 0 },
    { day: '2026-09-08', count: 3 },
  ]);
  assert.ok(!JSON.stringify(strips).includes('99'));
});

test('a row for an account nobody asked about is dropped', () => {
  const window = activityWindow({ now: new Date('2026-09-08T12:00:00.000Z'), days: 1 });

  const strips = zeroFillActivityStrips({
    window,
    accountIds: [4],
    counted: [
      { accountId: 4, day: '2026-09-08', count: 3 },
      { accountId: 5, day: '2026-09-08', count: 77 },
    ],
  });

  assert.equal(strips.length, 1);
  assert.deepEqual(strips[0]?.days, [{ day: '2026-09-08', count: 3 }]);
});

// ── The route ───────────────────────────────────────────────────────────────

interface ActivityPageBody {
  window: { days: number; fromDay: string; toDay: string };
  accounts: { accountId: number; days: { day: string; count: number }[] }[];
  total: number;
}

/** Decodes the response through `lib/json.ts`, so nothing below trusts a shape it did not check. */
function decodeActivityPage(value: JsonValue): ActivityPageBody {
  const body = asObject(value);
  const windowValue = asObject(body?.window);
  const days = asNumber(windowValue?.days);
  const fromDay = asString(windowValue?.fromDay);
  const toDay = asString(windowValue?.toDay);
  const total = asNumber(body?.total);
  if (days === null || fromDay === null || toDay === null || total === null) {
    throw new Error('the activity page did not have the documented shape');
  }

  const accounts = (asArray(body?.accounts) ?? []).map((entry) => {
    const row = asObject(entry);
    const accountId = asNumber(row?.accountId);
    if (accountId === null) throw new Error('an activity entry had no account id');
    const strip = (asArray(row?.days) ?? []).map((dayEntry) => {
      const dayRow = asObject(dayEntry);
      const day = asString(dayRow?.day);
      const count = asNumber(dayRow?.count);
      if (day === null || count === null) throw new Error('an activity day did not have the documented shape');
      return { day, count };
    });
    return { accountId, days: strip };
  });

  return { window: { days, fromDay, toDay }, accounts, total };
}

async function fetchActivityPage(query = ''): Promise<{ status: number; body: JsonValue }> {
  const response = await harness.request({ method: 'GET', path: `/v1/admin/activity${query}`, token: ADMIN_TOKEN });
  // SAFETY: every admin endpoint answers `application/json` by contract, and a
  // body that did not parse throws inside `json()` rather than reaching here.
  return { status: response.status, body: (await response.json()) as JsonValue };
}

async function fetchAccountIds(query = ''): Promise<number[]> {
  const response = await harness.request({ method: 'GET', path: `/v1/admin/accounts${query}`, token: ADMIN_TOKEN });
  // SAFETY: every admin endpoint answers `application/json` by contract, and a
  // body that did not parse throws inside `json()` rather than reaching here.
  const body = asObject((await response.json()) as JsonValue);
  return (asArray(body?.accounts) ?? []).map((entry) => asNumber(asObject(entry)?.id) ?? -1);
}

test('a page of strips comes back in the same order as the accounts list, and pages with it', async () => {
  for (const id of [31, 32, 33, 34]) harness.admin.seed({ id, email: `person-${id}@example.org` });

  const first = decodeActivityPage((await fetchActivityPage('?days=7&limit=2&offset=0')).body);
  assert.deepEqual(
    first.accounts.map((entry) => entry.accountId),
    await fetchAccountIds('?limit=2&offset=0'),
  );

  const second = decodeActivityPage((await fetchActivityPage('?days=7&limit=2&offset=2')).body);
  assert.deepEqual(
    second.accounts.map((entry) => entry.accountId),
    await fetchAccountIds('?limit=2&offset=2'),
  );

  // Not the same two people twice, and `total` is the whole list so a caller
  // knows there is a second page at all.
  assert.deepEqual(first.accounts.map((entry) => entry.accountId).toSorted(), [31, 32]);
  assert.deepEqual(second.accounts.map((entry) => entry.accountId).toSorted(), [33, 34]);
  assert.equal(first.total, 4);
  assert.equal(second.total, 4);
});

test('every account on the page is present, including one that has never made a request', async () => {
  const yesterday = utcDayKeyDaysBefore(now, 1);
  harness.admin.seed({ id: 41, email: 'busy@example.org', activity: { [yesterday]: 2, [utcDayKey(now)]: 3 } });
  harness.admin.seed({ id: 42, email: 'never-used-ai@example.org' });

  const body = decodeActivityPage((await fetchActivityPage('?days=3')).body);

  assert.deepEqual(
    body.accounts.map((entry) => entry.accountId),
    [41, 42],
  );
  assert.deepEqual(
    body.accounts[0]?.days.map((entry) => entry.count),
    [0, 2, 3],
  );
  // A strip of zeroes, NOT a missing entry: the operator's question is whether
  // this person has stopped, and an absence cannot answer it.
  assert.deepEqual(
    body.accounts[1]?.days.map((entry) => entry.count),
    [0, 0, 0],
  );
});

test('a caller asking for a year is capped at the retention window, exactly like the single-account route', async () => {
  harness.admin.seed({ id: 43, email: 'long-window@example.org' });

  const body = decodeActivityPage((await fetchActivityPage('?days=365')).body);
  assert.equal(body.window.days, AI_USAGE_RETENTION_DAYS);
  assert.equal(body.window.toDay, utcDayKey(now));
  assert.equal(body.window.fromDay, utcDayKeyDaysBefore(now, AI_USAGE_RETENTION_DAYS - 1));
  assert.equal(body.accounts[0]?.days.length, AI_USAGE_RETENTION_DAYS);
});

test('a days parameter that is not a positive integer is a 400, not a silent default', async () => {
  harness.admin.seed({ id: 44, email: 'bad-days@example.org' });

  for (const query of ['?days=banana', '?days=0', '?days=-7', '?days=1.5']) {
    assert.equal((await fetchActivityPage(query)).status, 400, `${query} must be refused`);
  }
});

test('an out-of-range limit is a 400, the same refusal the accounts list gives', async () => {
  harness.admin.seed({ id: 45, email: 'bad-limit@example.org' });

  for (const query of [`?limit=${MAX_ADMIN_PAGE_LIMIT + 1}`, '?limit=-1', '?limit=banana', '?offset=-1']) {
    const answered = await fetchActivityPage(query);
    assert.equal(answered.status, 400, `${query} must be refused`);
    // The SAME sentence, because it is the same rule: a caller that learned
    // the bound from one endpoint has learned it for the other.
    const listed = await harness.request({
      method: 'GET',
      path: `/v1/admin/accounts${query}`,
      token: ADMIN_TOKEN,
    });
    // SAFETY: as above, both endpoints answer JSON by contract.
    const listedBody = (await listed.json()) as JsonValue;
    assert.equal(asString(asObject(answered.body)?.error), asString(asObject(listedBody)?.error));
  }
});

test('without the admin credential the strip route answers nothing about anybody', async () => {
  harness.admin.seed({ id: 46, email: 'guarded-strip@example.org' });

  // This harness HAS a static token configured, so a missing credential is the
  // documented 401 rather than the 404 an unconfigured instance gives
  // (`server/admin-auth.ts`). What matters for a new route is that it sits
  // behind the same middleware as the rest of the tree.
  const response = await harness.request({ method: 'GET', path: '/v1/admin/activity', token: null });
  assert.equal(response.status, 401);
  assert.ok(!(await response.text()).includes('guarded-strip@example.org'));
});

test('the page carries exactly the documented fields, and no account detail beside them', async () => {
  harness.admin.seed({ id: 47, email: 'exact-page@example.org', displayName: 'Exact Page' });

  const answered = await fetchActivityPage('?days=1');
  const body = asObject(answered.body);
  // A whitelist, not a blacklist: a field added here has to be justified
  // before it can ship, and neither the address nor the name is one of them.
  assert.deepEqual(Object.keys(body ?? {}).toSorted(), ['accounts', 'total', 'window']);
  const entry = asObject(asArray(body?.accounts)?.[0]);
  assert.deepEqual(Object.keys(entry ?? {}).toSorted(), ['accountId', 'days']);
  const serialized = JSON.stringify(answered.body);
  assert.ok(!serialized.includes('exact-page@example.org'));
  assert.ok(!serialized.includes('Exact Page'));
});
