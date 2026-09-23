/**
 * `POST /v1/auth/invites`, the member mint (M212), DB-free, against
 * `fake-account-store.ts` and `fake-invite-store.ts`.
 *
 * The properties asserted here are the ones that are decisions rather than
 * database guarantees:
 *
 *  - the response is the SAME for a new address, an address that already has a
 *    pending invitation, and an address that already holds an account, so a
 *    member cannot learn who else is on the instance;
 *  - the address that already holds an account gets the NOTE and no invitation,
 *    which is what stops the indistinguishable `202` from silently swallowing
 *    the letter;
 *  - the terms are the instance's: the allowance comes from the policy, and a
 *    `dailyAiLimit` in the body is not read;
 *  - the cap is the instance's `MEMBER_INVITE_LIFETIME_CAP` and defaults to
 *    five, withdrawn invitations count towards it, and an administrator is
 *    exempt;
 *  - an address that already redeemed a member-caused invitation gets no second
 *    one, and is still told `202`.
 *
 * EVERY ABSENCE HERE HAS A CONTROL. "No invitation was sent" is only meaningful
 * beside a case that sends one, and "the sixth is refused" only beside a fifth
 * that is not, so each test that asserts a refusal or a silence also exercises
 * the branch that does the opposite.
 *
 * `tests/integration/signup-invites.test.ts` carries what only Postgres can
 * answer: the cap counted over real rows, the allowance expiry written at
 * redemption, and the admin mint's `409` for the same address as the control on
 * the indistinguishability claim.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  handleGetAccount,
  handleMintMemberInvite,
  type AuthContext,
  type AuthOutcome,
} from '../../src/accounts/auth-handlers.js';
import {
  DEFAULT_MEMBER_INVITE_LIFETIME_CAP,
  MEMBER_INVITE_CAP_REACHED,
  MEMBER_INVITES_NEED_A_PLAN,
} from '../../src/accounts/member-invites.js';
import { createAuthFixture, type AuthFixture } from './auth-context-fixture.js';
import { createFakeInviteStore, type FakeInviteStore } from './fake-invite-store.js';
import type { JsonObject } from '../../src/lib/json.js';

const MEMBER_EMAIL = 'anna@example.org';
const FRIEND_EMAIL = 'boris@example.org';

/**
 * What this instance says an invitation is worth, and how many one member may
 * cause. No value here is readable or writable by a caller.
 *
 * `lifetimeCap` IS THE DEFAULT, not the constant the handler reads. Since M228
 * the cap is `MEMBER_INVITE_LIFETIME_CAP` and it arrives on this policy, so a
 * test naming a different one is the only thing that changes the count. The
 * cap-of-two test below does exactly that.
 */
const POLICY = { dailyAiLimit: 50, allowanceDays: 30, lifetimeCap: DEFAULT_MEMBER_INVITE_LIFETIME_CAP };

interface MemberInviteFixture {
  fixture: AuthFixture;
  invites: FakeInviteStore;
  ctx: AuthContext;
}

/**
 * An instance WITH member invites on. The surface is attached to the context
 * the same way `main.ts` attaches it: the operator's own invite store, plus the
 * two instance settings.
 */
function withMemberInvites(): MemberInviteFixture {
  const fixture = createAuthFixture();
  const invites = createFakeInviteStore();
  fixture.ctx.memberInvites = { invites, policy: POLICY };
  return { fixture, invites, ctx: fixture.ctx };
}

async function seedMember(fixture: AuthFixture, email = MEMBER_EMAIL): Promise<number> {
  const account = await fixture.store.seedAccount({ email });
  return account.id;
}

async function seedAdmin(fixture: AuthFixture, email = 'operator@example.org'): Promise<number> {
  const account = await fixture.store.seedAccount({ email, role: 'admin' });
  return account.id;
}

