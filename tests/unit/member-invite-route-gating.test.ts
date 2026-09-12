/**
 * With the two member-invite settings unset, `POST /v1/auth/invites` does not
 * exist, to anybody.
 *
 * WHY THIS IS THE FIRST TEST AND NOT A LATER HARDENING PASS. This service
 * auto-deploys on push, so the commit that adds this route is the commit that
 * puts it in production, on an instance with real accounts on it. What makes
 * shipping it before any operator has opted in safe is that an unconfigured
 * deployment is INDISTINGUISHABLE from one where the feature was never written,
 * which is the same bargain ADR-0001 struck for the admin API and
 * `feedback-route-gating.test.ts` makes for the report tree.
 *
 * A 401 WOULD BE THE FAILURE on the dark instance, because it announces that a
 * credential exists here and is merely locked. So the dark cases below include
 * an anonymous caller AND a caller holding a perfectly well-formed bearer
 * token, which is what a "did we forget the gate" bug sails through.
 *
 * AND THE DOOR IS PROVEN TO OPEN. The last test boots the same app with the
 * feature ON and shows the same path answering `401` rather than `404` to the
 * same anonymous probe. Without it this file would pass unchanged if the route
 * were deleted, misspelled, or never written: it would be asserting that an
 * unknown path is unknown. What the route then DOES for a real session is
 * `member-invites.test.ts`.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createApp } from '../../src/server/create-app.js';
import { createThrottleStore } from '../../src/lib/throttle.js';
import { createSilentLogger } from '../../src/logger.js';
import { createFakeStorageAdapter } from './fake-storage-adapter.js';
import { createFakeRotationStore } from './fake-rotation-store.js';
import { createFakePulseStore } from './fake-pulse-store.js';
import { createFakeAdminStore } from './fake-admin-store.js';
import { createFakeInviteStore } from './fake-invite-store.js';
import { createAuthFixture } from './auth-context-fixture.js';

/** A syntactically perfect credential. It must buy nothing on a dark instance, because there is nothing to buy. */
const VALID_LOOKING_TOKEN = 'a'.repeat(48);

const MEMBER_INVITE_PATH = '/v1/auth/invites';

interface GatingHarness {
  request(input: { method: string; path: string; token?: string | null; body?: unknown }): Promise<Response>;
  close(): Promise<void>;
}

/**
 * Boots the REAL app with fake stores, so what is exercised is the actual mount
 * decision rather than a router this test assembled. That is the whole point:
 * the property is "nothing that answers 401 exists on this path", and a test
 * that built the route itself could not observe it.
 */
async function startGatingHarness(memberInvites: boolean): Promise<GatingHarness> {
  const fixture = createAuthFixture();
  if (memberInvites) {
    fixture.ctx.memberInvites = { invites: createFakeInviteStore(), policy: { dailyAiLimit: 50, allowanceDays: 30 } };
  }

  const app = createApp({
    authContext: fixture.ctx,
    storage: createFakeStorageAdapter(),
    rotation: createFakeRotationStore(),
    // Required on every app. The pulse has no operator flag, so a harness that
    // is not about it still has to hand one over. See ADR-0007.
    pulse: createFakePulseStore(),
    throttle: createThrottleStore({ freeAttempts: 10_000, baseLockoutMs: 1, maxLockoutMs: 1, attemptResetMs: 1 }),
    logger: createSilentLogger(),
    trustProxy: false,
    mailer: fixture.mailer,
    now: fixture.now,
    admin: { token: null, metadata: createFakeAdminStore(), invites: createFakeInviteStore(), links: null },
  });

  const server: Server = app.listen(0);
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const address = server.address();
  if (address === null) throw new Error('expected a listening server');
  // SAFETY: `listen(0)` binds a TCP port, and Node only returns the string form
  // of an address for a Unix domain socket, which this never opens.
  const { port } = address as AddressInfo;
  const baseUrl = `http://127.0.0.1:${port}`;

  return {
    async request(input: { method: string; path: string; token?: string | null; body?: unknown }): Promise<Response> {
      const headers: Record<string, string> = {};
      headers['content-type'] = 'application/json';
      const token = input.token ?? null;
      if (token !== null) headers.authorization = `Bearer ${token}`;
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

let dark: GatingHarness;

before(async () => {
  dark = await startGatingHarness(false);
});

after(async () => {
  await dark.close();
});

test('the member mint 404s for an anonymous caller, never 401', async () => {
  const response = await dark.request({ method: 'POST', path: MEMBER_INVITE_PATH, body: { email: 'a@b.test' } });
  assert.equal(response.status, 404, `the path must be 404 without a token, not ${response.status}`);
});

test('a well-formed bearer token buys nothing on the member mint', async () => {
  const response = await dark.request({
    method: 'POST',
    path: MEMBER_INVITE_PATH,
    token: VALID_LOOKING_TOKEN,
    body: { email: 'a@b.test' },
  });
  assert.equal(response.status, 404, `the path must be 404 with a bearer token, not ${response.status}`);
});

test('the subtree around it is dark too, so a second verb is dark by default', async () => {
  for (const route of [
    { method: 'GET', path: MEMBER_INVITE_PATH },
    { method: 'POST', path: `${MEMBER_INVITE_PATH}/1/resend` },
    { method: 'DELETE', path: `${MEMBER_INVITE_PATH}/1` },
  ]) {
    const response = await dark.request({ ...route, token: VALID_LOOKING_TOKEN });
    assert.equal(response.status, 404, `${route.method} ${route.path} must be 404, not ${response.status}`);
  }
});

test('the rest of the auth surface is unaffected by the terminator', async () => {
  // THE CONTROL FOR THE MOUNT ITSELF. `router.use(path, handleNotFound)` on a
  // prefix is one typo away from swallowing the whole `/v1/auth` tree, and
  // every assertion above would still pass if it did.
  const kdf = await dark.request({ method: 'POST', path: '/v1/auth/kdf', body: { email: 'a@b.test' } });
  assert.equal(kdf.status, 200, `/v1/auth/kdf must still answer, not ${kdf.status}`);
  const lookup = await dark.request({ method: 'POST', path: '/v1/auth/invite-lookup', body: { inviteToken: 'si_x' } });
  assert.equal(lookup.status, 404);
  // A 404 with the invite refusal in it, which is the HANDLER answering rather
  // than the terminator: `/v1/auth/invite-lookup` shares a prefix with nothing.
  assert.deepEqual(await lookup.json(), { error: 'invite-invalid' });
});

test('with the feature ON the same path is locked rather than absent', async () => {
  const lit = await startGatingHarness(true);
  try {
    const response = await lit.request({ method: 'POST', path: MEMBER_INVITE_PATH, body: { email: 'a@b.test' } });
    // 401, NOT 404: the route exists here and wants a session. This is the
    // assertion that fails if somebody deletes the route and leaves this file
    // behind.
    assert.equal(response.status, 401, `the mounted route must answer 401 to an anonymous caller, not ${response.status}`);
  } finally {
    await lit.close();
  }
});
