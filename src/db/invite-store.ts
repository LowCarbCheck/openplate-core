/**
 * Drizzle implementation of `InviteStore` — minting, listing and revoking
 * addressed signup invites on the operator's behalf.
 *
 * EVERY SELECT HERE NAMES ITS COLUMNS, for the reason `db/admin-store.ts`
 * gives at length: `token_hash` is the one column on this table that must
 * never reach a response, and the strongest way to guarantee that is never to
 * fetch it. A digest that was never read out of Postgres cannot be leaked by a
 * later edit to a mapper.
 *
 * The raw token exists in exactly one place, for the duration of one HTTP
 * response: the return value of `mint`. It is generated here, hashed here, and
 * the hash is what the row keeps.
 *
 * REVOKE IS A STAMP, NOT A DELETE, and only on unredeemed rows. A spent invite
 * is the audit record of an account's provenance; a withdrawn one is the
 * record that a letter went out and was taken back, which a missing row cannot
 * say.
 */
import { and, count, desc, eq, gt, isNotNull, isNull } from 'drizzle-orm';
import type {
  InviteStore,
  InviteSummary,
  MintInviteInput,
  MintInviteResult,
  MintedInvite,
  PendingInvite,
  ReissueInviteInput,
} from '../admin/invite-store.js';
import { generateSignupInviteToken } from '../lib/tokens.js';
import type { TrialAddressHasher } from '../accounts/trial-address.js';
import type { Database } from './client.js';
import { accounts, signupInvites, trialAddressHashes } from './schema.js';
import { mailboxHadTrial } from './trial-mailbox.js';

/** The columns an operator may see. `tokenHash` is deliberately absent from this list. */
const SUMMARY_COLUMNS = {
  id: signupInvites.id,
  email: signupInvites.email,
  displayName: signupInvites.displayName,
  role: signupInvites.role,
  dailyAiLimit: signupInvites.dailyAiLimit,
  trialScans: signupInvites.trialScans,
  createdAt: signupInvites.createdAt,
  expiresAt: signupInvites.expiresAt,
  redeemedAt: signupInvites.redeemedAt,
  revokedAt: signupInvites.revokedAt,
  redeemedAccountId: signupInvites.redeemedAccountId,
} as const;

/** What the store needs beyond a database. */
export interface DrizzleInviteStoreOptions {
  /**
   * The keyed mailbox hash (`TRIAL_ADDRESS_PEPPER`, M253), or `null`/absent
   * on an instance with no pepper. With it every new row carries the hash and
   * a trial mint checks it; without it `trial_key` stays `NULL`.
   */
  hashAddress?: TrialAddressHasher | null;
}

