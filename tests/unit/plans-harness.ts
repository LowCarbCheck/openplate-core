/**
 * Boots the REAL app (`createApp`) with fake stores, on an ephemeral loopback
 * port, in front of a REAL listening fake upstream.
 *
 * THE WIRING IS THE THING UNDER TEST, which is why nothing here assembles a
 * router by hand. Every property the plans specs claim is a property of the
 * mount: whether the subtree is dark, whether the bearer gate stands in front
 * of it, which headers leave this process, and which body limit applies to
 * which route. A test that built the router itself would be asserting about a
 * router nobody ships. `ai-route-limits.test.ts` records the regression that
 * taught this repo the difference.
 *
 * THE UPSTREAM IS A REAL SERVER AND NOT AN INJECTED `fetch`. The forwarded
 * headers are the whole point of the feature, and a fake function records what
 * the proxy MEANT to send. A socket records what it sent.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { Socket } from 'node:net';
import type { AddressInfo } from 'node:net';
import { createApp } from '../../src/server/create-app.js';
import { createThrottleStore } from '../../src/lib/throttle.js';
import { createSilentLogger } from '../../src/logger.js';
import { hashToken } from '../../src/lib/tokens.js';
import { createFakeStorageAdapter } from './fake-storage-adapter.js';
import { createFakeRotationStore } from './fake-rotation-store.js';
import { createFakeAdminStore } from './fake-admin-store.js';
import { createFakeInviteStore } from './fake-invite-store.js';
import { createAuthFixture } from './auth-context-fixture.js';

/** One request the fake upstream received, recorded off the wire. */
export interface RecordedUpstreamRequest {
  method: string;
  /** The path plus query the proxy asked for, so a test can prove the suffix and the query survived. */
  url: string;
  /** Every header, lower-cased, exactly as it arrived. A missing one is `undefined`, which is the assertion most of these tests make. */
  headers: Record<string, string | undefined>;
  body: string;
}

/** What the fake upstream answers with. Mutable so one harness can serve several cases. */
export interface UpstreamReply {
  status: number;
  body: string;
  /** `null` sends no `Content-Type` at all, which is how a test proves this service invents none. */
  contentType: string | null;
  /** When `true` the upstream accepts the request and never answers, which is what a timeout looks like. */
  hang?: boolean;
}

export interface PlansHarness {
  baseUrl: string;
  /** A live access token for the seeded account, minted through the fixture's own store. */
  accessToken: string;
  /** The seeded account: its id is what `X-Account-Id` must carry, its address what `X-Account-Email` must. */
  account: { id: number; email: string };
  /** Every request the fake upstream received, in order. Empty is the assertion the refusal tests make. */
  received: RecordedUpstreamRequest[];
  /** What the fake upstream answers next. Reassign fields to change the case. */
  reply: UpstreamReply;
  /** The upstream's base URL, so a test can prove the harness pointed the proxy somewhere real. */
  upstreamBaseUrl: string;
  request(input: {
    method: string;
    path: string;
    token?: string | null;
    body?: string;
    headers?: Record<string, string>;
  }): Promise<Response>;
  close(): Promise<void>;
}

export interface StartPlansHarnessOptions {
  /**
   * `false` is how every deployment boots today: no `PLANS_UPSTREAM_URL`, and
   * the whole subtree answering the ordinary unknown-path 404. `true` is what
   * an instance with a biller behind it looks like.
   */
  configured: boolean;
  /** The shared secret the proxy must send. Named by the test so it can assert the exact value arrived. */
  secret?: string;
  /** Overrides {@link PLANS_UPSTREAM_TIMEOUT_MS} so a hang can be watched in milliseconds instead of seconds. */
  timeoutMs?: number;
  /**
   * Points the proxy at a URL nothing listens on, so an unreachable upstream
   * can be tested without waiting for a timeout. The fake upstream still runs
   * and still records, which is how those tests prove it received nothing.
   */
  unreachable?: boolean;
  /**
   * A static break-glass credential, or absent for the instance every
   * deployment boots as. A test that needs a route mounted AFTER the plans
   * router has to set one: the admin tree is the only one there is, and
   * without a token it answers the ordinary unknown-path 404.
   */
  adminToken?: string | null;
}

/** A port nothing listens on. Reserved by IANA for documentation, so it is not somebody's development server. */
const UNREACHABLE_UPSTREAM_URL = 'http://127.0.0.1:1';