function mint(
  ctx: AuthContext,
  input: { accountId: number; email: string; body?: JsonObject },
): Promise<AuthOutcome<Record<string, never>>> {
  return handleMintMemberInvite({ accountId: input.accountId, body: { email: input.email, ...input.body } }, ctx);
}

// ── The response says nothing ──────────────────────────────────────────────

test('a new address, a pending invitation and an existing account are ONE response', async () => {
  const { fixture, invites, ctx } = withMemberInvites();
  const accountId = await seedMember(fixture);

  // 1. An address nobody has touched.
  const fresh = await mint(ctx, { accountId, email: FRIEND_EMAIL });
  // 2. The SAME address, which now has a live invitation.
  const pending = await mint(ctx, { accountId, email: FRIEND_EMAIL });
  // 3. An address that already holds an account. The fake store refuses a mint
  //    for it exactly as the real transaction does.
  invites.claimEmail('claimed@example.org');
  const taken = await mint(ctx, { accountId, email: 'claimed@example.org' });

  for (const outcome of [fresh, pending, taken]) {
    assert.equal(outcome.status, 'accepted');
  }
  // BYTE-IDENTICAL, not merely equal in status. A helpful field added to one
  // branch is the whole defect this endpoint exists to avoid, and it would pass
  // a status-only assertion.
  const serialized = [fresh, pending, taken].map((outcome) => JSON.stringify(outcome));
  assert.equal(serialized[0], serialized[1], 'a pending invitation must be indistinguishable from a new address');
  assert.equal(serialized[0], serialized[2], 'an existing account must be indistinguishable from a new address');

  // THE CONTROL for the assertion above: the same handler CAN answer something
  // else, so the three matching is a property of these branches and not of a
  // function that only ever returns one value.
  const capped = await refuseWithCap(ctx, fixture);
  assert.notEqual(JSON.stringify(capped), serialized[0]);
});

/** Spends one account's whole allowance and returns the refusal, for use as a control. */
async function refuseWithCap(ctx: AuthContext, fixture: AuthFixture): Promise<AuthOutcome<Record<string, never>>> {
  const accountId = await seedMember(fixture, 'spender@example.org');
  for (let index = 0; index < POLICY.lifetimeCap; index += 1) {
    await mint(ctx, { accountId, email: `spent-${index}@example.org` });
  }
  return mint(ctx, { accountId, email: 'one-too-many@example.org' });
}

test('the existing-account address gets the note and NO invitation, and a new one gets the reverse', async () => {
  const { fixture, invites, ctx } = withMemberInvites();
  const accountId = await seedMember(fixture);

  invites.claimEmail('claimed@example.org');
  await mint(ctx, { accountId, email: 'claimed@example.org' });

  assert.equal(fixture.mailer.invites.length, 0, 'an address that already has an account must get no invitation');
  assert.deepEqual(fixture.mailer.accountNotices, [{ email: 'claimed@example.org' }]);

  // THE CONTROL. Without it, a handler that sent nothing at all on either
  // branch would pass the two assertions above.
  await mint(ctx, { accountId, email: FRIEND_EMAIL });
  assert.equal(fixture.mailer.accountNotices.length, 1, 'a new address must get no note');
  assert.equal(fixture.mailer.invites.length, 1);
  assert.equal(fixture.mailer.invites[0]?.email, FRIEND_EMAIL);
});

// ── The terms are the instance's ───────────────────────────────────────────

test('the invitation carries the instance allowance, and a dailyAiLimit in the body is not read', async () => {
  const { fixture, invites, ctx } = withMemberInvites();
  const accountId = await seedMember(fixture);

  // Posted WITH the fields the admin mint accepts. They are ignored, not
  // refused: the same answer a stale client gets and a prober gets.
  const outcome = await mint(ctx, {
    accountId,
    email: FRIEND_EMAIL,
    body: { dailyAiLimit: 9_999, role: 'admin', expiresInDays: 30, displayName: 'Chosen By The Inviter' },
  });
  assert.equal(outcome.status, 'accepted');

  const row = invites.rows()[0];
  assert.equal(row?.dailyAiLimit, POLICY.dailyAiLimit, 'the allowance is the instance setting, not the caller');
  assert.equal(row?.role, 'member', 'a member cannot mint an administrator');
  assert.equal(row?.displayName, null, 'a member does not name the person they invite');
});

