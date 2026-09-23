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
 * standing come in as arguments, so the rule is asserted by comparison. The
 * cap itself is one of those arguments since M228: it arrives on
 * {@link MemberInvitePolicy}, read from `MEMBER_INVITE_LIFETIME_CAP` at boot.
 */
import type { AccountRole, AccountView } from '../protocol.js';

/**
 * The default for `MEMBER_INVITE_LIFETIME_CAP`: how many invitations one
 * member may cause in their whole life on an instance whose operator has not
 * said otherwise.
 *
 * CONFIGURABLE SINCE 2026-09-14 (M228), AND IT WAS NOT BEFORE. This comment
 * used to say the number was fixed on purpose, and argued that a third dial
 * would let one variable multiply accounts without moving the bound. The
 * decision was reversed on purpose: a managed instance whose administrator
 * pays for the provider key wants two, not five, and the bound that argument
 * asked for already exists and is unchanged. `AI_INSTANCE_DAILY_LIMIT` caps
 * what the whole instance may spend per day whatever this number is, so the
 * cap moves the growth rate and never the bill.
 *
 * FIVE REMAINS THE DEFAULT because it is what every instance has enforced
 * since M212. An upgrade that silently changed what a member may do would be
 * the same defect from the other side.
 *
 * NOTHING IN `src/` OUTSIDE `config.ts` READS THIS. The enforced number travels on
 * {@link MemberInvitePolicy}, so a console and a route cannot disagree about
 * it; this is only what `parseMemberInvites` falls back to.
 */
export const DEFAULT_MEMBER_INVITE_LIFETIME_CAP = 5;

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
 * The second refusal about the caller's own standing (M253/11): a scan trial
 * nobody has paid for yet may not invite anybody.
 *
 * WHY. Every member invitation on an instance with `MEMBER_INVITE_TRIAL` is a
 * new ten-scan trial, so a free account that may invite is a free account
 * that mints more free accounts. The owner decided on 2026-09-23 that
 * invitations open once the account holds a paid plan. See
 * `scan-trial.ts` `isUnpaidTrial` for what "paid" means here.
 *
 * ASKED AFTER THE CAP. An account that has spent its whole allowance hears
 * {@link MEMBER_INVITE_CAP_REACHED}, because paying would not help it.
 */
export const MEMBER_INVITES_NEED_A_PLAN = 'invites-need-a-plan';

/**
 * What an invitation a member causes is worth. Every value is the INSTANCE'S,
 * never the caller's: none is readable or writable through any request body.
 *
 * TWO SHAPES, ONE DOOR (M253). The member door grants EITHER a day trial
 * (`MEMBER_INVITE_DAILY_AI_LIMIT` and `MEMBER_INVITE_ALLOWANCE_DAYS`) OR the
 * instance's scan trial (`MEMBER_INVITE_TRIAL=true`), never both, and
 * `config.ts` refuses to boot with both. `kind` is optional on the day shape
 * so every policy written before the scan trial existed still reads as one.
 */
export type MemberInvitePolicy = MemberInviteDaysPolicy | MemberInviteTrialPolicy;

/** The day trial: an allowance per day, for a number of days after redemption. */
export interface MemberInviteDaysPolicy {
  kind?: 'days';
  /** `MEMBER_INVITE_DAILY_AI_LIMIT`, the redeemed account's AI requests per UTC day. */
  dailyAiLimit: number;
  /** `MEMBER_INVITE_ALLOWANCE_DAYS`, how many days after redemption the allowance ends. */
  allowanceDays: number;
  /**
   * `MEMBER_INVITE_LIFETIME_CAP`, how many invitations one member may cause in
   * total, defaulting to {@link DEFAULT_MEMBER_INVITE_LIFETIME_CAP}. Zero is a
   * value: the route stays mounted and every member has nothing to spend.
   */
  lifetimeCap: number;
}

/** The scan trial (M253): the instance's `TRIAL_SCANS` free scans with no end date, at `TRIAL_DAILY_AI_LIMIT` a day. */
export interface MemberInviteTrialPolicy {
  kind: 'trial';
  /** `TRIAL_DAILY_AI_LIMIT`. */
  dailyAiLimit: number;
  /** `TRIAL_SCANS`. */
  trialScans: number;
  /** As on the day shape. */
  lifetimeCap: number;
}

export interface InvitesLeftInput {
  role: AccountRole;
  /** Rows in `signup_invites` that carry this account, from `InviteStore.countMintedBy`. */
  minted: number;
  /**
   * This instance's settings, or `null` where members cannot invite anybody.
   *
   * THE POLICY ITSELF AND NOT A FLAG PLUS A NUMBER, because the two could
   * disagree. A caller that passed `enabled: true` beside somebody else's cap
   * would report a count this service does not enforce, which is the one thing
   * this module exists to make impossible.
   */
  policy: MemberInvitePolicy | null;
  /**
   * Whether this account is a scan trial nobody has paid for, from
   * `scan-trial.ts` `isUnpaidTrial`. A boolean and not the three inputs, so
   * the date rule lives in one module and this one only reads its answer.
   */
  isUnpaidTrial: boolean;
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
 * lowering `MEMBER_INVITE_LIFETIME_CAP`, a restored backup) reads `0`, which
 * is the honest answer to "how many more may I send".
 */
export function invitesLeft(input: InvitesLeftInput): number | null {
  if (input.policy === null) return null;
  if (input.role === 'admin') return null;
  // `0` FOR AN UNPAID TRIAL (M253/11), because it may send none right now.
  // {@link invitesNeedAPlan} is what tells a client why.
  if (input.isUnpaidTrial) return 0;
  return spareInvites(input.policy, input.minted);
}

/**
 * Whether `invitesLeft` reads `0` only because this account has not paid, the
 * account view's `invitesNeedAPlan` (M253/11).
 *
 * `true` EXACTLY WHEN THE ROUTE WOULD ANSWER {@link MEMBER_INVITES_NEED_A_PLAN}:
 * the feature is on, the caller is a member, the cap still has room, and the
 * account is an unpaid scan trial. `false` everywhere else, including for an
 * administrator and on an instance with the feature off, where the cap is not
 * about anybody.
 */
export function invitesNeedAPlan(input: InvitesLeftInput): boolean {
  if (input.policy === null) return false;
  if (input.role === 'admin') return false;
  if (!input.isUnpaidTrial) return false;
  return spareInvites(input.policy, input.minted) > 0;
}

/** The slice of {@link AccountView} this module computes. */
export type MemberInviteFields = Pick<AccountView, 'invitesLeft' | 'invitesNeedAPlan'>;

/**
 * The two account-view fields this module owns, from one input, so the
 * caller's own view and the operator's view cannot compute them apart.
 */
export function memberInviteFields(input: InvitesLeftInput): MemberInviteFields {
  return { invitesLeft: invitesLeft(input), invitesNeedAPlan: invitesNeedAPlan(input) };
}

function spareInvites(policy: MemberInvitePolicy, minted: number): number {
  return Math.max(0, policy.lifetimeCap - minted);
}
