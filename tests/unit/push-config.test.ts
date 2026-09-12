/**
 * With no VAPID keys, web push does not exist here, to anybody, and the
 * handshake says so.
 *
 * WHY THAT MATTERS ON THIS SERVICE. It auto-deploys on push, so the commit that
 * adds this subtree is the commit that puts it in production, on an instance
 * with real accounts on it and on every self-hoster's instance the next time
 * they pull an image. The only thing that makes that safe is that an
 * unconfigured deployment is INDISTINGUISHABLE from one where the feature was
 * never written. It is ADR-0001's bargain, kept by the admin, share, research,
 * AI, feedback and plans trees already.
 *
 * A 401 WOULD BE THE FAILURE, and this subtree invites it: the configured
 * version mounts its OWN bearer middleware, so a terminator written one line
 * too low would stand behind a gate and answer 401 to an anonymous probe. Every
 * case below therefore includes an anonymous caller, a well formed token this
 * instance never minted, and a LIVE token of a real account on it.
 *
 * AND THE DOOR IS PROVEN TO OPEN. The configured half of this file boots the
 * same app with keys and shows the same paths answering something other than
 * 404, and the handshake flipping to `push: true`. Without it the file would
 * pass unchanged if the subtree were deleted, misspelled or never written: it
 * would be asserting that an unknown path is unknown.
 *
 * THE BOOT FAILURE IS HERE TOO, because it is the same question asked of the
 * environment rather than of a socket: two of three `VAPID_*` variables is an
 * operator who believes their users are getting a morning catch-up.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createApp } from '../../src/server/create-app.js';
import { parseConfig } from '../../src/config.js';
import { createThrottleStore } from '../../src/lib/throttle.js';
import { createSilentLogger } from '../../src/logger.js';
import { hashToken } from '../../src/lib/tokens.js';
import { asBoolean, asObject, type JsonValue } from '../../src/lib/json.js';
import { createFakeStorageAdapter } from './fake-storage-adapter.js';
import { createFakeRotationStore } from './fake-rotation-store.js';
import { createFakePulseStore } from './fake-pulse-store.js';
import { createFakeAdminStore } from './fake-admin-store.js';
import { createFakeInviteStore } from './fake-invite-store.js';
import { createAuthFixture } from './auth-context-fixture.js';
import { createFakePushStore } from './fake-push-store.js';
import { createFakeBlobRollbackStore } from './fake-blob-rollback-store.js';

/** Every path the push family occupies, plus the subtree around it and the bare prefix. */
const PUSH_ROUTES: readonly { method: string; path: string; body?: string }[] = [
  { method: 'GET', path: '/v1/push' },
  { method: 'GET', path: '/v1/push/config' },
  { method: 'PUT', path: '/v1/push/subscriptions', body: '{}' },
  { method: 'PATCH', path: '/v1/push/subscriptions', body: '{}' },
  { method: 'DELETE', path: '/v1/push/subscriptions', body: '{}' },
  { method: 'GET', path: '/v1/push/anything-else' },
];

/** A syntactically perfect credential this instance never minted. It must buy nothing. */
const VALID_LOOKING_TOKEN = 'a'.repeat(48);

/** The public key the configured instance advertises. Public by definition, and not a real one. */
const PUBLIC_KEY = 'BTestOnlyApplicationServerKeyNotRealAtAll';

interface ConfigHarness {
  baseUrl: string;
  /** A live access token for the seeded account. Every other authenticated route on this app accepts it. */
  accessToken: string;
  request(input: { method: string; path: string; token?: string | null; body?: string }): Promise<Response>;
  close(): Promise<void>;
}

