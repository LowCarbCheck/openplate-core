/**
 * Drizzle implementation of `AdminMetadataStore`, the only module that reads
 * account rows on an operator's behalf.
 *
 * EVERY SELECT HERE NAMES ITS COLUMNS, AND THAT IS THE POINT. Not one query
 * below is a `select()` over a whole table. `accounts` carries the verifier
 * and the KDF descriptor, `sync_blobs` carries the ciphertext, and
 * `sync_key_records` carries the wrapped DEK, so a bare `select()` would put
 * all three in a row object one careless spread away from a response body.
 * Naming the columns means the forbidden material is never read out of
 * Postgres at all, which is a stronger property than filtering it afterwards:
 * a value that was never fetched cannot be leaked by a later edit to a mapper.
 * (`db/account-store.ts` DOES select whole rows, correctly, the auth handlers
 * genuinely need the verifier to check a login. The admin surface never does.)
 *
 * THE BLOB IS DESCRIBED FROM `size_bytes`, NEVER FROM THE BYTES. That column
 * exists precisely so storage can be reported without reading a 2 MiB
 * ciphertext (see `db/schema.ts`), and here it also means the admin path has
 * no code that has ever held a blob in memory.
 *
 * `recovery_code_escrow` JOINS THAT LIST OF COLUMNS NEVER NAMED HERE (M192).
 * It is the one field on `accounts` that a server-side key can turn back into
 * a credential, and an operator's legitimate need for it is served by the
 * mailed reset, which delivers it to the ACCOUNT HOLDER, rather than by an
 * endpoint that would print it into a console.
 *
 * The per-account fan-out (blob summary, key-record kinds) is two extra
 * queries for a whole page rather than N+1: the page's ids go into one
 * `IN (...)` each. A page is at most `MAX_ADMIN_PAGE_LIMIT` rows, and this
 * endpoint is called by one operator at human speed.
 */
import { and, count, countDistinct, desc, eq, gt, gte, inArray, isNull, lte, sum } from 'drizzle-orm';
import type {
  AdminAccountPage,
  AdminAccountSummary,
  AdminBlobSummary,
  AdminMetadataStore,
  AdminStats,
  ExpiringAllowance,
  ExpiringAllowancePage,
  ListAccountsInput,
} from '../admin/admin-store.js';
import type { AccountActivityCount, ActivityDay } from '../admin/account-activity.js';
import type { AccountRole, SyncKeyRecordKind } from '../protocol.js';
import type { Database } from './client.js';
import { utcDayKey } from '../lib/utc-day.js';
import { accounts, aiUsageDays, signupInvites, syncBlobs, syncKeyRecords } from './schema.js';
import { createDrizzlePulseStore } from '../pulse/pulse-store.js';
import { createDrizzlePushStore } from '../push/push-store.js';

/** The identity columns, deliberately enumerated, never `select()`. See the module header. */
interface AccountIdentityRow {
  id: number;
  email: string;
  displayName: string | null;
  role: AccountRole;
  dailyAiLimit: number;
  allowanceExpiresAt: Date | null;
  suspendedAt: Date | null;
  createdAt: Date;
  lastSeenAt: Date | null;
}

/**
 * The columns an operator may see. Named once so the list and the detail read
 * cannot drift, and so the forbidden ones, `verifier`, `recovery_verifier`,
 * `kdf_descriptor`, `recovery_code_escrow`, are absent in one visible place
 * rather than in two.
 */
const IDENTITY_COLUMNS = {
  id: accounts.id,
  email: accounts.email,
  displayName: accounts.displayName,
  role: accounts.role,
  dailyAiLimit: accounts.dailyAiLimit,
  // The end of the AI allowance (M212). An operator sets it and the AI proxy
  // is the only thing that reads it; it is on the user-facing `AccountView`
  // too, because the person whose trial ends has to be told when.
  allowanceExpiresAt: accounts.allowanceExpiresAt,
  suspendedAt: accounts.suspendedAt,
  createdAt: accounts.createdAt,
  // An operator fact, added in M201: when this person last did something on
  // purpose. It is metadata about a person's use of a health app, so it is here
  // and NOT on the user-facing `AccountView`, and it is nullable because an
  // invited account that never signed in has no honest value.
  lastSeenAt: accounts.lastSeenAt,
} as const;

