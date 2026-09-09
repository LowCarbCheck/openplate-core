/**
 * Boots the REAL app (`createApp`) with fake stores, on an ephemeral loopback
 * port, so the admin-API tests exercise the actual mount decision rather than
 * a router assembled by the test.
 *
 * That matters more here than usual. The property under test in
 * `admin-404-when-unset.test.ts` is a MOUNTING property — "with no static
 * token configured and no admin account, nothing that answers 401 exists on
 * this path" — and a test that built the admin router itself and called it
 * directly could not observe it. So the harness takes an admin token or `null`
 * and hands the whole thing to `createApp` exactly as `main.ts` does. Since
 * M192 the tree is always mounted and the MIDDLEWARE makes that call, which is
 * exactly why the harness must keep going through `createApp`.
 *
 * The logger is captured rather than silenced, because "the log line carries
 * the account id and not the address" is itself a tested property
 * (`admin-log-leak.test.ts`).
 */
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createApp } from '../../src/server/create-app.js';
import { createThrottleStore } from '../../src/lib/throttle.js';
import type { LogFields, Logger } from '../../src/logger.js';
import type { AccountStore } from '../../src/accounts/account-store.js';
import type { AiQuotaStore, ReserveResult } from '../../src/ai/quota-store.js';
import { createAuthFixture } from './auth-context-fixture.js';
import { createFakeStorageAdapter } from './fake-storage-adapter.js';
import { createFakeRotationStore } from './fake-rotation-store.js';
import { createFakeAdminStore, type FakeAdminStore } from './fake-admin-store.js';
import { createFakeInviteStore, type FakeInviteStore } from './fake-invite-store.js';
import type { FakeAccountStore } from './fake-account-store.js';
import {
  createFakeFeedbackAdminStore,
  createFakeFeedbackImageStore,
  createFakeFeedbackStore,
} from './feedback-harness.js';
import type { FeedbackReportDetail } from '../../src/feedback/feedback-admin-store.js';

/** One emitted log line, kept whole so a test can assert on the message AND the fields. */
export interface CapturedLogLine {
  level: string;
  message: string;
  fields: LogFields | undefined;
}

export interface CapturingLogger {
  logger: Logger;
  lines: CapturedLogLine[];
}

export function createCapturingLogger(): CapturingLogger {
  const lines: CapturedLogLine[] = [];
  const record =
    (level: string) =>
    (message: string, fields?: LogFields): void => {
      lines.push({ level, message, fields });
    };
  return {
    lines,
    logger: { debug: record('debug'), info: record('info'), warn: record('warn'), error: record('error') },
  };
}

export interface AdminHarness {
  baseUrl: string;
  admin: FakeAdminStore;
  invites: FakeInviteStore;
  /** The store the app holds — the spying wrapper below. */
  accounts: AccountStore;
  /** The store underneath it, with the test-only inspectors (`hasAccount`, `allTokens`, `seedInvite`). */
  fakeAccounts: FakeAccountStore;
  /** The auth fixture the app was built over, so a test can mint an admin account's own access token. */
  fixture: ReturnType<typeof createAuthFixture>;
  logLines: CapturedLogLine[];
  /** Every account id passed to the shared `AccountStore.deleteAccount`, in order. */
  deletedAccountIds: number[];
  request(input: { method: string; path: string; token?: string | null; body?: unknown }): Promise<Response>;
  close(): Promise<void>;
}

export interface StartAdminHarnessOptions {
  /** `null` means "this instance has no static break-glass credential" — the default state of every deployment. */
  adminToken: string | null;
  /**
   * The biller's scoped service credential (M213), or absent for the instance
   * every deployment boots as: no `BILLING_TOKEN`, and no service principal
   * that any value could produce.
   */
  billingToken?: string | null;
  /**
   * The operator's reported-estimate surface, on or off. `false` is what every
   * deployment boots as, and it leaves `/v1/admin/feedback*` answering the
   * ordinary unknown-path 404 to an authenticated administrator.
   *
   * A SCOPE TEST HAS TO TURN IT ON. Proving that the service principal is
   * refused a route that answers 404 to everybody would prove nothing; the
   * four feedback routes have to be live for their 403 to mean the scope
   * stopped them.
   */
  feedbackEnabled?: boolean;
  /** Where a join link points. Absent means this instance builds none, and an invite comes back with a raw token. */
  links?: { clientBaseUrl: string; serverPublicUrl: string } | null;
  /**
   * The whole instance's AI ceiling per UTC day, reported by
   * `GET /v1/admin/stats`. Absent boots WITHOUT an AI surface at all, which is
   * every deployment that has not bought a provider key, and the stats read
   * then reports `null`.
   *
   * A NUMBER HERE BUILDS THE REAL AI SURFACE, because that is where the
   * ceiling lives: `create-app.ts` reads it off the surface the proxy
   * enforces, so a fixture that could set it any other way would be able to
   * pass a test the production wiring fails.
   */
  aiInstanceDailyLimit?: number;
}