// ── The cap ────────────────────────────────────────────────────────────────

test('five invitations succeed and the sixth is refused with its own code', async () => {
  const { fixture, invites, ctx } = withMemberInvites();
  const accountId = await seedMember(fixture);

  for (let index = 0; index < POLICY.lifetimeCap; index += 1) {
    const outcome = await mint(ctx, { accountId, email: `friend-${index}@example.org` });
    assert.equal(outcome.status, 'accepted', `invitation ${index + 1} must be accepted`);
  }
  assert.equal(invites.rows().length, POLICY.lifetimeCap);

  const sixth = await mint(ctx, { accountId, email: 'one-too-many@example.org' });
  assert.equal(sixth.status, 'forbidden');
  assert.equal(sixth.status === 'forbidden' ? sixth.reason : '', MEMBER_INVITE_CAP_REACHED);
  // The refusal is a refusal: no sixth row, and no sixth letter.
  assert.equal(invites.rows().length, POLICY.lifetimeCap);
  assert.equal(fixture.mailer.invites.length, POLICY.lifetimeCap);

  // ANOTHER MEMBER IS UNAFFECTED, which is what makes the count per account
  // rather than per instance.
  const other = await seedMember(fixture, 'clara@example.org');
  assert.equal((await mint(ctx, { accountId: other, email: 'someone@example.org' })).status, 'accepted');
});

test('a withdrawn invitation still counts, so the five cannot be recycled', async () => {
  const { fixture, invites, ctx } = withMemberInvites();
  const accountId = await seedMember(fixture);

  for (let index = 0; index < POLICY.lifetimeCap; index += 1) {
    await mint(ctx, { accountId, email: `friend-${index}@example.org` });
  }
  // The operator withdraws one, which is the move a member would ask for if
  // the count were of live invitations.
  const first = invites.rows()[0];
  assert.ok(first !== undefined);
  assert.equal(await invites.revoke({ inviteId: first.id, revokedAt: fixture.now() }), true);

  const afterRevoke = await mint(ctx, { accountId, email: 'one-too-many@example.org' });
  assert.equal(afterRevoke.status, 'forbidden', 'a withdrawn invitation must not give an allowance back');
});

test('an administrator is exempt from the cap', async () => {
  const { fixture, ctx } = withMemberInvites();
  const accountId = await seedAdmin(fixture);

  for (let index = 0; index < POLICY.lifetimeCap + 2; index += 1) {
    const outcome = await mint(ctx, { accountId, email: `invited-${index}@example.org` });
    assert.equal(outcome.status, 'accepted', `an operator's invitation ${index + 1} must be accepted`);
  }
});

