/**
 * Whether an address belongs to a throwaway mail service (M253).
 *
 * THE OPEN SIGN-UP DOOR ASKS THIS, AND ONLY IT. An operator who mints an
 * invite for a throwaway address meant to, and a member's invitation is
 * bounded by their own cap; a stranger asking for a trial at a mailbox that
 * self-destructs in ten minutes is the farming this list exists to stop.
 *
 * SUBDOMAINS MATCH. `x.mailinator.com` is refused because `mailinator.com` is
 * listed: several services hand out a fresh subdomain per visitor, and a list
 * that matched only exact names would be walked around with one label.
 *
 * THE LIST IS A VENDORED SNAPSHOT (`disposable-domains.generated.ts`, CC0),
 * refreshed by `pnpm sync:disposable-domains` and reviewed as a diff. Nothing
 * here fetches at run time.
 */
import { DISPOSABLE_DOMAINS } from './disposable-domains.generated.js';

/** Built once per process: a `Set` lookup per label, never a scan of nine thousand entries. */
const BLOCKED = new Set(DISPOSABLE_DOMAINS);

/**
 * `true` when the address's domain, or any parent domain of it with at least
 * two labels, is on the list.
 *
 * Expects the CANONICAL address `accounts/auth-input.ts`'s `parseEmail`
 * produces (trimmed, NFKC, lowercased), which is the only form that reaches
 * the door. A single-label parent (`com`) is never checked, so a list entry
 * can never refuse a whole top-level domain by accident.
 */
export function isDisposableAddress(canonicalEmail: string): boolean {
  const at = canonicalEmail.lastIndexOf('@');
  if (at < 0) return false;
  const labels = canonicalEmail.slice(at + 1).split('.');
  for (let start = 0; start <= labels.length - 2; start += 1) {
    if (BLOCKED.has(labels.slice(start).join('.'))) return true;
  }
  return false;
}
