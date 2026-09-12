/**
 * The read contract the admin API is written against, the metadata half of
 * `AccountStore`, deliberately kept as a SEPARATE interface rather than
 * grafted onto it.
 *
 * WHY A SECOND INTERFACE AND NOT MORE METHODS ON `AccountStore`. The account
 * store is what the auth handlers hold, and everything on it is something a
 * user's own request may cause: find an account, rotate a credential, revoke
 * a token. Nothing here is. Reading every account on the instance is an
 * operator action, and putting it on the same object would make it reachable
 *, one autocomplete away, from every handler that already has a store in
 * scope. The two capabilities are separated so that a handler cannot enumerate
 * accounts by accident.
 *
 * WHAT IT MAY RETURN IS FIXED BY THE ADR, NOT BY CONVENIENCE. There is no
 * ciphertext here, no verifier, no KDF descriptor, no token and no token
 * digest, and there is no method that could be extended to produce one: the
 * blob is described by its BYTE COUNT and the instant it last changed, and a
 * key record by the fact that it exists. That is a projection, not a habit of
 * remembering not to select a column, see
 * `docs/adr/0001-an-admin-api-for-a-zero-knowledge-service.md` for what each
 * prohibition is protecting and why an operator has no legitimate use for the
 * material behind it.
 *
 * DELETION IS NOT HERE. It is `AccountStore.deleteAccount`, which the
 * self-service path calls too, so the two erasure paths cannot drift apart.
 * See `server/admin-routes.ts`.
 */
import type { AccountRole, SyncKeyRecordKind } from '../protocol.js';
import type { AccountActivityCount, ActivityDay } from './account-activity.js';
import type { PulseTotals } from '../pulse/pulse-store.js';
import type { PushStats } from '../push/push-store.js';

/**
 * What the admin surface knows about an account. Everything else about it is
 * out of reach by construction.
 *
 * IT IS A SUPERSET OF THE WIRE'S `AccountView`, NOT A DIFFERENT SHAPE. The
 * M192 contract says the admin account endpoints return `AccountView[]`, and
 * every field of one is here; `blob` and `keyRecordKinds` are the two extra
 * operator facts ADR-0001 requires, and they exist because a storage bill and
 * "does this person have a recovery path" are questions only an operator asks.
 * A client decoding an `AccountView` from an admin response therefore works
 * unchanged, and reads two fields it did not ask for.
 */
export interface AdminAccountSummary {
  id: number;
  /** The account's identity: the canonical address it signs in with. */
  email: string;
  displayName: string | null;
  role: AccountRole;
  dailyAiLimit: number;
  /** AI requests spent on the current UTC day, a count, never a log of what was asked. */
  aiUsedToday: number;
  /**
   * When this account's AI allowance ends, or `null` for no end at all. The
   * operator's own field: it is what they set, and the AI proxy is the only
   * thing that reads it.
   */
  allowanceExpiresAt: Date | null;
  /** Non-`null` while the account is suspended. */
  suspendedAt: Date | null;
  createdAt: Date;
  /**
   * The last time this person did something on purpose: a sign-in or an AI
   * request, never a token refresh and never a sync poll (`db/schema.ts`).
   *
   * `null` FOR AN ACCOUNT THAT HAS NEVER SIGNED IN, and it stays nullable. An
   * invited account that was created and never used has no honest value here,
   * and a screen that rendered an epoch or a "joined" date in its place would
   * be answering the operator's question with a fabrication.
   */
  lastSeenAt: Date | null;
  /**
   * The account's current blob, described and never handed over: how many
   * bytes it occupies, and when those bytes last changed. `null` when the
   * account has never pushed one.
   */
  blob: AdminBlobSummary | null;
  /**
   * WHICH key records exist, never their contents. `passphrase` present and
   * `recovery` absent tells an operator the user has no recovery path, which
   * is a real support answer; the wrapped DEK behind either of them is not.
   */
  keyRecordKinds: SyncKeyRecordKind[];
  /**
   * How many invitations this account has CAUSED: rows in `signup_invites`
   * carrying its id (M212).
   *
   * A COUNT AND NOT `invitesLeft`, deliberately. Whether five minus this
   * number is what the person may still send depends on their role and on
   * whether the instance has member invites on at all, and both of those
   * belong to `accounts/member-invites.ts` rather than to a store. The store
   * reports what the table holds.
   *
   * REVOKED, EXPIRED AND REDEEMED ROWS ALL COUNT, because the cap is on how
   * many letters the account caused and not on how many worked. An
   * operator-minted invite carries no account and is counted against nobody.
   */
  invitesMinted: number;
}

export interface AdminBlobSummary {
  sizeBytes: number;
  /**
   * The instant the account's newest blob version was written. Blob rows are
   * append-only (`db/storage-adapter.ts`), so the newest row's `createdAt`
   * IS the blob's last-modified time.
   */
  updatedAt: Date;
}

/** One page of accounts, plus the total the page was taken from. */
export interface AdminAccountPage {
  accounts: AdminAccountSummary[];
  total: number;
}

