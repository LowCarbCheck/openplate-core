/**
 * Invite redemption against REAL Postgres (M166, addressed in M192).
 *
 * This file exists for the properties the unit suite structurally cannot
 * reach. `tests/unit/fake-account-store.ts` reproduces the RULES by ordering
 * its writes, but the rules are enforced in production by a transaction and a
 * conditional UPDATE, and neither a rollback nor a row lock has any meaning in
 * a JavaScript Map. Concurrency is a property of the database, so it is tested
 * against the database.
 *
 * Three things are proved here and nowhere else:
 *
 *  - Concurrent redemptions of ONE invite produce exactly one account. If the
 *    store did a SELECT-then-UPDATE, both callers would see it unredeemed and
 *    two people would get in on one invitation.
 *  - A signup for an address that already has an account leaves the invite
 *    spendable. That is the transaction's rollback, observed from outside: the
 *    conditional UPDATE has already run and been undone by the time the caller
 *    sees the 409.
 *  - The five writes of a signup commit together. An account with no key
 *    records logs in and decrypts nothing, and the client has thrown the
 *    passphrase away by the time it would find out.
 */
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { eq } from 'drizzle-orm';
import { setupTestDatabase, type TestDatabase } from './db-harness.js';
import type { JsonObject } from '../../src/lib/json.js';
import { createDrizzleInviteStore } from '../../src/db/invite-store.js';
import { generateSignupInviteToken } from '../../src/lib/tokens.js';
import { accounts, signupInvites, syncKeyRecords } from '../../src/db/schema.js';
import {
  sampleAuthHash,
  sampleKdfDescriptor,
  sampleRecoveryCode,
  sampleWrappedDek,
  startService,
  type ServiceHarness,
} from './service-harness.js';

let database: TestDatabase;

before(async () => {
  database = await setupTestDatabase();
});

after(async () => {
  await database.close();
});

beforeEach(async () => {
  await database.reset();
});

/** The signup request as this service's wire contract defines it (PROTOCOL.md §5.8). */
interface SignupRequest {
  authHash: string;
  kdfDescriptor: ReturnType<typeof sampleKdfDescriptor>;
  recoveryAuthHash: string;
  recoveryCode: string;
  keyRecords: { kind: string; kdfDescriptor: unknown; wrappedDek: string }[];
  displayName?: string;
  /** The only field that identifies anything: the address comes from the invite row. */
  inviteToken?: string;
}

function signupBody(inviteToken?: string): SignupRequest {
  const body: SignupRequest = {
    authHash: sampleAuthHash(11),
    kdfDescriptor: sampleKdfDescriptor(),
    recoveryAuthHash: sampleAuthHash(31),
    recoveryCode: sampleRecoveryCode(),
    keyRecords: [
      { kind: 'passphrase', kdfDescriptor: sampleKdfDescriptor(), wrappedDek: sampleWrappedDek() },
      { kind: 'recovery', kdfDescriptor: null, wrappedDek: sampleWrappedDek(41) },
    ],
  };
  // Assigned only when given, so the "no invite at all" case genuinely omits
  // the field rather than sending an explicit `undefined`.
  if (inviteToken !== undefined) body.inviteToken = inviteToken;
  return body;
}

/** Mints one live invite straight through the store — the admin API is tested separately. */
async function mintInvite(
  email: string,
  expiresAt = new Date(Date.now() + 60 * 60 * 1000),
  invitedByAccountId: number | null = null,
): Promise<string> {
  const store = createDrizzleInviteStore(database.db);
  const minted = await store.mint({
    email,
    displayName: null,
    role: 'member',
    dailyAiLimit: 0,
    expiresAt,
    now: new Date(),
    // An operator mint by default: it is exempt from the member cap and from
    // the re-invite rule, and it writes no allowance expiry at redemption.
    invitedByAccountId,
  });
  if (!minted.ok) throw new Error(`could not mint an invite for ${email}: ${minted.reason}`);
  return minted.minted.token;
}

