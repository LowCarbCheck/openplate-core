/**
 * The two reads the billing principal gets carry no address and no name,
 * checked over the RAW RESPONSE TEXT against seeded values.
 *
 * WHY THE RAW TEXT AND NOT THE PARSED KEYS. `assert.equal(body.email,
 * undefined)` passes on a body that carries the address under any other name,
 * inside a nested object, or in a message. Searching the serialized bytes for
 * the exact string that was seeded catches all three. Same discipline, and the
 * same reason, as `tests/unit/admin-no-forbidden-fields.test.ts`.
 *
 * WHY THE SEEDED VALUES ARE DISTINCTIVE. An absence assertion is vacuous if the
 * fixture never held the value. So the account is seeded with an address and a
 * display name no other test uses, and the CONTROL is that the OPERATOR'S read
 * of the same account contains both of them: that is what proves the strings
 * were reachable and that the projection is what removed them.
 *
 * THE KEY SET IS ALSO FROZEN, and that is the second wall. A field added to
 * `AdminAccountSummary` later cannot arrive on this body unless somebody types
 * it into `toServiceAccountView`, and this assertion is where they find out
 * they have to.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startAdminHarness, type AdminHarness } from './admin-harness.js';

const BILLING_TOKEN = 'billing-a17d5c92e6b04f38d7ac1b60';
const ADMIN_TOKEN = 'admin-5e0c92a71bd4368fac71e0d2';

/** Distinctive enough that finding it in a body cannot be a coincidence. */
const SEEDED_EMAIL = 'quirinia.hallbjorn@example.invalid';
const SEEDED_DISPLAY_NAME = 'Quirinia Hallbjorn';

/** In the future, so this account is in the reconciliation list. */
const FUTURE_EXPIRY = '2099-03-01T12:00:00.000Z';
/** Already gone, so this one is NOT, which is what makes the list's predicate observable. */
const PAST_EXPIRY = '2020-01-01T00:00:00.000Z';

/**
 * The service read's body, transcribed from PROTOCOL.md section 5.20 rather
 * than inferred from the route, so a route that grew a field fails the key
 * assertions below instead of quietly widening this interface.
 */
interface ServiceAccountBody {
  account: { id: number; allowanceExpiresAt: string | null; dailyAiLimit: number };
}

/** One row of the reconciliation list, and the page around it. Two fields per row, asserted. */
interface ExpiringRow {
  id: number;
  allowanceExpiresAt: string;
}

interface ExpiringBody {
  accounts: ExpiringRow[];
  total: number;
  limit: number;
  offset: number;
}

let harness: AdminHarness;
let payerId: number;
let expiredId: number;

before(async () => {
  harness = await startAdminHarness({ adminToken: ADMIN_TOKEN, billingToken: BILLING_TOKEN });

  const payer = await harness.fakeAccounts.seedAccount({
    email: SEEDED_EMAIL,
    displayName: SEEDED_DISPLAY_NAME,
    role: 'admin',
    dailyAiLimit: 120,
  });
  payerId = payer.id;
  harness.admin.seed({
    id: payer.id,
    email: SEEDED_EMAIL,
    displayName: SEEDED_DISPLAY_NAME,
    role: 'admin',
    dailyAiLimit: 120,
    aiUsedToday: 7,
    allowanceExpiresAt: new Date(FUTURE_EXPIRY),
    lastSeenAt: new Date('2026-09-01T08:00:00.000Z'),
    blobSizeBytes: 4096,
    keyRecordKinds: ['passphrase'],
  });

  const expired = await harness.fakeAccounts.seedAccount({ email: 'lapsed@example.invalid' });
  expiredId = expired.id;
  harness.admin.seed({
    id: expired.id,
    email: 'lapsed@example.invalid',
    allowanceExpiresAt: new Date(PAST_EXPIRY),
  });
});

after(async () => {
  await harness.close();
});

test('the single read is exactly id, allowanceExpiresAt and dailyAiLimit', async () => {
  const response = await harness.request({
    method: 'GET',
    path: `/v1/admin/accounts/${payerId}`,
    token: BILLING_TOKEN,
  });
  assert.equal(response.status, 200);
  const text = await response.text();

  assert.ok(!text.includes(SEEDED_EMAIL), 'the address must not appear anywhere in the body');
  assert.ok(!text.includes(SEEDED_DISPLAY_NAME), 'the display name must not appear anywhere in the body');
  assert.ok(!text.includes('admin'), 'the role must not appear anywhere in the body');

  // SAFETY: the route answers a JSON object with one `account` key, and the
  // assertion below is what fixes its shape.
  const body = JSON.parse(text) as ServiceAccountBody;
  assert.deepEqual(Object.keys(body.account).toSorted(), ['allowanceExpiresAt', 'dailyAiLimit', 'id']);
  assert.deepEqual(body.account, { id: payerId, allowanceExpiresAt: FUTURE_EXPIRY, dailyAiLimit: 120 });
});