test('the cap is the instance policy, so two is two and the third is the same refusal', async () => {
  // A MANAGED INSTANCE WHOSE ADMINISTRATOR PAYS FOR THE PROVIDER KEY, which is
  // the deployment M228 made the cap configurable for.
  const fixture = createAuthFixture();
  const invites = createFakeInviteStore();
  fixture.ctx.memberInvites = { invites, policy: { ...POLICY, lifetimeCap: 2 } };
  const accountId = await seedMember(fixture);

  // The account view reports the instance's number, not the default.
  assert.equal(await invitesLeftFor(fixture.ctx, accountId), 2);

  for (let index = 0; index < 2; index += 1) {
    const outcome = await mint(fixture.ctx, { accountId, email: `friend-${index}@example.org` });
    assert.equal(outcome.status, 'accepted', `invitation ${index + 1} must be accepted under a cap of two`);
  }
  assert.equal(await invitesLeftFor(fixture.ctx, accountId), 0);

  // THE SAME REFUSAL the sixth gets under the default cap, through the same
  // handler. A cap that was enforced anywhere but here would let this third
  // one through while the count above still read zero.
  const third = await mint(fixture.ctx, { accountId, email: 'one-too-many@example.org' });
  assert.equal(third.status, 'forbidden');
  assert.equal(third.status === 'forbidden' ? third.reason : '', MEMBER_INVITE_CAP_REACHED);
  assert.equal(invites.rows().length, 2, 'the refusal must leave no third row');
  assert.equal(fixture.mailer.invites.length, 2, 'the refusal must send no third letter');

  // THE CONTROL: a fresh account on the DEFAULT instance takes a third, so the
  // refusal above is the configured cap and not a broken handler.
  const byDefault = withMemberInvites();
  const other = await seedMember(byDefault.fixture);
  for (let index = 0; index < 2; index += 1) {
    await mint(byDefault.ctx, { accountId: other, email: `other-${index}@example.org` });
  }
  assert.equal((await mint(byDefault.ctx, { accountId: other, email: 'third@example.org' })).status, 'accepted');
});

// ── The re-invite rule ─────────────────────────────────────────────────────

test('an address that already spent a member invitation gets no second one, and is told nothing', async () => {
  const { fixture, invites, ctx } = withMemberInvites();
  const accountId = await seedMember(fixture);

  await mint(ctx, { accountId, email: FRIEND_EMAIL });
  const spent = invites.rows()[0];
  assert.ok(spent !== undefined);
  // Redeemed, and then the account it produced is gone: the row survives with
  // its address and its redemption instant, which is the state the rule stands
  // on.
  invites.markRedeemed(spent.id, 4242);

  // A DIFFERENT member, so this is not a per-account memory.
  const friendOfAFriend = await seedMember(fixture, 'clara@example.org');
  const second = await mint(ctx, { accountId: friendOfAFriend, email: FRIEND_EMAIL });

  assert.equal(second.status, 'accepted', 'the caller must not learn that the address is spent');
  assert.equal(invites.rows().length, 1, 'no second invitation may exist for that address');
  assert.equal(fixture.mailer.invites.length, 1, 'no second letter may go out');
  // AND IT DID NOT COST THE CALLER ANYTHING EITHER: a withheld invitation is
  // not one of their five.
  assert.equal(await invites.countMintedBy({ accountId: friendOfAFriend }), 0);

  // THE CONTROL: the same caller CAN still invite somebody else, so the silence
  // above is about this address and not about this member.
  assert.equal((await mint(ctx, { accountId: friendOfAFriend, email: 'nobody@example.org' })).status, 'accepted');
  assert.equal(fixture.mailer.invites.length, 2);
});

test('an operator-minted invitation is not a member one, so that address can still be invited', async () => {
  const { fixture, invites, ctx } = withMemberInvites();
  const accountId = await seedMember(fixture);

  // The operator's own mint: no inviting account on the row.
  const operatorMint = await invites.mint({
    email: FRIEND_EMAIL,
    displayName: null,
    role: 'member',
    dailyAiLimit: 0,
    expiresAt: new Date(fixture.now().getTime() + 60_000),
    now: fixture.now(),
    invitedByAccountId: null,
    source: null,
    trialScans: null,
  });
  assert.ok(operatorMint.ok);
  invites.markRedeemed(operatorMint.minted.invite.id, 4242);

  await mint(ctx, { accountId, email: FRIEND_EMAIL });
  assert.equal(fixture.mailer.invites.length, 1, 'the rule must not withhold an invitation over an operator mint');
});

// ── invitesLeft ────────────────────────────────────────────────────────────

