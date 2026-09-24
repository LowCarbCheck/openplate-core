/**
 * The one question the one mailbox, one trial rule asks (M253): did this
 * mailbox already have a trial?
 *
 * TWO PLACES CAN SAY YES, and both are keyed on the same HMAC
 * (`accounts/trial-address.ts`), never on an address:
 *  - a REDEEMED invite row whose `trial_key` is this hash and whose
 *    `trial_scans` is above zero: a live account, possibly under another
 *    spelling of the same mailbox;
 *  - a row in `trial_address_hashes`: a deleted account that held a trial.
 *
 * ONE FUNCTION, READ BY THE MINT (`db/invite-store.ts`), THE REDEMPTION AND
 * THE LAPSED-TRIAL GRANT (`db/account-store.ts`), so the three doors cannot
 * disagree about who already had theirs.
 *
 * THE TWO DOORS THAT GRANT A TRIAL TAKE {@link lockTrialMailbox} FIRST
 * (M256/02). The question above is a read, and two transactions redeeming
 * two spellings of one mailbox at the same moment would both read "no" before
 * either committed. The lock makes the second one wait for the first to
 * commit, and its read then sees the first one's trial. The mint does not
 * take it: a mint grants nothing, and the redemption asks again under the
 * lock.
 */
import { and, eq, gt, isNotNull, ne, sql } from 'drizzle-orm';
import type { Database } from './client.js';
import { signupInvites, trialAddressHashes } from './schema.js';

/** A transaction handle, as drizzle hands one to a `db.transaction` callback. */
type Transaction = Parameters<Parameters<Database['transaction']>[0]>[0];

/**
 * The advisory-lock namespace for the one mailbox, one trial rule. Postgres
 * advisory locks share ONE space per database, so the first argument keeps
 * this lock apart from the feedback store's (`feedback/feedback-store.ts`).
 * The value is arbitrary and only has to stay put.
 */
const TRIAL_MAILBOX_LOCK_NAMESPACE = 256_002;

/**
 * Holds the mailbox's trial lock until the transaction ends (M256/02).
 *
 * TRANSACTION-SCOPED, so there is no unlock to forget: the commit or the
 * rollback releases it. `hashtext` folds the 64 hex characters into the lock's
 * 32-bit key; two mailboxes that fold to one key only wait for each other,
 * which costs a few milliseconds and never a wrong answer.
 *
 * TAKE IT BEFORE {@link mailboxHadTrial}, in the same transaction, on every
 * path that grants a trial. Under READ COMMITTED each statement reads what was
 * committed when it started, so the read after the lock sees a trial the
 * other transaction granted while this one waited.
 */
export async function lockTrialMailbox(tx: Transaction, input: { hash: string }): Promise<void> {
  await tx.execute(sql`select pg_advisory_xact_lock(${TRIAL_MAILBOX_LOCK_NAMESPACE}, hashtext(${input.hash}))`);
}

export async function mailboxHadTrial(
  executor: Database | Transaction,
  input: { hash: string; exceptInviteId?: number },
): Promise<boolean> {
  const redeemed = await executor
    .select({ id: signupInvites.id })
    .from(signupInvites)
    .where(
      and(
        eq(signupInvites.trialKey, input.hash),
        isNotNull(signupInvites.redeemedAt),
        gt(signupInvites.trialScans, 0),
        input.exceptInviteId === undefined ? undefined : ne(signupInvites.id, input.exceptInviteId),
      ),
    )
    .limit(1);
  if (redeemed.length > 0) return true;

  const deleted = await executor
    .select({ hash: trialAddressHashes.hash })
    .from(trialAddressHashes)
    .where(eq(trialAddressHashes.hash, input.hash))
    .limit(1);
  return deleted.length > 0;
}
