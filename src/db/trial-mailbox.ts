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
 */
import { and, eq, gt, isNotNull, ne } from 'drizzle-orm';
import type { Database } from './client.js';
import { signupInvites, trialAddressHashes } from './schema.js';

/** A transaction handle, as drizzle hands one to a `db.transaction` callback. */
type Transaction = Parameters<Parameters<Database['transaction']>[0]>[0];

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