test('the operator reading the same account DOES get the address, so the absences above mean something', async () => {
  const response = await harness.request({
    method: 'GET',
    path: `/v1/admin/accounts/${payerId}`,
    token: ADMIN_TOKEN,
  });
  assert.equal(response.status, 200);
  const text = await response.text();

  assert.ok(text.includes(SEEDED_EMAIL), 'the fixture must really hold the address');
  assert.ok(text.includes(SEEDED_DISPLAY_NAME), 'the fixture must really hold the display name');
});

test('an account with no end date reads allowanceExpiresAt as null, never as an absent key', async () => {
  const account = await harness.fakeAccounts.seedAccount({ email: 'nodate@example.invalid' });
  harness.admin.seed({ id: account.id, email: 'nodate@example.invalid', dailyAiLimit: 0 });

  const response = await harness.request({
    method: 'GET',
    path: `/v1/admin/accounts/${account.id}`,
    token: BILLING_TOKEN,
  });
  // SAFETY: as above, a JSON object with one `account` key.
  const body = (await response.json()) as ServiceAccountBody;
  assert.deepEqual(Object.keys(body.account).toSorted(), ['allowanceExpiresAt', 'dailyAiLimit', 'id']);
  assert.equal(body.account.allowanceExpiresAt, null);
});

test('an unknown id is the ordinary 404, and so is an account that was erased', async () => {
  const unknown = await harness.request({ method: 'GET', path: '/v1/admin/accounts/99999', token: BILLING_TOKEN });
  assert.equal(unknown.status, 404);

  // Erasure here is a cascade, not a tombstone, so there is nothing left for a
  // `deletedAt` to be read from. The biller reads 404 and stops charging,
  // which is the right action whether the account is gone or never existed.
  const erased = await harness.fakeAccounts.seedAccount({ email: 'erased@example.invalid' });
  harness.admin.seed({ id: erased.id, email: 'erased@example.invalid' });
  const deleted = await harness.request({
    method: 'DELETE',
    path: `/v1/admin/accounts/${erased.id}`,
    token: ADMIN_TOKEN,
  });
  assert.equal(deleted.status, 204);
  // The one cascade this unit fixture cannot perform for itself: the real
  // erasure drops the `accounts` row both stores read, and there is only one
  // row. See `FakeAdminStore.forget`.
  harness.admin.forget(erased.id);

  const gone = await harness.request({
    method: 'GET',
    path: `/v1/admin/accounts/${erased.id}`,
    token: BILLING_TOKEN,
  });
  assert.equal(gone.status, 404);
});

test('the reconciliation list carries two fields per row and only future dates', async () => {
  const response = await harness.request({
    method: 'GET',
    path: '/v1/admin/accounts/expiring',
    token: BILLING_TOKEN,
  });
  assert.equal(response.status, 200);
  const text = await response.text();

  assert.ok(!text.includes(SEEDED_EMAIL), 'the address must not appear anywhere in the list');
  assert.ok(!text.includes(SEEDED_DISPLAY_NAME), 'the display name must not appear anywhere in the list');
  assert.ok(!text.includes('lapsed@example.invalid'), 'no address at all, not even an expired one');
  assert.ok(!text.includes(PAST_EXPIRY), 'an allowance that already ran out is not a disagreement');

  // SAFETY: the route answers a paged JSON object; the assertions below are
  // what fix its shape.
  const body = JSON.parse(text) as ExpiringBody;
  assert.deepEqual(Object.keys(body).toSorted(), ['accounts', 'limit', 'offset', 'total']);

  const ids = new Set(body.accounts.map((row) => row.id));
  assert.ok(ids.has(payerId), 'the account whose allowance ends in the future must be listed');
  assert.ok(!ids.has(expiredId), 'the account whose allowance already ended must not be');

  for (const row of body.accounts) {
    assert.deepEqual(Object.keys(row).toSorted(), ['allowanceExpiresAt', 'id']);
  }
});

test('the list pages with the same rule every other paged admin endpoint has', async () => {
  const refused = await harness.request({
    method: 'GET',
    path: '/v1/admin/accounts/expiring?limit=9999',
    token: BILLING_TOKEN,
  });
  assert.equal(refused.status, 400);

  const paged = await harness.request({
    method: 'GET',
    path: '/v1/admin/accounts/expiring?limit=1&offset=0',
    token: BILLING_TOKEN,
  });
  // SAFETY: as above.
  const body = (await paged.json()) as ExpiringBody;
  assert.equal(body.accounts.length, 1);
  assert.equal(body.limit, 1);
  assert.equal(body.offset, 0);
});