export async function startPlansHarness(options: StartPlansHarnessOptions): Promise<PlansHarness> {
  const received: RecordedUpstreamRequest[] = [];
  const reply: UpstreamReply = { status: 200, body: JSON.stringify({ ok: true }), contentType: 'application/json' };
  const sockets = new Set<Socket>();

  const upstream = createServer((request: IncomingMessage, response: ServerResponse) => {
    const chunks: Buffer[] = [];
    request.on('data', (piece: Buffer) => chunks.push(piece));
    request.on('end', () => {
      const headers: Record<string, string | undefined> = {};
      for (const [name, value] of Object.entries(request.headers)) {
        headers[name] = Array.isArray(value) ? value.join(', ') : value;
      }
      received.push({
        method: request.method ?? '',
        url: request.url ?? '',
        headers,
        body: Buffer.concat(chunks).toString('utf8'),
      });
      // A hang is an accepted request that is never answered, which is exactly
      // what a biller stuck on its own database looks like from here.
      if (reply.hang === true) return;
      response.writeHead(reply.status, reply.contentType === null ? {} : { 'content-type': reply.contentType });
      response.end(reply.body);
    });
  });
  upstream.on('connection', (socket: Socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });
  upstream.listen(0);
  await new Promise<void>((resolve) => upstream.once('listening', resolve));
  // SAFETY: `listen(0)` binds a TCP port; Node returns a string address only
  // for a Unix domain socket, which this never opens.
  const upstreamPort = (upstream.address() as AddressInfo).port;
  // THE BASE CARRIES A PATH, as a real one does: spec 03 puts the biller's
  // internal surface at `/plans/*`, so `PLANS_UPSTREAM_URL` ends in `/plans`
  // and this service appends its own suffix to it. A base at the bare origin
  // would make the escape check below untestable, because every `..` would
  // still land inside it.
  const upstreamBaseUrl = `http://127.0.0.1:${upstreamPort}/plans`;

  const fixture = createAuthFixture();
  const seeded = await fixture.store.seedAccount({ email: 'anna@example.org', dailyAiLimit: 200 });
  const accessToken = 'a-live-access-token';
  await fixture.store.insertTokens([
    {
      accountId: seeded.id,
      kind: 'access',
      tokenHash: hashToken(accessToken),
      familyId: 'family-1',
      expiresAt: new Date(fixture.now().getTime() + 60_000),
    },
  ]);

  const app = createApp({
    authContext: fixture.ctx,
    storage: createFakeStorageAdapter(),
    rotation: createFakeRotationStore(),
    throttle: createThrottleStore({ freeAttempts: 10_000, baseLockoutMs: 1, maxLockoutMs: 1, attemptResetMs: 1 }),
    logger: createSilentLogger(),
    trustProxy: false,
    mailer: fixture.mailer,
    now: fixture.now,
    admin: {
      token: options.adminToken ?? null,
      metadata: createFakeAdminStore(),
      invites: createFakeInviteStore(),
      links: null,
    },
    plans: options.configured
      ? {
          baseUrl: options.unreachable === true ? UNREACHABLE_UPSTREAM_URL : upstreamBaseUrl,
          secret: options.secret ?? 'a-shared-secret',
          timeoutMs: options.timeoutMs,
        }
      : null,
  });

  const server: Server = app.listen(0);
  await new Promise<void>((resolve) => server.once('listening', resolve));
  // SAFETY: the same `listen(0)` argument as above.
  const { port } = server.address() as AddressInfo;
  const baseUrl = `http://127.0.0.1:${port}`;

  return {
    baseUrl,
    accessToken,
    account: { id: seeded.id, email: seeded.email },
    received,
    reply,
    upstreamBaseUrl,
    async request(input): Promise<Response> {
      const headers = { ...input.headers } satisfies Record<string, string>;
      const token = input.token ?? null;
      if (token !== null) headers.authorization = `Bearer ${token}`;
      return fetch(`${baseUrl}${input.path}`, { method: input.method, headers, body: input.body });
    },
    async close(): Promise<void> {
      // The hang cases leave a socket open on purpose, and `close` waits for
      // every connection, so the sockets are destroyed first or the suite
      // never finishes.
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
      await new Promise<void>((resolve, reject) => upstream.close((error) => (error ? reject(error) : resolve())));
    },
  };
}