test('an invite admits exactly one account, even under concurrent redemption', async () => {
  const service: ServiceHarness = await startService({ db: database.db });
  try {
    const token = await mintInvite('one-account-only@example.org');

    // Fired together, deliberately not awaited in sequence. With a
    // SELECT-then-UPDATE both would find the invite unredeemed.
    const attempts = await Promise.all(
      [1, 2, 3].map(() =>
        service.request<{ error?: string }>({ method: 'POST', path: '/v1/auth/signup', body: signupBody(token) }),
      ),
    );

    const created = attempts.filter((response) => response.status === 201);
    const refused = attempts.filter((response) => response.status !== 201);
    assert.equal(created.length, 1, `expected exactly one account, got ${created.length}`);
    assert.equal(refused.length, 2);
  } finally {
    await service.close();
  }
});

test('a signup for an address that already has an account is refused and the invite is NOT consumed', async () => {
  const service: ServiceHarness = await startService({ db: database.db });
  try {
    const first = await mintInvite('taken@example.org');
    const created = await service.request({ method: 'POST', path: '/v1/auth/signup', body: signupBody(first) });
    assert.equal(created.status, 201);

    // A SECOND invite for the same address. `InviteStore.mint` refuses one for
    // an address that already has an account, so this is written straight into
    // the table to reach the handler's own guard.
    const second = await mintInviteForTakenAddress('taken@example.org');

    const conflict = await service.request({ method: 'POST', path: '/v1/auth/signup', body: signupBody(second) });
    assert.equal(conflict.status, 409);

    // THE ROLLBACK, OBSERVED. If the conditional UPDATE had committed, the
    // invite would now be spent and a retry after the operator fixed the
    // address would find nothing left.
    const rows = await database.db.select().from(accounts).where(eq(accounts.email, 'taken@example.org'));
    assert.equal(rows.length, 1, 'the conflicting signup must not have created a second row');

    const retry = await service.request({ method: 'POST', path: '/v1/auth/signup', body: signupBody(second) });
    // Still a 409 (the address is still taken), and still not consumed — which
    // is exactly what "the 409 costs the invite nothing" means.
    assert.equal(retry.status, 409);
  } finally {
    await service.close();
  }
});

/**
 * Mints an invite for an address that already has an account, bypassing
 * `InviteStore.mint`'s own refusal.
 *
 * The store guard and the transaction guard defend different things: the store
 * stops an operator inviting somebody who is already here, and the transaction
 * stops a `409` from burning an invite that was minted before the account
 * existed. Only the second is under test above, and reaching it needs a row the
 * store would not write.
 */
async function mintInviteForTakenAddress(email: string): Promise<string> {
  const token = generateSignupInviteToken();
  await database.db.insert(signupInvites).values({
    tokenHash: token.hash,
    email,
    displayName: null,
    role: 'member',
    dailyAiLimit: 0,
    expiresAt: new Date(Date.now() + 60 * 60 * 1000),
  });
  return token.raw;
}

test('a successful signup commits the account, the escrow and BOTH key records together', async () => {
  const service: ServiceHarness = await startService({ db: database.db });
  try {
    const token = await mintInvite('everything@example.org');
    const created = await service.request<{ account: { id: number } }>({
      method: 'POST',
      path: '/v1/auth/signup',
      body: signupBody(token),
    });
    assert.equal(created.status, 201);
    const accountId = created.body.account.id;

    const [row] = await database.db.select().from(accounts).where(eq(accounts.id, accountId));
    assert.ok(row, 'the account row must exist');
    // The escrow, without which no mailed reset can ever be answered.
    assert.ok(row.recoveryCodeEscrow !== null, 'signup must write an escrow');
    assert.ok(row.recoveryCodeEscrow.byteLength > 32, 'the escrow must be iv + ciphertext + tag');
    assert.ok(row.recoveryVerifier !== null, 'signup must write a recovery verifier');

    const records = await database.db.select().from(syncKeyRecords).where(eq(syncKeyRecords.accountId, accountId));
    assert.deepEqual(records.map((record) => record.kind).toSorted(), ['passphrase', 'recovery']);
  } finally {
    await service.close();
  }
});