export function createDrizzleInviteStore(db: Database, options: DrizzleInviteStoreOptions = {}): InviteStore {
  const hashAddress = options.hashAddress ?? null;
  return {
    async mint(input: MintInviteInput): Promise<MintInviteResult> {
      // Same primitive the session tokens use: 256 bits of `randomBytes`,
      // stored only as a SHA-256 digest — plus the `si_` prefix that binds the
      // token to THIS service (see `lib/tokens.ts`).
      const token = generateSignupInviteToken();

      return await db.transaction(async (tx): Promise<MintInviteResult> => {
        // The address is checked INSIDE the transaction, so an account created
        // between the check and the insert cannot leave a live invite for an
        // address that already has one. There is no unique index that could
        // enforce this instead: the constraint spans two tables.
        const [existing] = await tx
          .select({ id: accounts.id })
          .from(accounts)
          .where(eq(accounts.email, input.email))
          .limit(1);
        if (existing) return { ok: false, reason: 'email-taken' };

        // Supersede first, insert second. The other order would need the new
        // row's id excluded from the update, and this way the window in which
        // two live invites exist is inside one transaction rather than on the
        // wire.
        await tx
          .update(signupInvites)
          .set({ revokedAt: input.now })
          .where(
            and(
              eq(signupInvites.email, input.email),
              isNull(signupInvites.redeemedAt),
              isNull(signupInvites.revokedAt),
            ),
          );

        // THE ONE MAILBOX, ONE TRIAL RULE, AT MINT (M253). A trial for a
        // mailbox that already had one is written as `0`: the person still
        // gets an account, and the app shows the plan offer at the first scan.
        const trialKey = hashAddress === null ? null : hashAddress(input.email);
        const trialScans =
          input.trialScans !== null &&
          input.trialScans > 0 &&
          trialKey !== null &&
          (await mailboxHadTrial(tx, { hash: trialKey }))
            ? 0
            : input.trialScans;

        const [row] = await tx
          .insert(signupInvites)
          .values({
            tokenHash: token.hash,
            email: input.email,
            displayName: input.displayName,
            role: input.role,
            dailyAiLimit: input.dailyAiLimit,
            trialScans,
            expiresAt: input.expiresAt,
            // `null` for an operator mint, which is what makes the admin door
            // exempt from the cap and from the re-invite rule (M212).
            invitedByAccountId: input.invitedByAccountId,
            // Which door, and the mailbox's keyed hash (M253). The hash is
            // derived HERE, from the same canonical address the row keeps, so
            // no caller can store a key that disagrees with its own address.
            source: input.source,
            trialKey,
          })
          .returning(SUMMARY_COLUMNS);
        if (!row) throw new Error('Failed to insert invite');

        return { ok: true, minted: { invite: row, token: token.raw } };
      });
    },

    async reissue(input: ReissueInviteInput): Promise<MintedInvite | null> {
      const token = generateSignupInviteToken();
      // ONE conditional UPDATE, so a resend races a redemption safely: if the
      // invite was spent between the operator clicking and this statement, the
      // predicate is false, nothing is written, and the caller gets `null`
      // rather than a fresh token for an account that already exists.
      const [row] = await db
        .update(signupInvites)
        .set({ tokenHash: token.hash, expiresAt: input.expiresAt })
        .where(
          and(eq(signupInvites.id, input.inviteId), isNull(signupInvites.redeemedAt), isNull(signupInvites.revokedAt)),
        )
        .returning(SUMMARY_COLUMNS);
      if (!row) return null;
      return { invite: row, token: token.raw };
    },

    async list(input: { limit: number; offset: number }): Promise<{ invites: InviteSummary[]; total: number }> {
      const invites = await db
        .select(SUMMARY_COLUMNS)
        .from(signupInvites)
        .orderBy(desc(signupInvites.createdAt))
        .limit(input.limit)
        .offset(input.offset);

      const [totals] = await db.select({ total: count() }).from(signupInvites);

      return { invites, total: totals?.total ?? 0 };
    },

    async revoke(input: { inviteId: number; revokedAt: Date }): Promise<boolean> {
      const revoked = await db
        .update(signupInvites)
        .set({ revokedAt: input.revokedAt })
        // `isNull(revokedAt)` as well as `isNull(redeemedAt)`: re-revoking keeps
        // the instant the capability actually died, which is the one an
        // operator would look for.
        .where(
          and(eq(signupInvites.id, input.inviteId), isNull(signupInvites.redeemedAt), isNull(signupInvites.revokedAt)),
        )
        .returning({ id: signupInvites.id });
      return revoked.length > 0;
    },

    async countMintedBy(input: { accountId: number }): Promise<number> {
      // EVERY row this account caused, with no lifecycle predicate at all:
      // revoked, expired and redeemed invitations count, because the cap is on
      // how many letters an account caused and not on how many worked. Adding
      // `isNull(revokedAt)` here would let a member recycle their five by
      // asking an operator to withdraw one.
      const [totals] = await db
        .select({ total: count() })
        .from(signupInvites)
        .where(eq(signupInvites.invitedByAccountId, input.accountId));
      return totals?.total ?? 0;
    },

    async hasRedeemedMemberInvite(input: { email: string }): Promise<boolean> {
      // REDEEMED AND MEMBER-CAUSED, both. A pending or revoked row says
      // nothing about whether this address ever had an allowance, and a row
      // with a NULL inviter is an operator's mint, which this rule never
      // withdraws.
      //
      // The account it produced may be long gone: both foreign keys on this
      // table are `ON DELETE SET NULL` and the row keeps its `email` and its
      // `redeemed_at`, so a self-delete plus a friend's re-invite is still
      // answered `true` here.
      const found = await db
        .select({ id: signupInvites.id })
        .from(signupInvites)
        .where(
          and(
            eq(signupInvites.email, input.email),
            isNotNull(signupInvites.redeemedAt),
            isNotNull(signupInvites.invitedByAccountId),
          ),
        )
        .limit(1);
      if (found.length > 0) return true;
      // A DELETED MAILBOX (M253). With a pepper the deletion scrubbed the
      // address from these rows and kept a keyed hash instead; that hash is
      // written only for an account that held a trial, which a member-caused
      // invite always was.
      if (hashAddress === null) return false;
      const deleted = await db
        .select({ hash: trialAddressHashes.hash })
        .from(trialAddressHashes)
        .where(eq(trialAddressHashes.hash, hashAddress(input.email)))
        .limit(1);
      return deleted.length > 0;
    },

    async findPendingInvite(input: { email: string; now: Date }): Promise<PendingInvite | null> {
      // The SAME three predicates a redemption applies, so "pending" here is
      // exactly "a letter somebody could still spend".
      const [row] = await db
        .select({ source: signupInvites.source })
        .from(signupInvites)
        .where(
          and(
            eq(signupInvites.email, input.email),
            isNull(signupInvites.redeemedAt),
            isNull(signupInvites.revokedAt),
            gt(signupInvites.expiresAt, input.now),
          ),
        )
        .limit(1);
      return row === undefined ? null : { source: row.source };
    },
  };
}