/**
 * A quota store that answers everything and counts nothing. The admin suite
 * never posts a completion; it exists only so an AI surface can be built at
 * all, which is what carries the ceiling into `GET /v1/admin/stats`.
 */
function createStubQuota(): AiQuotaStore {
  return {
    async reserve(input: { accountId: number; day: string; limit: number }): Promise<ReserveResult> {
      return { ok: true, used: 1, limit: input.limit };
    },
    async release(): Promise<void> {},
    async countRequestsOn(): Promise<number> {
      return 0;
    },
    async purgeUsageBefore(): Promise<number> {
      return 0;
    },
    async reserveInstance(input: { day: string; limit: number }): Promise<ReserveResult> {
      return { ok: true, used: 1, limit: input.limit };
    },
    async releaseInstance(): Promise<void> {},
  };
}

export async function startAdminHarness(options: StartAdminHarnessOptions): Promise<AdminHarness> {
  const fixture = createAuthFixture();
  const adminStore = createFakeAdminStore();
  const inviteStore = createFakeInviteStore();
  const capturing = createCapturingLogger();
  const deletedAccountIds: number[] = [];
  /** Shared by the two feedback fakes below, exactly as `feedback-harness.ts` shares it. Empty unless one is built. */
  const feedbackRows: FeedbackReportDetail[] = [];

  /**
   * The account store the app is given, wrapped so a test can prove the admin
   * route goes through `AccountStore.deleteAccount` — the same method the
   * self-service path calls — rather than reaching past it into SQL.
   */
  const accounts: AccountStore = {
    ...fixture.store,
    async deleteAccount(accountId: number): Promise<void> {
      deletedAccountIds.push(accountId);
      await fixture.store.deleteAccount(accountId);
    },
  };

  const app = createApp({
    authContext: { ...fixture.ctx, store: accounts },
    storage: createFakeStorageAdapter(),
    rotation: createFakeRotationStore(),
    throttle: createThrottleStore({ freeAttempts: 10_000, baseLockoutMs: 1, maxLockoutMs: 1, attemptResetMs: 1 }),
    logger: capturing.logger,
    trustProxy: false,
    mailer: fixture.mailer,
    now: fixture.now,
    admin: {
      token: options.adminToken,
      billingToken: options.billingToken ?? null,
      metadata: adminStore,
      invites: inviteStore,
      links: options.links ?? null,
    },
    feedback:
      options.feedbackEnabled === true
        ? {
            reports: createFakeFeedbackStore(feedbackRows),
            review: createFakeFeedbackAdminStore(feedbackRows),
            images: createFakeFeedbackImageStore(),
            dailyLimit: 5,
            maxRequestBytes: 8_000_000,
          }
        : null,
    ai:
      options.aiInstanceDailyLimit === undefined
        ? null
        : {
            upstream: { baseUrl: 'http://127.0.0.1:1/v1', apiKey: 'never-called', timeoutMs: 1000 },
            quota: createStubQuota(),
            perMinute: 10_000,
            maxRequestBytes: 8_000_000,
            instanceDailyLimit: options.aiInstanceDailyLimit,
          },
  });

  const server: Server = app.listen(0);
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const address = server.address();
  if (address === null) throw new Error('expected a listening server');
  // SAFETY: `listen(0)` binds a TCP port, and Node only returns the string
  // form of an address for a Unix domain socket, which this never opens.
  const { port } = address as AddressInfo;
  const baseUrl = `http://127.0.0.1:${port}`;

  return {
    baseUrl,
    admin: adminStore,
    invites: inviteStore,
    accounts,
    fakeAccounts: fixture.store,
    fixture,
    logLines: capturing.lines,
    deletedAccountIds,
    async request(input: { method: string; path: string; token?: string | null; body?: unknown }): Promise<Response> {
      const headers: Record<string, string> = {};
      const token = input.token ?? null;
      if (token !== null) headers.authorization = `Bearer ${token}`;
      if (input.body !== undefined) headers['content-type'] = 'application/json';
      return fetch(`${baseUrl}${input.path}`, {
        method: input.method,
        headers,
        body: input.body === undefined ? undefined : JSON.stringify(input.body),
      });
    },
    async close(): Promise<void> {
      await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    },
  };
}
