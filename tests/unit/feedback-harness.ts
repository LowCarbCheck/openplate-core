/**
 * Boots the REAL app (`createApp`) with fake stores, on an ephemeral loopback
 * port, so the gating test exercises the actual mount decision rather than a
 * router the test assembled.
 *
 * That is the whole reason this file exists and the test does not simply build
 * a router. The property under test in `feedback-route-gating.test.ts` is a
 * MOUNTING property, "with `SYNC_FEEDBACK` off, nothing that answers 401 exists
 * on this path", and a test that constructed the route itself could not observe
 * it. So the harness takes a feedback surface or `null` and hands the whole
 * thing to `createApp` exactly as `main.ts` does.
 *
 * BOTH STATES, ON PURPOSE. A gating test that only ever boots the OFF instance
 * would still pass if the route were deleted, or misspelled, or never written:
 * it would be asserting that an unknown path is unknown. The harness therefore
 * boots the ON instance too, with in-memory stores, so the same paths can be
 * shown to stop answering 404 when the operator opts in. That is the assertion
 * that fails if somebody removes the feature and leaves the test behind.
 *
 * The fakes below hold nothing on disk and are not a second implementation of
 * the store's rules: the idempotency guarantee and the daily limit belong to
 * Postgres (`feedback/feedback-store.ts` takes an advisory lock and leans on a
 * unique index), and `tests/integration/feedback.test.ts` proves them against a
 * real database. A fake that reimplemented them here would be testing itself.
 */
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createApp } from '../../src/server/create-app.js';
import { createThrottleStore } from '../../src/lib/throttle.js';
import { createSilentLogger } from '../../src/logger.js';
import { createFakeStorageAdapter } from './fake-storage-adapter.js';
import { createFakeRotationStore } from './fake-rotation-store.js';
import { createFakeAdminStore } from './fake-admin-store.js';
import { createFakeInviteStore } from './fake-invite-store.js';
import { createAuthFixture } from './auth-context-fixture.js';
import type { FeedbackImage, FeedbackImageStore } from '../../src/feedback/feedback-image-store.js';
import type {
  FeedbackStore,
  StoredFeedbackReport,
  SubmitFeedbackInput,
  SubmitFeedbackResult,
} from '../../src/feedback/feedback-store.js';

export interface FakeFeedbackStore extends FeedbackStore {
  /** Every submission the route handed down, in order, so a test can assert what was and was not passed on. */
  submitted: SubmitFeedbackInput[];
}

export function createFakeFeedbackStore(): FakeFeedbackStore {
  const submitted: SubmitFeedbackInput[] = [];
  let nextId = 1;
  return {
    submitted,
    async submit(input: SubmitFeedbackInput): Promise<SubmitFeedbackResult> {
      submitted.push(input);
      const report: StoredFeedbackReport = {
        id: nextId,
        accountId: input.accountId,
        hasImage: input.hasImage,
        createdAt: new Date(0),
      };
      nextId += 1;
      return { status: 'stored', report };
    },
    async countSince(): Promise<number> {
      return submitted.length;
    },
  };
}

export interface FakeFeedbackImageStore extends FeedbackImageStore {
  /** Report id to image, so a test can assert an image was stored without a database. */
  images: Map<number, FeedbackImage>;
}

export function createFakeFeedbackImageStore(): FakeFeedbackImageStore {
  const images = new Map<number, FeedbackImage>();
  return {
    images,
    async put(input: { reportId: number } & FeedbackImage): Promise<void> {
      images.set(input.reportId, { contentType: input.contentType, bytes: input.bytes });
    },
    async get(reportId: number): Promise<FeedbackImage | null> {
      return images.get(reportId) ?? null;
    },
    async delete(reportId: number): Promise<void> {
      images.delete(reportId);
    },
  };
}

export interface FeedbackHarness {
  baseUrl: string;
  reports: FakeFeedbackStore;
  images: FakeFeedbackImageStore;
  request(input: { method: string; path: string; token?: string | null; body?: unknown }): Promise<Response>;
  close(): Promise<void>;
}

export interface StartFeedbackHarnessOptions {
  /** `false` is how every deployment boots today. `true` is what an operator who read the ADR chose. */
  enabled: boolean;
  dailyLimit?: number;
  maxRequestBytes?: number;
}

export async function startFeedbackHarness(options: StartFeedbackHarnessOptions): Promise<FeedbackHarness> {
  const fixture = createAuthFixture();
  const reports = createFakeFeedbackStore();
  const images = createFakeFeedbackImageStore();

  const app = createApp({
    authContext: fixture.ctx,
    storage: createFakeStorageAdapter(),
    rotation: createFakeRotationStore(),
    throttle: createThrottleStore({ freeAttempts: 10_000, baseLockoutMs: 1, maxLockoutMs: 1, attemptResetMs: 1 }),
    logger: createSilentLogger(),
    trustProxy: false,
    mailer: fixture.mailer,
    now: fixture.now,
    admin: { token: null, metadata: createFakeAdminStore(), invites: createFakeInviteStore(), links: null },
    feedback: options.enabled
      ? {
          reports,
          images,
          dailyLimit: options.dailyLimit ?? 5,
          maxRequestBytes: options.maxRequestBytes ?? 8_000_000,
        }
      : null,
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
    reports,
    images,
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
