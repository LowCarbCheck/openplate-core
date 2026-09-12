/**
 * In-memory `AdminMetadataStore` for the admin-API unit tests.
 *
 * It is seeded with REAL-LOOKING material, and that is deliberate: the
 * forbidden-field test asserts that no verifier, KDF descriptor, wrapped DEK
 * or ciphertext appears in any admin response, and an assertion like that is
 * vacuous if the fixture never held such a value in the first place. So each
 * seeded account carries its secrets on the fixture (`AdminSeedSecrets`) where
 * a test can assert their ABSENCE by exact string, while the store itself,
 * mirroring the real one, has no way to return them.
 */
import type {
  AdminAccountPage,
  AdminAccountSummary,
  AdminMetadataStore,
  AdminStats,
  ExpiringAllowance,
  ExpiringAllowancePage,
  ListAccountsInput,
} from '../../src/admin/admin-store.js';
import type { AccountRole, SyncKeyRecordKind } from '../../src/protocol.js';
import type { AccountActivityCount, ActivityDay } from '../../src/admin/account-activity.js';

/**
 * The material an account really has in the database and which the admin API
 * must never emit. Held beside the store, never inside a summary.
 */
export interface AdminSeedSecrets {
  verifier: string;
  kdfDescriptorSalt: string;
  wrappedDek: string;
  ciphertext: string;
  tokenHash: string;
  /** The plaintext recovery code behind `accounts.recovery_code_escrow`, the newest thing that must never be emitted. */
  recoveryCode: string;
}

export interface AdminSeedInput {
  id: number;
  email: string;
  displayName?: string | null;
  role?: AccountRole;
  dailyAiLimit?: number;
  aiUsedToday?: number;
  allowanceExpiresAt?: Date | null;
  suspendedAt?: Date | null;
  lastSeenAt?: Date | null;
  blobSizeBytes?: number;
  keyRecordKinds?: SyncKeyRecordKind[];
  /** Usage rows for this account, `YYYY-MM-DD` to count. Only the days that HAVE a row, as the real store returns. */
  activity?: Record<string, number>;
}

export interface FakeAdminStore extends AdminMetadataStore {
  seed(input: AdminSeedInput): AdminSeedSecrets;
  /**
   * Test-only: drop ONE account, which is how a test spells out what
   * `AccountStore.deleteAccount` does to the row this store reads.
   *
   * The real pair is one `accounts` table and one cascade, so an erasure is
   * invisible to the metadata store the moment it happens. Two fakes cannot
   * share a row, so a test that erases has to say so here as well.
   */
  forget(accountId: number): void;
  /** Test-only: forget everything, so one process-wide server can serve many cases. */
  clear(): void;
}