/** Aggregate counts for the whole instance. Sums and counts only, no row here is attributable to a person. */
export interface AdminStats {
  accounts: number;
  accountsWithBlob: number;
  /** Every retained blob version, not just the newest one, this is what the disk actually holds. */
  blobVersions: number;
  keyRecords: number;
  /** Summed `size_bytes` across every retained blob version. */
  blobBytes: number;
  /** Invites minted, not yet redeemed, not revoked, not expired, the letters still outstanding. */
  pendingInvites: number;
  /** Accounts whose `role` is `admin`. An operator's answer to "who else can do this". */
  admins: number;
  /** AI requests every account together spent on the current UTC day. A count, never a log. */
  aiRequestsToday: number;
  /**
   * Today's community pulse (M222): the same instance-wide sums every member
   * can already read at `GET /v1/pulse/today`.
   *
   * IT IS NOT A NEW DISCLOSURE, and that is why it is allowed onto a store
   * whose whole discipline is what it may not return. Every number here is
   * already served to any signed-in caller, and none of them is attributable to
   * anybody: an operator reading them learns what a member reading them learns.
   * See `docs/adr/0007-the-pulse-is-a-named-exception.md`.
   */
  pulse: PulseTotals;
  /**
   * Web push (M223): how many devices are subscribed on this instance, and how
   * many notifications went out today.
   *
   * TWO NUMBERS AND NO ROW. An operator needs to know the feature is alive
   * without reading an endpoint, which is a capability: anybody holding one and
   * the instance's VAPID private key can wake that phone. See
   * `docs/adr/0008-push-is-a-scheduling-exception.md`.
   */
  push: PushStats;
}

export interface ListAccountsInput {
  limit: number;
  offset: number;
  /** The UTC day `aiUsedToday` is counted over (`lib/utc-day.ts`). Injected, so a test controls "today". */
  day: string;
}

/**
 * One account with an AI allowance that has not run out yet: its id and the
 * instant it ends, and NOTHING else.
 *
 * A SEPARATE SHAPE RATHER THAN AN `AdminAccountSummary`, and that is the whole
 * reason it exists. This is what the biller's nightly reconciliation reads
 * (M213), and a reconciliation that received summaries would receive every
 * address on the instance to answer a question about dates. `allowanceExpiresAt`
 * is non-nullable here because an account without one is not in the answer.
 */
export interface ExpiringAllowance {
  id: number;
  allowanceExpiresAt: Date;
}

/** One page of them, plus the total the page was taken from, the shape `AdminAccountPage` has, for the same reason. */
export interface ExpiringAllowancePage {
  accounts: ExpiringAllowance[];
  total: number;
}

export interface AdminMetadataStore {
  listAccounts(input: ListAccountsInput): Promise<AdminAccountPage>;
  /**
   * Accounts whose `allowanceExpiresAt` is strictly after `after`, by id,
   * paged.
   *
   * IT PROJECTS TWO COLUMNS IN THE QUERY, not in a mapper afterwards. The
   * caller is a billing service that must not learn who anybody is, and a
   * value that was never read out of Postgres cannot be leaked by a later edit
   * to a view function. Same discipline, and the same reason, as the module
   * header's rule about the columns this store never selects.
   *
   * `after` is the caller's clock, injected like every other one here, so a
   * test can decide what "in the future" means.
   */
  listExpiringAllowances(input: { after: Date; limit: number; offset: number }): Promise<ExpiringAllowancePage>;
  getAccount(input: { accountId: number; day: string }): Promise<AdminAccountSummary | null>;
  /**
   * One account's AI spend per UTC day across an inclusive day range, for the
   * days that HAVE a row.
   *
   * IT RETURNS ROWS, NOT A STRIP. The zero-fill that makes "no activity" and
   * "no record" distinguishable is `admin/account-activity.ts`, which is pure
   * and therefore testable without a database. A store that filled the gaps
   * itself would be inventing rows in the layer whose job is to report what
   * exists.
   *
   * The range is the caller's, already capped by the server
   * (`admin/account-activity.ts`), because a store method with no bound is one
   * mistyped query parameter away from a full-table read.
   */
  accountActivity(input: { accountId: number; fromDay: string; toDay: string }): Promise<ActivityDay[]>;

  /**
   * The same counters for MANY accounts at once, across one inclusive day
   * range, for the pairs that HAVE a row.
   *
   * IT EXISTS BECAUSE THE PEOPLE LIST DRAWS A STRIP PER ROW. Asking
   * `accountActivity` once per account is N+1: a page of fifty is fifty round
   * trips for a screen an operator opens in one go. One call, one query.
   *
   * IT RETURNS ROWS, NOT STRIPS, for exactly the reason `accountActivity`
   * above gives, and the flat row carries its `accountId` so the pure grouper
   * (`admin/account-activity.ts`) can decide the order rather than inheriting
   * whatever order the rows arrived in.
   *
   * The ids and the range are the caller's, both already capped by the server
   * (a page is at most `MAX_ADMIN_PAGE_LIMIT` accounts, the window at most
   * `AI_USAGE_RETENTION_DAYS` days), for the same reason `accountActivity` is
   * bounded: an unbounded read here is one mistyped query parameter away from
   * the whole table.
   */
  activityForAccounts(input: {
    accountIds: readonly number[];
    fromDay: string;
    toDay: string;
  }): Promise<AccountActivityCount[]>;
  /** `now` is injected for the same reason every clock in this repo is: `pendingInvites` and `aiRequestsToday` both key on it. */
  stats(input: { now: Date }): Promise<AdminStats>;
}