test('invitesLeft counts down for a member, and is null for an administrator', async () => {
  const { fixture, ctx } = withMemberInvites();
  const memberId = await seedMember(fixture);
  const adminId = await seedAdmin(fixture);

  assert.equal(await invitesLeftFor(ctx, memberId), POLICY.lifetimeCap);
  await mint(ctx, { accountId: memberId, email: FRIEND_EMAIL });
  assert.equal(await invitesLeftFor(ctx, memberId), POLICY.lifetimeCap - 1);

  // `null`, NOT `0`, and this is the whole point of the field: an operator has
  // used none of anything, and `0` would read as "you have used them all".
  assert.equal(await invitesLeftFor(ctx, adminId), null);
});

test('invitesLeft is null on an instance where members cannot invite anybody', async () => {
  // No surface at all, which is what every deployment runs until an operator
  // sets both settings.
  const fixture = createAuthFixture();
  const memberId = await seedMember(fixture);
  assert.equal(await invitesLeftFor(fixture.ctx, memberId), null);

  // THE CONTROL: the same account on an instance with the feature on reports a
  // number, so the `null` above is the flag and not a broken read.
  const withFeature = withMemberInvites();
  const other = await seedMember(withFeature.fixture);
  assert.equal(await invitesLeftFor(withFeature.ctx, other), POLICY.lifetimeCap);
});

async function invitesLeftFor(ctx: AuthContext, accountId: number): Promise<number | null> {
  const outcome = await handleGetAccount({ accountId }, ctx);
  if (outcome.status !== 'ok') throw new Error(`expected an account view, got ${outcome.status}`);
  return outcome.body.account.invitesLeft;
}

// ── An unpaid scan trial invites nobody (M253/11) ──────────────────────────

const DAY_MS = 24 * 60 * 60 * 1000;

/** Turns a seeded member into a scan trial with no date, which is what every trial door writes. */
async function makeTrial(fixture: AuthFixture, accountId: number): Promise<void> {
  const updated = await fixture.store.updateStanding({ accountId, trialScans: 10, allowanceExpiresAt: null });
  if (updated === null) throw new Error('the seeded account vanished');
}

async function accountViewFor(ctx: AuthContext, accountId: number) {
  const outcome = await handleGetAccount({ accountId }, ctx);
  if (outcome.status !== 'ok') throw new Error(`expected an account view, got ${outcome.status}`);
  return outcome.body.account;
}

test('an unpaid scan trial is refused with its own code, and the same account after a paid date is accepted', async () => {
  const { fixture, invites, ctx } = withMemberInvites();
  const accountId = await seedMember(fixture);
  await makeTrial(fixture, accountId);

  const refused = await mint(ctx, { accountId, email: FRIEND_EMAIL });
  assert.equal(refused.status, 'forbidden');
  assert.equal(refused.status === 'forbidden' ? refused.reason : '', MEMBER_INVITES_NEED_A_PLAN);
  // A refusal is a refusal: no row, no letter, and nothing counted against the cap.
  assert.equal(invites.rows().length, 0);
  assert.equal(fixture.mailer.invites.length, 0);
  const unpaid = await accountViewFor(ctx, accountId);
  assert.equal(unpaid.invitesLeft, 0);
  assert.equal(unpaid.invitesNeedAPlan, true);

  // THE CONTROL: the biller writes a date in the future on payment and leaves
  // `trialScans` alone. The same account, the same address, is now accepted.
  await fixture.store.updateStanding({
    accountId,
    allowanceExpiresAt: new Date(fixture.now().getTime() + 30 * DAY_MS),
  });
  const accepted = await mint(ctx, { accountId, email: FRIEND_EMAIL });
  assert.equal(accepted.status, 'accepted');
  assert.equal(invites.rows().length, 1);
  const paid = await accountViewFor(ctx, accountId);
  assert.equal(paid.trialScans?.granted, 10, 'a paying account still carries its trial');
  assert.equal(paid.invitesLeft, POLICY.lifetimeCap - 1);
  assert.equal(paid.invitesNeedAPlan, false);
});