test('an expired invite is refused', async () => {
  const service: ServiceHarness = await startService({ db: database.db });
  try {
    const token = await mintInvite('late@example.org', new Date(Date.now() - 1000));
    const response = await service.request({ method: 'POST', path: '/v1/auth/signup', body: signupBody(token) });
    assert.equal(response.status, 403);
  } finally {
    await service.close();
  }
});

test('there is no signup without an invite, on any instance', async () => {
  // There is no open mode and no closed mode any more: the invite is the only
  // door, so a body without one is the same 403 a wrong token gets.
  const service: ServiceHarness = await startService({ db: database.db });
  try {
    const response = await service.request<{ error: string }>({
      method: 'POST',
      path: '/v1/auth/signup',
      body: signupBody(),
    });
    assert.equal(response.status, 403);
    assert.equal(response.body.error, 'invite-invalid');
  } finally {
    await service.close();
  }
});

test('invite-lookup shows the addressee, and every bad token is one 404', async () => {
  const service: ServiceHarness = await startService({ db: database.db });
  try {
    const store = createDrizzleInviteStore(database.db);
    const minted = await store.mint({
      email: 'lookup@example.org',
      displayName: 'A Person',
      role: 'member',
      dailyAiLimit: 0,
      expiresAt: new Date(Date.now() + 60 * 60 * 1000),
      now: new Date(),
      invitedByAccountId: null,
    });
    if (!minted.ok) throw new Error('expected a minted invite');

    const found = await service.request<{ email: string; displayName: string | null }>({
      method: 'POST',
      path: '/v1/auth/invite-lookup',
      body: { inviteToken: minted.minted.token },
    });
    assert.equal(found.status, 200);
    assert.equal(found.body.email, 'lookup@example.org');
    assert.equal(found.body.displayName, 'A Person');

    for (const inviteToken of ['si_never-minted', 'gi_a-gateway-invite', '']) {
      const missing = await service.request<{ error: string }>({
        method: 'POST',
        path: '/v1/auth/invite-lookup',
        body: { inviteToken },
      });
      assert.equal(missing.status, 404, `token "${inviteToken}"`);
      assert.equal(missing.body.error, 'invite-invalid');
    }
  } finally {
    await service.close();
  }
});

test('the handshake reports protocol version 2 and carries no signupMode', async () => {
  const service: ServiceHarness = await startService({ db: database.db });
  try {
    const response = await service.request<{ protocolVersion: number; signupMode?: string }>({
      method: 'GET',
      path: '/health',
    });
    assert.equal(response.status, 200);
    assert.equal(response.body.protocolVersion, 2);
    // The field went with the setting it described.
    assert.equal(response.body.signupMode, undefined);
  } finally {
    await service.close();
  }
});

// ---------------------------------------------------------------------------
// The member mint (M212)
// ---------------------------------------------------------------------------

/**
 * `POST /v1/auth/invites` against real Postgres. Three of its properties exist
 * ONLY in the database and cannot be reached from `tests/unit/member-invites.test.ts`:
 *
 *  - the lifetime cap is counted over ROWS, including revoked ones, so it is a
 *    property of the evidence rather than of a counter;
 *  - the re-invite rule survives a deleted account, which is the `ON DELETE SET
 *    NULL` on both foreign keys doing its job;
 *  - redemption writes the allowance expiry, which is one statement inside the
 *    signup transaction.
 */
const MEMBER_INVITE_POLICY = { dailyAiLimit: 25, allowanceDays: 14 };

/** The admin credential the control cases present. Long enough to be the real thing. */
const MEMBER_SUITE_ADMIN_TOKEN = 'integration-admin-token-0123456789abcdef';

async function startWithMemberInvites(): Promise<ServiceHarness> {
  return startService({
    db: database.db,
    memberInvites: MEMBER_INVITE_POLICY,
    adminToken: MEMBER_SUITE_ADMIN_TOKEN,
  });
}

/** Mints one member invitation for `email`, as the signed-in caller. */
async function memberMint(
  service: ServiceHarness,
  input: { accessToken: string; email: string; body?: JsonObject },
): Promise<{ status: number; body: unknown }> {
  const response = await service.request<unknown>({
    method: 'POST',
    path: '/v1/auth/invites',
    accessToken: input.accessToken,
    body: { email: input.email, ...input.body },
  });
  return { status: response.status, body: response.body };
}

