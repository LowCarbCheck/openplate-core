/**
 * The member-invite policy, as data and one pure function (M212).
 *
 * WHY IT IS ITS OWN MODULE. Three places need the same arithmetic and none of
 * them may disagree: `accounts/auth-handlers.ts` refuses a sixth mint and
 * reports `invitesLeft` for the caller's own account view,
 * `server/admin-routes.ts` reports the same field on the operator's account
 * view, and `config.ts` validates the two instance settings at boot. A copy in
 * any one of them would be a console showing a number the service does not
 * enforce.
 *
 * NOTHING HERE READS A CLOCK, A DATABASE OR AN ENVIRONMENT. The counts and the
 * standing come in as arguments, so the rule is asserted by comparison.
 */
import type { AccountRole } from '../protocol.js';

/**
 * How many invitations one member may cause in their whole life.
 *
 * NOT CONFIGURABLE, deliberately. It is the growth rate of the instance, and
 * an operator who wants a different one has the two settings that decide what
 * an invitation is WORTH (`MEMBER_INVITE_DAILY_AI_LIMIT` and
 * `MEMBER_INVITE_ALLOWANCE_DAYS`) plus the instance ceiling
 * (`AI_INSTANCE_DAILY_LIMIT`) that bounds the bill whatever this number is.
 * A third dial here would let one variable multiply accounts without moving
 * the bound.
 */
export const MEMBER_INVITE_LIFETIME_CAP = 5;

/**
 * The ONE refusal `POST /v1/auth/invites` reports about the caller's own
 * standing, and the only thing that response ever says beyond `202`.
 *
 * A MACHINE-SHAPED STRING rather than a sentence, like `ACCOUNT_SUSPENDED` and
 * `INVITE_INVALID`: a client renders its own copy for this one, and has to be
 * able to recognise it.
 */
export const MEMBER_INVITE_CAP_REACHED = 'member-invite-cap-reached';

/**
 * What an invitation a member causes is worth. Both values are the INSTANCE'S,
 * never the caller's: neither is readable or writable through any request body.
 */
export interface MemberInvitePolicy {
  /** `MEMBER_INVITE_DAILY_AI_LIMIT`, the redeemed account's AI requests per UTC day. */
  dailyAiLimit: number;
  /** `MEMBER_INVITE_ALLOWANCE_DAYS`, how many days after redemption the allowance ends. */
  allowanceDays: number;
}

export interface InvitesLeftInput {
  role: AccountRole;
  /** Rows in `signup_invites` that carry this account, from `InviteStore.countMintedBy`. */
  minted: number;
  /** Whether this instance has the two settings that enable the feature. */
  enabled: boolean;
}

/**
 * How many invitations this account may still cause, or `null` when the cap
 * does not apply to it.
 *
 * `null` FOR AN ADMIN, NOT `0`, and the difference is the whole reason this
 * function exists rather than a subtraction at two call sites. `0` reads to a
 * client as "you have used them all", which is the exact opposite of the truth
 * for an operator: they mint through `POST /v1/admin/invites`, which is exempt
 * from the cap and from the re-invite rule. `null` means "this cap is not
 * about you", and a client draws no invite card for it.
 *
 * `null` ON AN INSTANCE WITH THE FEATURE OFF, for the same reason: there is no
 * cap, because there is no route. `POST /v1/auth/invites` answers the ordinary
 * unknown-path 404 there, and a `0` would tell the client that invitations
 * exist here and are all spent.
 *
 * NEVER NEGATIVE. An account whose count somehow exceeds the cap (an operator
 * lowering it in a future version, a restored backup) reads `0`, which is the
 * honest answer to "how many more may I send".
 */
export function invitesLeft(input: InvitesLeftInput): number | null {
  if (!input.enabled) return null;
  if (input.role === 'admin') return null;
  return Math.max(0, MEMBER_INVITE_LIFETIME_CAP - input.minted);
}