/** The REAL app, with fake stores, with or without a push surface. Nothing here assembles a router by hand. */
async function startConfigHarness(options: { push: boolean }): Promise<ConfigHarness> {
  const fixture = createAuthFixture();
  const seeded = await fixture.store.seedAccount({ email: 'anna@example.org' });
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
    pulse: createFakePulseStore(),
    throttle: createThrottleStore({ freeAttempts: 10_000, baseLockoutMs: 1, maxLockoutMs: 1, attemptResetMs: 1 }),
    logger: createSilentLogger(),
    trustProxy: false,
    mailer: fixture.mailer,
    now: fixture.now,
    admin: { token: null, blobs: createFakeBlobRollbackStore(), metadata: createFakeAdminStore(), invites: createFakeInviteStore(), links: null },
    // BUILT FROM THE SAME FLAG that decides the surface, exactly as `main.ts`
    // builds both from `config.push`. A harness that reported one and mounted
    // the other would let a service that advertises a door it has not got pass.
    push: options.push ? { store: createFakePushStore(), publicKey: PUBLIC_KEY } : null,
    instance: {
      name: 'openplate',
      language: 'en',
      mail: false,
      memberInvites: false,
      ai: null,
      plans: false,
      push: options.push,
    },
  });

  const server: Server = app.listen(0);
  await new Promise<void>((resolve) => server.once('listening', resolve));
  // SAFETY: `listen(0)` binds a TCP port; Node returns a string address only
  // for a Unix domain socket, which this never opens.
  const { port } = server.address() as AddressInfo;
  const baseUrl = `http://127.0.0.1:${port}`;

  return {
    baseUrl,
    accessToken,
    async request(input: { method: string; path: string; token?: string | null; body?: string }): Promise<Response> {
      const headers = new Headers({ 'content-type': 'application/json' });
      const token = input.token ?? null;
      if (token !== null) headers.set('authorization', `Bearer ${token}`);
      return fetch(`${baseUrl}${input.path}`, { method: input.method, headers, body: input.body });
    },
    async close(): Promise<void> {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

/** The `instance.push` field off `GET /health`, or `null` when the block is absent. */
async function handshakePush(harness: ConfigHarness): Promise<boolean | null> {
  const response = await harness.request({ method: 'GET', path: '/health' });
  // SAFETY: `json()` resolves whatever the service wrote, which is JSON by
  // construction; the assertion widens it to the boundary type `lib/json.ts`
  // decodes, and `asObject` is TOTAL over that type.
  const body = asObject((await response.json()) as JsonValue);
  return asBoolean(asObject(body?.instance)?.push);
}

let dark: ConfigHarness;
let lit: ConfigHarness;

before(async () => {
  dark = await startConfigHarness({ push: false });
  lit = await startConfigHarness({ push: true });
});

after(async () => {
  await dark.close();
  await lit.close();
});

test('with no VAPID keys the handshake says push: false', async () => {
  assert.equal(await handshakePush(dark), false);
});

test('with keys configured it says push: true, which is the control', async () => {
  // Without this the assertion above would pass against a field hardcoded to
  // `false`, or against a handshake that never carried the field at all.
  assert.equal(await handshakePush(lit), true);
});

test('every push path 404s for an anonymous caller, never 401', async () => {
  for (const route of PUSH_ROUTES) {
    const response = await dark.request(route);
    assert.equal(response.status, 404, `${route.method} ${route.path} must be 404 without a token`);
  }
});

test('a well-formed bearer token buys nothing on the push tree', async () => {
  for (const route of PUSH_ROUTES) {
    const response = await dark.request({ ...route, token: VALID_LOOKING_TOKEN });
    assert.equal(response.status, 404, `${route.method} ${route.path} with a bearer token must be 404`);
  }
});

test('a signed-in account on this very instance finds nothing either', async () => {
  // THE STRONGEST CASE, and the one a 401-shaped mistake sails through: this
  // token is live here, so every other authenticated route accepts it.
  for (const route of PUSH_ROUTES) {
    const response = await dark.request({ ...route, token: dark.accessToken });
    assert.equal(response.status, 404, `${route.method} ${route.path} signed in must be 404`);
  }
});

test('with keys configured the same paths are alive, which is what makes the 404s above mean something', async () => {
  const config = await lit.request({ method: 'GET', path: '/v1/push/config', token: lit.accessToken });
  assert.equal(config.status, 200);
  // SAFETY: as above, a parsed response body widened to the boundary type.
  const body = asObject((await config.json()) as JsonValue);
  assert.equal(body?.publicKey, PUBLIC_KEY, 'the application server key a browser needs to subscribe at all');

  // And the write routes exist: a bad body is a 400 from the route rather than
  // a 404 from the fallthrough, which is the difference between "refused" and
  // "not here".
  const bad = await lit.request({
    method: 'PUT',
    path: '/v1/push/subscriptions',
    token: lit.accessToken,
    body: '{}',
  });
  assert.equal(bad.status, 400);
});

test('the configured subtree still refuses an anonymous caller with a 401', async () => {
  // The other half of the bargain: dark is 404 to everybody, lit is 401 to a
  // stranger. A subtree that answered 404 here would be one whose bearer gate
  // never ran.
  const response = await lit.request({ method: 'GET', path: '/v1/push/config' });
  assert.equal(response.status, 401);
});

test('two of the three VAPID variables is a boot failure that names the missing one', async () => {
  const base = { SERVER_SECRET: 'x'.repeat(40), DATABASE_URL: 'postgres://localhost/x' };

  assert.throws(
    () => parseConfig({ ...base, VAPID_PUBLIC_KEY: 'pub', VAPID_PRIVATE_KEY: 'priv' }),
    /VAPID_SUBJECT/,
    'a pair with no subject must name the subject',
  );
  assert.throws(
    () => parseConfig({ ...base, VAPID_PUBLIC_KEY: 'pub', VAPID_SUBJECT: 'mailto:a@b.c' }),
    /VAPID_PRIVATE_KEY/,
    'a public key with no private key must name the private key',
  );
  assert.throws(
    () => parseConfig({ ...base, VAPID_PRIVATE_KEY: 'priv', VAPID_SUBJECT: 'mailto:a@b.c' }),
    /VAPID_PUBLIC_KEY/,
  );
});

test('none of them is the default and boots cleanly, which is the control for the refusals above', async () => {
  // Without this, a parser that threw on ANY push configuration would pass
  // every assertion above and would stop every existing instance booting.
  const config = parseConfig({ SERVER_SECRET: 'x'.repeat(40), DATABASE_URL: 'postgres://localhost/x' });
  assert.equal(config.push, null);
});

test('all three boot, and the subject scheme is checked', async () => {
  const base = {
    SERVER_SECRET: 'x'.repeat(40),
    DATABASE_URL: 'postgres://localhost/x',
    VAPID_PUBLIC_KEY: 'pub',
    VAPID_PRIVATE_KEY: 'priv',
  };

  const config = parseConfig({ ...base, VAPID_SUBJECT: 'mailto:ops@example.org' });
  assert.deepEqual(config.push, { publicKey: 'pub', privateKey: 'priv', subject: 'mailto:ops@example.org' });

  // RFC 8292 asks for a way to reach the operator. A `javascript:` subject is
  // not one, and neither is a bare word.
  assert.throws(() => parseConfig({ ...base, VAPID_SUBJECT: 'ops@example.org' }), /VAPID_SUBJECT/);
  assert.throws(() => parseConfig({ ...base, VAPID_SUBJECT: 'javascript:alert(1)' }), /scheme/);
});

test('the boot failure never prints a key', async () => {
  // A private key in a startup log is a private key in a log, which is the
  // reason `parsePush` names variables rather than values.
  const secret = 'a-private-key-nobody-should-ever-see';
  assert.throws(
    () =>
      parseConfig({
        SERVER_SECRET: 'x'.repeat(40),
        DATABASE_URL: 'postgres://localhost/x',
        VAPID_PRIVATE_KEY: secret,
      }),
    (cause: unknown) => cause instanceof Error && !cause.message.includes(secret),
  );
});