/** `sum()` comes back as a numeric string (or `null` on an empty table), because a Postgres `bigint` does not fit a JS number by contract. */
function toByteCount(value: string | null): number {
  return value === null ? 0 : Number(value);
}

export function createDrizzleAdminStore(db: Database): AdminMetadataStore {
  /** The newest blob version per account, for the given ids. */
  async function blobSummaries(accountIds: number[]): Promise<Map<number, AdminBlobSummary>> {
    const summaries = new Map<number, AdminBlobSummary>();
    if (accountIds.length === 0) return summaries;

    const rows = await db
      .select({
        accountId: syncBlobs.accountId,
        blobVersion: syncBlobs.blobVersion,
        sizeBytes: syncBlobs.sizeBytes,
        createdAt: syncBlobs.createdAt,
      })
      .from(syncBlobs)
      .where(inArray(syncBlobs.accountId, accountIds))
      .orderBy(desc(syncBlobs.blobVersion));

    // Ordered newest-first, so the FIRST row seen for an account is its
    // current version and every later one is a retained older version.
    for (const row of rows) {
      if (summaries.has(row.accountId)) continue;
      summaries.set(row.accountId, { sizeBytes: row.sizeBytes, updatedAt: row.createdAt });
    }
    return summaries;
  }

  /** Today's AI spend per account, for the given ids. A count, never a log, see `db/schema.ts`. */
  async function aiUsage(accountIds: number[], day: string): Promise<Map<number, number>> {
    const usage = new Map<number, number>();
    if (accountIds.length === 0) return usage;

    const rows = await db
      .select({ accountId: aiUsageDays.accountId, count: aiUsageDays.count })
      .from(aiUsageDays)
      .where(and(inArray(aiUsageDays.accountId, accountIds), eq(aiUsageDays.day, day)));

    for (const row of rows) usage.set(row.accountId, row.count);
    return usage;
  }

  /** Which key-record kinds exist per account, for the given ids. The wrapped DEK column is never named. */
  async function keyRecordKinds(accountIds: number[]): Promise<Map<number, SyncKeyRecordKind[]>> {
    const kinds = new Map<number, SyncKeyRecordKind[]>();
    if (accountIds.length === 0) return kinds;

    const rows = await db
      .select({ accountId: syncKeyRecords.accountId, kind: syncKeyRecords.kind })
      .from(syncKeyRecords)
      .where(inArray(syncKeyRecords.accountId, accountIds));

    for (const row of rows) {
      const existing = kinds.get(row.accountId) ?? [];
      existing.push(row.kind);
      kinds.set(row.accountId, existing);
    }
    return kinds;
  }

  /**
   * How many invitations each of these accounts CAUSED, for the given ids
   * (M212).
   *
   * ONE GROUPED QUERY FOR THE WHOLE PAGE, the shape every other helper here
   * uses: a count per account would turn a fifty-row people list into fifty
   * round trips. An account with no rows is absent from the result and reads
   * `0` at the call site, which is the honest value rather than a missing key.
   *
   * NO LIFECYCLE PREDICATE, exactly as `InviteStore.countMintedBy` has none:
   * the cap is on letters caused, so revoked and expired rows count too, and
   * an operator's console must show the same number the route enforces.
   */
  async function invitesMinted(accountIds: number[]): Promise<Map<number, number>> {
    const minted = new Map<number, number>();
    if (accountIds.length === 0) return minted;

    const rows = await db
      .select({ accountId: signupInvites.invitedByAccountId, total: count() })
      .from(signupInvites)
      .where(inArray(signupInvites.invitedByAccountId, accountIds))
      .groupBy(signupInvites.invitedByAccountId);

    for (const row of rows) {
      // `invited_by_account_id` is nullable, so drizzle types it as such even
      // though the `IN (...)` above cannot match a NULL.
      if (row.accountId === null) continue;
      minted.set(row.accountId, row.total);
    }
    return minted;
  }

  async function summarize(identities: AccountIdentityRow[], day: string): Promise<AdminAccountSummary[]> {
    const ids = identities.map((identity) => identity.id);
    const blobs = await blobSummaries(ids);
    const kinds = await keyRecordKinds(ids);
    const usage = await aiUsage(ids, day);
    const minted = await invitesMinted(ids);

    return identities.map((identity) => ({
      id: identity.id,
      email: identity.email,
      displayName: identity.displayName,
      role: identity.role,
      dailyAiLimit: identity.dailyAiLimit,
      aiUsedToday: usage.get(identity.id) ?? 0,
      allowanceExpiresAt: identity.allowanceExpiresAt,
      suspendedAt: identity.suspendedAt,
      createdAt: identity.createdAt,
      lastSeenAt: identity.lastSeenAt,
      blob: blobs.get(identity.id) ?? null,
      keyRecordKinds: (kinds.get(identity.id) ?? []).toSorted(),
      invitesMinted: minted.get(identity.id) ?? 0,
    }));
  }

  return {
    async listAccounts(input: ListAccountsInput): Promise<AdminAccountPage> {
      const identities = await db
        .select(IDENTITY_COLUMNS)
        .from(accounts)
        // A stable order, or two pages of the same list can show the same
        // account twice and miss another.
        .orderBy(accounts.id)
        .limit(input.limit)
        .offset(input.offset);

      const [totals] = await db.select({ total: count() }).from(accounts);

      return { accounts: await summarize(identities, input.day), total: totals?.total ?? 0 };
    },

    async listExpiringAllowances(input: {
      after: Date;
      limit: number;
      offset: number;
    }): Promise<ExpiringAllowancePage> {
      // TWO COLUMNS, and deliberately not `IDENTITY_COLUMNS`. The caller is
      // the biller's reconciliation (M213): it compares dates against its own
      // subscriptions, so the address, the name and the role are material it
      // has no use for and must never hold. See `admin/admin-store.ts`.
      const rows = await db
        .select({ id: accounts.id, allowanceExpiresAt: accounts.allowanceExpiresAt })
        .from(accounts)
        .where(gt(accounts.allowanceExpiresAt, input.after))
        // A stable order, for the reason `listAccounts` has one: two pages of
        // the same list can otherwise show one account twice and miss another,
        // which in a reconciliation reads as a subscription with no account.
        .orderBy(accounts.id)
        .limit(input.limit)
        .offset(input.offset);

      const [totals] = await db
        .select({ total: count() })
        .from(accounts)
        .where(gt(accounts.allowanceExpiresAt, input.after));

      const page: ExpiringAllowance[] = [];
      for (const row of rows) {
        // `allowance_expires_at` is nullable, so drizzle types it as such even
        // though the `>` above cannot match a NULL.
        if (row.allowanceExpiresAt === null) continue;
        page.push({ id: row.id, allowanceExpiresAt: row.allowanceExpiresAt });
      }
      return { accounts: page, total: totals?.total ?? 0 };
    },

    async getAccount(input: { accountId: number; day: string }): Promise<AdminAccountSummary | null> {
      const [identity] = await db
        .select(IDENTITY_COLUMNS)
        .from(accounts)
        .where(eq(accounts.id, input.accountId))
        .limit(1);
      if (!identity) return null;

      const [summary] = await summarize([identity], input.day);
      return summary ?? null;
    },

    async accountActivity(input: { accountId: number; fromDay: string; toDay: string }): Promise<ActivityDay[]> {
      // BOTH ENDS INCLUSIVE, and both compared as `date`: `day` is a
      // `date` column read as a string, so `gte`/`lte` against `YYYY-MM-DD`
      // are date comparisons in Postgres rather than string ones, and no row
      // can fall outside the strip the caller is about to draw.
      const rows = await db
        .select({ day: aiUsageDays.day, count: aiUsageDays.count })
        .from(aiUsageDays)
        .where(
          and(
            eq(aiUsageDays.accountId, input.accountId),
            gte(aiUsageDays.day, input.fromDay),
            lte(aiUsageDays.day, input.toDay),
          ),
        )
        .orderBy(aiUsageDays.day);

      return rows.map((row) => ({ day: row.day, count: row.count }));
    },

    async activityForAccounts(input: {
      accountIds: readonly number[];
      fromDay: string;
      toDay: string;
    }): Promise<AccountActivityCount[]> {
      // An empty `IN ()` is not valid SQL, and a page with no accounts has
      // nothing to ask about anyway.
      if (input.accountIds.length === 0) return [];

      // ONE QUERY FOR THE WHOLE PAGE, the same `IN (...)` shape the per-account
      // fan-out above uses (see the module header), widened from one day to a
      // day range. One statement per account would turn a fifty-row people
      // list into fifty round trips.
      //
      // NO `GROUP BY`: `(account_id, day)` is the composite primary key of
      // `ai_usage_days` (`db/schema.ts`), so there is at most one row per pair
      // already and an aggregate would only re-derive a value the table holds.
      const rows = await db
        .select({ accountId: aiUsageDays.accountId, day: aiUsageDays.day, count: aiUsageDays.count })
        .from(aiUsageDays)
        .where(
          and(
            inArray(aiUsageDays.accountId, [...input.accountIds]),
            gte(aiUsageDays.day, input.fromDay),
            lte(aiUsageDays.day, input.toDay),
          ),
        )
        .orderBy(aiUsageDays.accountId, aiUsageDays.day);

      return rows.map((row) => ({ accountId: row.accountId, day: row.day, count: row.count }));
    },

    async stats(input: { now: Date }): Promise<AdminStats> {
      // DELEGATED, never re-queried. `pulse/pulse-store.ts` owns these four
      // tables at both ends, and a second reading of them here would be a
      // second place the contributor count could drift from the floor the
      // client draws from it.
      const pulse = await createDrizzlePulseStore(db).totals({ day: utcDayKey(input.now), now: input.now });
      // DELEGATED FOR THE SAME REASON. `push/push-store.ts` owns that table,
      // and a count written out again here would be a second place to forget
      // that a subscription is a credential.
      const push = await createDrizzlePushStore(db).stats({ day: utcDayKey(input.now) });

      const [accountTotals] = await db.select({ total: count() }).from(accounts);
      const [adminTotals] = await db.select({ total: count() }).from(accounts).where(eq(accounts.role, 'admin'));

      // PENDING means a letter is outstanding: not redeemed, not revoked, not
      // expired. The three columns together, because any one of them alone
      // would count invitations nobody can use.
      const [inviteTotals] = await db
        .select({ total: count() })
        .from(signupInvites)
        .where(
          and(
            isNull(signupInvites.redeemedAt),
            isNull(signupInvites.revokedAt),
            gt(signupInvites.expiresAt, input.now),
          ),
        );

      const [aiTotals] = await db
        .select({ total: sum(aiUsageDays.count) })
        .from(aiUsageDays)
        .where(eq(aiUsageDays.day, utcDayKey(input.now)));

      const [blobTotals] = await db
        .select({
          versions: count(),
          owners: countDistinct(syncBlobs.accountId),
          bytes: sum(syncBlobs.sizeBytes),
        })
        .from(syncBlobs);

      const [keyRecordTotals] = await db.select({ total: count() }).from(syncKeyRecords);

      return {
        accounts: accountTotals?.total ?? 0,
        accountsWithBlob: blobTotals?.owners ?? 0,
        blobVersions: blobTotals?.versions ?? 0,
        keyRecords: keyRecordTotals?.total ?? 0,
        blobBytes: toByteCount(blobTotals?.bytes ?? null),
        pendingInvites: inviteTotals?.total ?? 0,
        admins: adminTotals?.total ?? 0,
        // `sum()` comes back as a numeric string for the same reason
        // `blobBytes` does: a Postgres `bigint` does not fit a JS number by
        // contract, even when this one always will.
        aiRequestsToday: toByteCount(aiTotals?.total ?? null),
        pulse,
        push,
      };
    },
  };
}
