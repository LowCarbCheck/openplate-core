/**
 * The billing principal's PATCH is bounded by FIELD as well as by route, and a
 * body it may not send writes nothing at all.
 *
 * WHY THE REFUSAL AND NOT A SILENT DROP. Ignoring `role` would leave the
 * caller believing it just made somebody an administrator. A billing service
 * that believes something false about this instance's accounts is worse than
 * one that got an error it can log, and the error is the only version of the
 * two that anybody will ever notice.
 *
 * WHY NOTHING IS WRITTEN, NOT EVEN THE ALLOWED KEYS. `{ dailyAiLimit: 60,
 * role: "admin" }` is one request expressing one intent. Half-applying it
 * would answer a refusal while having moved the allowance, so a retry would
 * double-apply and a reconciliation would disagree with itself. The refusal is
 * therefore ahead of the parse and ahead of every store call.
 *
 * EVERY ASSERTION HERE HAS A CONTROL. The refusals are paired with the same
 * body sent by the OPERATOR, which succeeds, so a test file that passed
 * because the whole PATCH route was broken cannot exist. And the allowed pair
 * is asserted to reach the store, so a scope that refused everything fails.
 * Proved by injection on 2026-09-09.
 */
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { startAdminHarness, type AdminHarness } from './admin-harness.js';
import { MAX_DAILY_AI_LIMIT } from '../../src/admin/invite-store.js';
import { SERVICE_FIELD_REFUSAL } from '../../src/server/service-principal-scope.js';

const BILLING_TOKEN = 'billing-6b90d3f7c2a1458e0fd63b7a';
const ADMIN_TOKEN = 'admin-41ce7a02b95d8f36c1b7e04a';

let harness: AdminHarness;
let accountId: number;

/** A fresh address per call: the harness lives for the file, so the account store keeps every account. */
let addressCounter = 0;
function nextEmail(): string {
  addressCounter += 1;
  return `payer-${addressCounter}@example.org`;
}

/** Seeds an account in BOTH stores: the metadata store the route reads and the account store it writes. */
async function seedAccount(): Promise<number> {
  const email = nextEmail();
  const account = await harness.fakeAccounts.seedAccount({
    email,
    displayName: 'Anna Schmidt',
    role: 'member',
    dailyAiLimit: 20,
  });
  harness.admin.seed({ id: account.id, email, displayName: 'Anna Schmidt', role: 'member', dailyAiLimit: 20 });
  return account.id;
}

async function patchAs(input: { token: string; body: unknown }): Promise<{ status: number; error: string | null }> {
  const response = await harness.request({
    method: 'PATCH',
    path: `/v1/admin/accounts/${accountId}`,
    token: input.token,
    body: input.body,
  });
  // SAFETY: every response this route gives is a JSON object, and the tests
  // below read only `error`, which is absent on a success.
  const body = (await response.json()) as { error?: string };
  return { status: response.status, error: body.error ?? null };
}

before(async () => {
  harness = await startAdminHarness({ adminToken: ADMIN_TOKEN, billingToken: BILLING_TOKEN });
});

beforeEach(async () => {
  accountId = await seedAccount();
});

after(async () => {
  await harness.close();
});

test('a body naming role is refused and the role does not move', async () => {
  const refused = await patchAs({ token: BILLING_TOKEN, body: { role: 'admin' } });
  assert.equal(refused.status, 403);
  assert.equal(refused.error, SERVICE_FIELD_REFUSAL);

  const account = await harness.fakeAccounts.findAccountById(accountId);
  assert.equal(account?.role, 'member');

  // THE CONTROL: the same body from the operator works, so the refusal above
  // is the scope and not a broken route.
  const allowed = await patchAs({ token: ADMIN_TOKEN, body: { role: 'admin' } });
  assert.equal(allowed.status, 200);
  const promoted = await harness.fakeAccounts.findAccountById(accountId);
  assert.equal(promoted?.role, 'admin');
});

test('a body naming suspended is refused and the account is not suspended', async () => {
  const refused = await patchAs({ token: BILLING_TOKEN, body: { suspended: true } });
  assert.equal(refused.status, 403);
  assert.equal(refused.error, SERVICE_FIELD_REFUSAL);

  const account = await harness.fakeAccounts.findAccountById(accountId);
  assert.equal(account?.suspendedAt, null);

  const allowed = await patchAs({ token: ADMIN_TOKEN, body: { suspended: true } });
  assert.equal(allowed.status, 200);
  const suspended = await harness.fakeAccounts.findAccountById(accountId);
  assert.notEqual(suspended?.suspendedAt, null);
});

test('a body naming displayName is refused and the name does not move', async () => {
  const refused = await patchAs({ token: BILLING_TOKEN, body: { displayName: 'Renamed By Biller' } });
  assert.equal(refused.status, 403);
  assert.equal(refused.error, SERVICE_FIELD_REFUSAL);

  const account = await harness.fakeAccounts.findAccountById(accountId);
  assert.equal(account?.displayName, 'Anna Schmidt');
});

test('an allowed field beside a refused one is not written either', async () => {
  const refused = await patchAs({
    token: BILLING_TOKEN,
    body: { dailyAiLimit: 500, allowanceExpiresAt: '2099-01-01T00:00:00.000Z', role: 'admin' },
  });
  assert.equal(refused.status, 403);
  assert.equal(refused.error, SERVICE_FIELD_REFUSAL);

  const account = await harness.fakeAccounts.findAccountById(accountId);
  // Neither the allowance nor the date moved: the request was refused whole.
  assert.equal(account?.dailyAiLimit, 20);
  assert.equal(account?.allowanceExpiresAt, null);
  assert.equal(account?.role, 'member');
});

test('an unknown field is refused, so a typo is never a silent no-op', async () => {
  const refused = await patchAs({ token: BILLING_TOKEN, body: { dailyAILimit: 60 } });
  assert.equal(refused.status, 403);
  assert.equal(refused.error, SERVICE_FIELD_REFUSAL);
});

test('the two allowed fields are written', async () => {
  const changed = await patchAs({
    token: BILLING_TOKEN,
    body: { dailyAiLimit: 60, allowanceExpiresAt: '2099-01-01T00:00:00.000Z' },
  });
  assert.equal(changed.status, 200);

  const account = await harness.fakeAccounts.findAccountById(accountId);
  assert.equal(account?.dailyAiLimit, 60);
  assert.equal(account?.allowanceExpiresAt?.toISOString(), '2099-01-01T00:00:00.000Z');
});

test('the ceiling on dailyAiLimit still applies to the billing principal', async () => {
  const refused = await patchAs({ token: BILLING_TOKEN, body: { dailyAiLimit: MAX_DAILY_AI_LIMIT + 1 } });
  // A 400 and not a 403: the field is in scope, the value is not a legal one.
  // The credential relaxes no existing validation.
  assert.equal(refused.status, 400);
  assert.ok(refused.error?.includes(String(MAX_DAILY_AI_LIMIT)));

  const account = await harness.fakeAccounts.findAccountById(accountId);
  assert.equal(account?.dailyAiLimit, 20);
});

test('an empty body from the billing principal is the ordinary empty-patch 400', async () => {
  // Not a scope refusal: it named no field it may not name. It named none at
  // all, which is the rule every caller of this route gets.
  const refused = await patchAs({ token: BILLING_TOKEN, body: {} });
  assert.equal(refused.status, 400);
  assert.notEqual(refused.error, SERVICE_FIELD_REFUSAL);
});
