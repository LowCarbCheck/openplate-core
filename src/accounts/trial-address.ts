/**
 * The keyed hash a mailbox is remembered by (M253).
 *
 * WHY A HASH AND NOT THE ADDRESS. One mailbox gets one free trial, also after
 * the account is deleted, and the owner decided on 2026-09-23 that the only
 * thing this service keeps about a deleted person is a keyed one-way hash of
 * their normalised address. HMAC-SHA256 under `TRIAL_ADDRESS_PEPPER`, a
 * secret only the operator holds, so the stored value cannot be reversed and
 * cannot be matched against a list of addresses by anybody who copies the
 * table without the secret.
 *
 * OVER THE TRIAL KEY, NOT THE RAW ADDRESS (`accounts/trial-key.ts`), so the
 * hash of `a.n.n.a+x@gmail.com` is the hash of `anna@gmail.com`.
 *
 * The invite rows carry the same hash while the account lives
 * (`signup_invites.trial_key`), which is what lets a variant spelling of a
 * live trial account be recognised too.
 */
import { createHmac } from 'node:crypto';
import { trialKeyFor } from './trial-key.js';

/** Turns a canonical address into its stored hash. `null` wherever the instance has no pepper. */
export type TrialAddressHasher = (canonicalEmail: string) => string;

/** A domain label, so this HMAC can never collide with another use of the same secret. */
const HASH_LABEL = 'openplate-core/trial-address/v1';

export function createTrialAddressHasher(pepper: string): TrialAddressHasher {
  return (canonicalEmail: string): string =>
    createHmac('sha256', pepper)
      .update(`${HASH_LABEL}\n${trialKeyFor(canonicalEmail)}`)
      .digest('hex');
}