test('a paid date that has passed is no plan, so the refusal comes back', async () => {
  const { fixture, ctx } = withMemberInvites();
  const accountId = await seedMember(fixture);
  await makeTrial(fixture, accountId);
  await fixture.store.updateStanding({ accountId, allowanceExpiresAt: new Date(fixture.now().getTime() + DAY_MS) });
  assert.equal((await mint(ctx, { accountId, email: FRIEND_EMAIL })).status, 'accepted');

  fixture.advance(DAY_MS);
  const lapsed = await mint(ctx, { accountId, email: 'clara@example.org' });
  assert.equal(lapsed.status === 'forbidden' ? lapsed.reason : lapsed.status, MEMBER_INVITES_NEED_A_PLAN);
  assert.equal((await accountViewFor(ctx, accountId)).invitesNeedAPlan, true);
});

test('a standing member and an administrator are unaffected by the plan rule', async () => {
  const { fixture, ctx } = withMemberInvites();
  const memberId = await seedMember(fixture);
  const adminId = await seedAdmin(fixture);
  // An administrator with a trial is still exempt: the rule is about members.
  await makeTrial(fixture, adminId);

  assert.equal((await mint(ctx, { accountId: memberId, email: FRIEND_EMAIL })).status, 'accepted');
  assert.equal((await mint(ctx, { accountId: adminId, email: 'clara@example.org' })).status, 'accepted');
  const member = await accountViewFor(ctx, memberId);
  assert.equal(member.invitesLeft, POLICY.lifetimeCap - 1);
  assert.equal(member.invitesNeedAPlan, false);
  const admin = await accountViewFor(ctx, adminId);
  assert.equal(admin.invitesLeft, null);
  assert.equal(admin.invitesNeedAPlan, false);
});

test('a spent allowance hears the cap, not the plan, because paying would not help', async () => {
  const { fixture, ctx } = withMemberInvites();
  const accountId = await seedMember(fixture);
  for (let index = 0; index < POLICY.lifetimeCap; index += 1) {
    await mint(ctx, { accountId, email: `friend-${index}@example.org` });
  }
  await makeTrial(fixture, accountId);

  const outcome = await mint(ctx, { accountId, email: 'one-too-many@example.org' });
  assert.equal(outcome.status === 'forbidden' ? outcome.reason : outcome.status, MEMBER_INVITE_CAP_REACHED);
  const view = await accountViewFor(ctx, accountId);
  assert.equal(view.invitesLeft, 0);
  assert.equal(view.invitesNeedAPlan, false);
});

test('invitesNeedAPlan is false on an instance where members cannot invite anybody, trial or not', async () => {
  const fixture = createAuthFixture();
  const accountId = await seedMember(fixture);
  await makeTrial(fixture, accountId);
  const view = await accountViewFor(fixture.ctx, accountId);
  assert.equal(view.invitesLeft, null);
  assert.equal(view.invitesNeedAPlan, false);
});

// ── The dark instance ──────────────────────────────────────────────────────

test('the handler refuses on an instance with the feature off, whatever route reaches it', async () => {
  // The route is not registered there at all (`register-auth-routes.ts`), so
  // this is defence in depth. It is asserted because "the mount decides" is
  // exactly the kind of claim that survives a refactor that moves the mount.
  const fixture = createAuthFixture();
  const accountId = await seedMember(fixture);
  const outcome = await mint(fixture.ctx, { accountId, email: FRIEND_EMAIL });
  assert.equal(outcome.status, 'not-found');
  assert.equal(fixture.mailer.invites.length, 0);
});

test('a malformed address is refused, and refusing it discloses nothing about any account', async () => {
  const { fixture, ctx } = withMemberInvites();
  const accountId = await seedMember(fixture);

  const outcome = await mint(ctx, { accountId, email: 'not-an-address' });
  assert.equal(outcome.status, 'invalid');
  assert.equal(fixture.mailer.invites.length, 0);
  assert.equal(fixture.mailer.accountNotices.length, 0);
});