export function createFakeAdminStore(): FakeAdminStore {
  const summaries = new Map<number, AdminAccountSummary>();
  const secrets = new Map<number, AdminSeedSecrets>();
  /** Seeded usage rows per account. Sparse, like the table: a day with no spend has no entry. */
  const activity = new Map<number, Record<string, number>>();

  return {
    seed(input: AdminSeedInput): AdminSeedSecrets {
      const kinds = input.keyRecordKinds ?? [];
      summaries.set(input.id, {
        id: input.id,
        email: input.email,
        displayName: input.displayName ?? null,
        role: input.role ?? 'member',
        dailyAiLimit: input.dailyAiLimit ?? 0,
        aiUsedToday: input.aiUsedToday ?? 0,
        // `null` is the default because it is the column's: no end date at all.
        allowanceExpiresAt: input.allowanceExpiresAt ?? null,
        suspendedAt: input.suspendedAt ?? null,
        createdAt: new Date('2026-08-01T09:00:00.000Z'),
        lastSeenAt: input.lastSeenAt ?? null,
        blob:
          input.blobSizeBytes === undefined
            ? null
            : { sizeBytes: input.blobSizeBytes, updatedAt: new Date('2026-08-03T09:00:00.000Z') },
        keyRecordKinds: kinds,
        // This fake holds no invites, so nobody has caused one. `0` is what
        // the real store answers for an account with no rows.
        invitesMinted: 0,
      });

      const seeded: AdminSeedSecrets = {
        verifier: `verifier-${input.id}-8f2c1b9ae4d07c35a1f6`,
        kdfDescriptorSalt: `kdfsalt-${input.id}-Yk9sTn2QpR4vXw==`,
        wrappedDek: `wrappeddek-${input.id}-3aa71bd05fe6`,
        ciphertext: `ciphertext-${input.id}-0f9d8c7b6a5e4d3c`,
        tokenHash: `tokenhash-${input.id}-c1d2e3f4a5b6`,
        recoveryCode: `RECOVERYCODE${String(input.id).padStart(2, '0')}ABCDEFGHJKMNPQR`,
      };
      secrets.set(input.id, seeded);
      activity.set(input.id, input.activity ?? {});
      return seeded;
    },

    forget(accountId: number): void {
      summaries.delete(accountId);
      secrets.delete(accountId);
      activity.delete(accountId);
    },

    clear(): void {
      summaries.clear();
      secrets.clear();
      activity.clear();
    },

    async listAccounts(input: ListAccountsInput): Promise<AdminAccountPage> {
      const ordered = [...summaries.values()].toSorted((left, right) => left.id - right.id);
      return { accounts: ordered.slice(input.offset, input.offset + input.limit), total: ordered.length };
    },

    async listExpiringAllowances(input: {
      after: Date;
      limit: number;
      offset: number;
    }): Promise<ExpiringAllowancePage> {
      // The PREDICATE is applied here, exactly as the real query applies it: a
      // fake that returned every seeded account would let a route that forgot
      // the future-date filter pass.
      const future: ExpiringAllowance[] = [];
      for (const account of [...summaries.values()].toSorted((left, right) => left.id - right.id)) {
        const expiry = account.allowanceExpiresAt;
        if (expiry === null || expiry.getTime() <= input.after.getTime()) continue;
        future.push({ id: account.id, allowanceExpiresAt: expiry });
      }
      return { accounts: future.slice(input.offset, input.offset + input.limit), total: future.length };
    },

    async getAccount(input: { accountId: number; day: string }): Promise<AdminAccountSummary | null> {
      return summaries.get(input.accountId) ?? null;
    },

    async accountActivity(input: { accountId: number; fromDay: string; toDay: string }): Promise<ActivityDay[]> {
      // The RANGE is applied here, sparsely, exactly as the real query does:
      // a fake that returned every seeded day would let a broken window pass.
      // String comparison is date comparison for `YYYY-MM-DD`.
      return Object.entries(activity.get(input.accountId) ?? {})
        .filter(([day]) => day >= input.fromDay && day <= input.toDay)
        .map(([day, count]) => ({ day, count }))
        .toSorted((left, right) => left.day.localeCompare(right.day));
    },

    async activityForAccounts(input: {
      accountIds: readonly number[];
      fromDay: string;
      toDay: string;
    }): Promise<AccountActivityCount[]> {
      // FLAT ROWS, sparse by day, exactly as the real query returns them, and
      // deliberately in the REVERSE of the order the caller asked in: a fake
      // that handed the ids back in the caller's order would let a grouper
      // that never imposed one pass.
      const rows: AccountActivityCount[] = [];
      for (const accountId of [...input.accountIds].toReversed()) {
        for (const [day, count] of Object.entries(activity.get(accountId) ?? {})) {
          if (day >= input.fromDay && day <= input.toDay) rows.push({ accountId, day, count });
        }
      }
      return rows;
    },

    async stats(): Promise<AdminStats> {
      const all = [...summaries.values()];
      const withBlob = all.filter((account) => account.blob !== null);
      return {
        accounts: all.length,
        accountsWithBlob: withBlob.length,
        blobVersions: withBlob.length,
        keyRecords: all.reduce((total, account) => total + account.keyRecordKinds.length, 0),
        blobBytes: withBlob.reduce((total, account) => total + (account.blob?.sizeBytes ?? 0), 0),
        // This fake holds no invites, so the count is what the store would
        // report for an instance with none. `admins` and `aiRequestsToday` come
        // off the seeded accounts, so they are real.
        pendingInvites: 0,
        admins: all.filter((account) => account.role === 'admin').length,
        aiRequestsToday: all.reduce((total, account) => total + account.aiUsedToday, 0),
        // ZEROES, and honestly so: this fake holds no pulse rows, so these are
        // the numbers the real store reports for an instance nobody opted in
        // on. `tests/integration/pulse-today.test.ts` owns the non-zero case.
        pulse: { day: '1970-01-01', meals: 0, photos: 0, kcal: 0, protein: 0, contributors: 0, fastingNow: 0 },
        // ZEROES, honestly again: this fake holds no subscriptions, so these
        // are the numbers the real store reports for an instance with no VAPID
        // keys. `tests/integration/push-routes.test.ts` owns the non-zero case.
        push: { subscriptions: 0, sentToday: 0 },
      };
    },
  };
}