test('five member invitations succeed, the sixth is refused, and a revoked row still counts', async () => {
  const service = await startWithMemberInvites();
  try {
    const member = await service.signupThroughInvite({ email: 'anna@example.org' });
    const accessToken = member.tokens.accessToken;

    for (let index = 0; index < 5; index += 1) {
      const accepted = await memberMint(service, { accessToken, email: `friend-${index}@example.org` });
      assert.equal(accepted.status, 202, `invitation ${index + 1} must be accepted`);
    }

    const sixth = await memberMint(service, { accessToken, email: 'one-too-many@example.org' });
    assert.equal(sixth.status, 403);
    assert.deepEqual(sixth.body, { error: 'member-invite-cap-reached' });

    // Five rows carry the account and each carries the instance's allowance.
    const caused = await database.db
      .select()
      .from(signupInvites)
      .where(eq(signupInvites.invitedByAccountId, member.account.id));
    assert.equal(caused.length, 5);
    for (const row of caused) {
      assert.equal(row.dailyAiLimit, MEMBER_INVITE_POLICY.dailyAiLimit);
      assert.equal(row.role, 'member');
    }

    // A WITHDRAWN INVITATION DOES NOT GIVE THE ALLOWANCE BACK. The cap is on
    // letters caused, not on letters that worked, so this is the move a member
    // would make to recycle their five.
    const withdrawn = caused[0];
    assert.ok(withdrawn);
    await database.db
      .update(signupInvites)
      .set({ revokedAt: new Date() })
      .where(eq(signupInvites.id, withdrawn.id));
    const afterRevoke = await memberMint(service, { accessToken, email: 'one-too-many@example.org' });
    assert.equal(afterRevoke.status, 403, 'a revoked row must still count towards the cap');

    // THE CONTROL: another member's first invitation is accepted, so the
    // refusals above are the cap and not a broken route.
    const other = await service.signupThroughInvite({ email: 'clara@example.org' });
    const accepted = await memberMint(service, {
      accessToken: other.tokens.accessToken,
      email: 'somebody@example.org',
    });
    assert.equal(accepted.status, 202);
  } finally {
    await service.close();
  }
});

test('a new address, a pending invitation and an existing account get the same response, and the admin mint is the control that does not', async () => {
  const service = await startWithMemberInvites();
  try {
    const member = await service.signupThroughInvite({ email: 'anna@example.org' });
    const accessToken = member.tokens.accessToken;
    // A person who is already here. The member is about to type their address
    // and must not learn that from the answer.
    await service.signupThroughInvite({ email: 'boris@example.org' });

    const fresh = await memberMint(service, { accessToken, email: 'nobody@example.org' });
    const pending = await memberMint(service, { accessToken, email: 'nobody@example.org' });
    const taken = await memberMint(service, { accessToken, email: 'boris@example.org' });

    // INDISTINGUISHABLE: the same status and the same bytes for all three. A
    // status-only assertion would pass a body that named the difference.
    for (const outcome of [fresh, pending, taken]) {
      assert.equal(outcome.status, 202);
    }
    assert.equal(JSON.stringify(fresh.body), JSON.stringify(pending.body));
    assert.equal(JSON.stringify(fresh.body), JSON.stringify(taken.body));
    assert.deepEqual(fresh.body, {});

    // THE CONTROL, AND IT IS THE POINT OF THIS TEST. The operator's own door
    // DOES confirm that the address holds an account, because it is behind
    // their credential. If this 409 stopped happening, the three-way match
    // above would be satisfied by a service that answered 202 to everything
    // and never checked anything.
    const asOperator = await service.request<{ error: string }>({
      method: 'POST',
      path: '/v1/admin/invites',
      adminToken: MEMBER_SUITE_ADMIN_TOKEN,
      body: { email: 'boris@example.org' },
    });
    assert.equal(asOperator.status, 409);
    assert.match(asOperator.body.error, /already exists/);

    // And the member's own letter went to the right person on each branch: two
    // invitations for the new address, one note for the address that has an
    // account, and no invitation for it.
    assert.equal(service.mailer.invites.length, 2);
    assert.deepEqual(
      service.mailer.accountNotices.map((notice) => notice.email),
      ['boris@example.org'],
    );
  } finally {
    await service.close();
  }
});

