/**
 * The trial key: the one string two spellings of one mailbox share (M253).
 *
 * WHY IT EXISTS. An instance with open sign-up grants a free trial to every
 * new address, and the rule is one trial per MAILBOX, ever, also after the
 * account is deleted. A mailbox has more than one spelling. Gmail delivers
 * `a.n.n.a@gmail.com` and `anna+diet@gmail.com` to the same inbox as
 * `anna@gmail.com`, so keying the rule on the address itself would hand out
 * a fresh trial per dot and per tag.
 *
 * WHAT IT REMOVES, and nothing else:
 *  - a `+tag` in the local part, for every domain. Most providers deliver
 *    plus addressing to the base mailbox, and the few that do not lose
 *    nothing but a second trial;
 *  - every dot in the local part, for `gmail.com` and `googlemail.com` only,
 *    because only Google ignores them. `a.nna@example.org` and
 *    `anna@example.org` are two mailboxes and keep two keys;
 *  - `googlemail.com` becomes `gmail.com`, because Google delivers both
 *    domains to one inbox.
 *
 * IT IS NEVER AN ADDRESS ANYTHING IS SENT TO. A letter goes to the canonical
 * address the person typed; this key only decides whether that mailbox
 * already had its trial.
 *
 * PURE, and it expects the CANONICAL address `accounts/auth-input.ts`'s
 * `parseEmail` produces (trimmed, NFKC, lowercased). The store computes it
 * at mint from the same value the row keeps, so there is one derivation.
 */

/** The domains whose mail servers ignore dots in the local part. */
const DOTLESS_DOMAINS = new Set(['gmail.com', 'googlemail.com']);

/** Google delivers both names to one mailbox, so the key uses one of them. */
const GOOGLE_CANONICAL_DOMAIN = 'gmail.com';

/**
 * The key one mailbox's trial is recorded under. See the module header.
 *
 * An address with no `@` is returned unchanged: it cannot reach this
 * function through `parseEmail`, and inventing a split for it would make a
 * key nobody else can reproduce.
 */
export function trialKeyFor(canonicalEmail: string): string {
  const at = canonicalEmail.lastIndexOf('@');
  if (at <= 0) return canonicalEmail;

  const domain = canonicalEmail.slice(at + 1);
  const plus = canonicalEmail.indexOf('+');
  const untagged = plus >= 0 && plus < at ? canonicalEmail.slice(0, plus) : canonicalEmail.slice(0, at);
  if (!DOTLESS_DOMAINS.has(domain)) return `${untagged}@${domain}`;
  return `${untagged.replaceAll('.', '')}@${GOOGLE_CANONICAL_DOMAIN}`;
}