test('a re-invite after a self-delete is not a fresh allowance, while an admin mint for that address still is', async () => {
  const service = await startWithMemberInvites();
  try {
    const member = await service.signupThroughInvite({ email: 'anna@example.org' });
    assert.equal((await memberMint(service, { accessToken: member.tokens.accessToken, email: 'boris@example.org' })).status, 202);

    // The friend redeems it, then deletes their own account. The invite row
    // survives with its address and its redemption instant, because both
    // foreign keys on it are `ON DELETE SET NULL`.
    const inviteToken = service.mailer.invites.at(-1)?.inviteToken ?? '';
    const friend = await service.request<{ tokens: { accessToken: string } }>({
      method: 'POST',
      path: '/v1/auth/signup',
      body: signupBody(inviteToken),
    });
    assert.equal(friend.status, 201);
    const deleted = await service.request({
      method: 'POST',
      path: '/v1/auth/delete',
      accessToken: friend.body.tokens.accessToken,
      body: { authHash: sampleAuthHash(11) },
    });
    assert.equal(deleted.status, 204);

    const surviving = await database.db.select().from(signupInvites).where(eq(signupInvites.email, 'boris@example.org'));
    assert.equal(surviving.length, 1);
    assert.notEqual(surviving[0]?.redeemedAt, null, 'the redemption instant must survive the account');

    // A DIFFERENT member now invites the same address. No second member invite
    // is minted and no letter goes out, and the caller is told nothing.
    const friendOfAFriend = await service.signupThroughInvite({ email: 'clara@example.org' });
    const lettersBefore = service.mailer.invites.length;
    const withheld = await memberMint(service, {
      accessToken: friendOfAFriend.tokens.accessToken,
      email: 'boris@example.org',
    });
    assert.equal(withheld.status, 202, 'the caller must not learn that the address is spent');
    assert.equal(service.mailer.invites.length, lettersBefore, 'no second letter may go out');
    assert.equal(
      (await database.db.select().from(signupInvites).where(eq(signupInvites.email, 'boris@example.org'))).length,
      1,
      'no second member invite may exist for that address',
    );

    // THE CONTROL: the operator is exempt, so their mint for the same address
    // does produce a row. Without it this test would pass against a service
    // that had simply stopped minting anything.
    const asOperator = await service.request({
      method: 'POST',
      path: '/v1/admin/invites',
      adminToken: MEMBER_SUITE_ADMIN_TOKEN,
      body: { email: 'boris@example.org' },
    });
    assert.equal(asOperator.status, 201);
    assert.equal(
      (await database.db.select().from(signupInvites).where(eq(signupInvites.email, 'boris@example.org'))).length,
      2,
    );
  } finally {
    await service.close();
  }
});

test('a redeemed member invitation writes allowanceExpiresAt as redemption plus the instance days', async () => {
  const service = await startWithMemberInvites();
  try {
    const member = await service.signupThroughInvite({ email: 'anna@example.org' });
    await memberMint(service, { accessToken: member.tokens.accessToken, email: 'boris@example.org' });

    const inviteToken = service.mailer.invites.at(-1)?.inviteToken ?? '';
    const friend = await service.request<{ account: { id: number; allowanceExpiresAt: string | null } }>({
      method: 'POST',
      path: '/v1/auth/signup',
      body: signupBody(inviteToken),
    });
    assert.equal(friend.status, 201);

    // AS A DATE, not merely as non-null. `redeemedAt` is the instant the
    // redemption stamped on the invite row, and the account's expiry has to be
    // exactly that instant plus the instance's days: a bug that used the
    // invite's own `expiresAt`, or the wrong unit, would still be non-null.
    const [row] = await database.db.select().from(signupInvites).where(eq(signupInvites.email, 'boris@example.org'));
    assert.ok(row?.redeemedAt);
    const expected = new Date(row.redeemedAt.getTime() + MEMBER_INVITE_POLICY.allowanceDays * 24 * 60 * 60 * 1000);
    assert.equal(friend.body.account.allowanceExpiresAt, expected.toISOString());

    // And the row in the database says the same thing the response did.
    const [account] = await database.db.select().from(accounts).where(eq(accounts.id, friend.body.account.id));
    assert.equal(account?.allowanceExpiresAt?.toISOString(), expected.toISOString());

    // THE CONTROL: an OPERATOR'S invite writes no expiry at all, so the value
    // above is the member-invite rule and not something every signup gets.
    const operatorSignup = await service.signupThroughInvite({ email: 'clara@example.org' });
    assert.equal(operatorSignup.account.allowanceExpiresAt, null);
  } finally {
    await service.close();
  }
});

test('a dailyAiLimit in the member mint body is ignored, so the allowance is not the caller’s to choose', async () => {
  const service = await startWithMemberInvites();
  try {
    const member = await service.signupThroughInvite({ email: 'anna@example.org' });
    // Posted WITH the three fields the ADMIN mint reads off its body. They are
    // not refused, they are simply not read, which is the same answer a stale
    // client gets and a prober gets.
    const minted = await memberMint(service, {
      accessToken: member.tokens.accessToken,
      email: 'boris@example.org',
      body: { dailyAiLimit: 9_999, role: 'admin', expiresInDays: 30, displayName: 'Chosen By The Inviter' },
    });
    assert.equal(minted.status, 202);

    const inviteToken = service.mailer.invites.at(-1)?.inviteToken ?? '';
    const friend = await service.request<{ account: { role: string; dailyAiLimit: number; displayName: string | null } }>({
      method: 'POST',
      path: '/v1/auth/signup',
      body: signupBody(inviteToken),
    });
    assert.equal(friend.status, 201);
    assert.equal(friend.body.account.dailyAiLimit, MEMBER_INVITE_POLICY.dailyAiLimit);
    assert.equal(friend.body.account.role, 'member', 'a member cannot mint an administrator');

    // THE CONTROL: the operator's door DOES read those fields, so the equality
    // above is this route ignoring them rather than the whole service doing so.
    const asOperator = await service.request<{ invite: { dailyAiLimit: number; role: string } }>({
      method: 'POST',
      path: '/v1/admin/invites',
      adminToken: MEMBER_SUITE_ADMIN_TOKEN,
      body: { email: 'clara@example.org', dailyAiLimit: 200, role: 'admin' },
    });
    assert.equal(asOperator.status, 201);
    assert.equal(asOperator.body.invite.dailyAiLimit, 200);
    assert.equal(asOperator.body.invite.role, 'admin');
  } finally {
    await service.close();
  }
});

test('invitesLeft counts down on the caller’s own account view, and the operator sees the same number', async () => {
  const service = await startWithMemberInvites();
  try {
    const member = await service.signupThroughInvite({ email: 'anna@example.org' });
    const accessToken = member.tokens.accessToken;
    assert.equal(member.account.invitesLeft, 5);

    await memberMint(service, { accessToken, email: 'boris@example.org' });
    const own = await service.request<{ account: { invitesLeft: number | null } }>({
      method: 'GET',
      path: '/v1/auth/account',
      accessToken,
    });
    assert.equal(own.body.account.invitesLeft, 4);

    // THE OPERATOR'S CONSOLE READS THE SAME NUMBER, through a different store
    // and a different query. Two counts that could disagree would be an
    // operator acting on a figure the route does not enforce.
    const asOperator = await service.request<{ account: { invitesLeft: number | null } }>({
      method: 'GET',
      path: `/v1/admin/accounts/${member.account.id}`,
      adminToken: MEMBER_SUITE_ADMIN_TOKEN,
    });
    assert.equal(asOperator.status, 200);
    assert.equal(asOperator.body.account.invitesLeft, 4);

    // AND `null` FOR AN ADMINISTRATOR, never `0`: they have used none, because
    // their own door is exempt from the cap.
    const operatorAccount = await service.signupThroughInvite({ email: 'operator@example.org', role: 'admin' });
    assert.equal(operatorAccount.account.invitesLeft, null);
  } finally {
    await service.close();
  }
});
