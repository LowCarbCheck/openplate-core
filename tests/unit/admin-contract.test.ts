/**
 * The instance-settings wire, as THIS repository serves it (M234).
 *
 * ── WHY IT IS ITS OWN FILE ───────────────────────────────────────────────
 *
 * `openplate` carries a hand transcription of this contract
 * (`app/lib/admin/admin-wire.ts` and `app/lib/sync/engine/protocol.ts`) and
 * pins it in `tests/unit/admin-wire.test.ts` against literals copied from
 * `PROTOCOL.md`. This file is the other side of that pair: the same literals,
 * driven against the REAL router and the REAL `/health` handler. Neither test
 * reads the other repository, which is the point. Two copies with no proof on
 * each side drift in silence, and both suites stay green while the app and the
 * service disagree about what a body looks like.
 *
 * ── WHAT IS ASSERTED ARE BODIES, NOT CALLS ───────────────────────────────
 *
 * Every assertion below is on JSON that came back over a socket: the request
 * body the client sends, the `{"settings": …}` envelope the route answers
 * with, and the field `/health` publishes. A test that called
 * `settings.set(...)` and checked a variable would pass for a service that
 * spelled the route, the field or the envelope differently.
 *
 * ── AND THE REFUSALS, WHICH ARE HALF THE CONTRACT ────────────────────────
 *
 * A fourth name and an empty patch are both `400`, and NOTHING is written.
 * Those are the controls: a route that wrote whatever it was given, or that
 * fell back to a default, would pass the happy case alone.
 */
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import { createApp } from '../../src/server/create-app.js';
import {
  startInstanceSettings,
  type InstanceSettings,
  type InstanceSettingsRecord,
  type InstanceSettingsStore,
} from '../../src/instance/instance-settings.js';
import type { NutrientReferenceBasis } from '../../src/protocol.js';
import { asObject, asString, type JsonObject, type JsonValue } from '../../src/lib/json.js';
import { createThrottleStore } from '../../src/lib/throttle.js';
import { createSilentLogger } from '../../src/logger.js';
import { createAuthFixture } from './auth-context-fixture.js';
import { createFakeStorageAdapter } from './fake-storage-adapter.js';
import { createFakeRotationStore } from './fake-rotation-store.js';
import { createFakePulseStore } from './fake-pulse-store.js';
import { createFakeLegalDeclarationsStore } from './fake-legal-declarations-store.js';
import { createFakeAdminStore } from './fake-admin-store.js';
import { createFakeInviteStore } from './fake-invite-store.js';
import { createFakeBlobRollbackStore } from './fake-blob-rollback-store.js';

/** The path, spelled out as `PROTOCOL.md` §5.20's route table gives it. */
const SETTINGS_PATH = '/v1/admin/settings';

/** The operator's break-glass credential for this harness. Long enough for the config guard. */
const ADMIN_TOKEN = 'admin-contract-token-0123456789';

const servers: Server[] = [];
const running: InstanceSettings[] = [];

after(async () => {
  for (const settings of running) settings.stop();
  await Promise.all(servers.map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
});

/** The single stored row, in memory. The row's persistence is the integration tier's subject, not this one's. */
function memoryStore(initial: NutrientReferenceBasis | null): InstanceSettingsStore {
  let row: InstanceSettingsRecord | null =
    initial === null ? null : { nutrientReferenceBasis: initial, updatedAt: new Date(0) };
  return {
    async read(): Promise<InstanceSettingsRecord | null> {
      return row;
    },
    async write(input: { nutrientReferenceBasis: NutrientReferenceBasis; now: Date }): Promise<InstanceSettingsRecord> {
      row = { nutrientReferenceBasis: input.nutrientReferenceBasis, updatedAt: input.now };
      return row;
    },
  };
}

interface Harness {
  request(input: { method: string; path: string; body?: JsonValue; token?: string }): Promise<Response>;
  /** What the process holds now, read off the same surface `/health` publishes from. */
  current(): NutrientReferenceBasis;
}

/**
 * The real app, with the real settings surface over an in-memory row.
 *
 * `settings: null` builds the OTHER instance this contract describes: a
 * service that wires none, whose `/health` omits the field entirely and whose
 * `PATCH` answers the ordinary unknown-path 404.
 */
async function startHarness({ basis }: { basis: NutrientReferenceBasis | null }): Promise<Harness> {
  const fixture = createAuthFixture();
  const settings =
    basis === null
      ? null
      : await startInstanceSettings({
          store: memoryStore(basis),
          fallback: basis,
          logger: createSilentLogger(),
          // Long past the end of the run: this file is about the wire, and a
          // timer firing mid-test would be a second writer nobody asked for.
          refreshIntervalMs: 60 * 60 * 1000,
        });
  if (settings !== null) running.push(settings);

  const app = createApp({
    authContext: fixture.ctx,
    storage: createFakeStorageAdapter(),
    rotation: createFakeRotationStore(),
    pulse: createFakePulseStore(),
    legal: { store: createFakeLegalDeclarationsStore() },
    throttle: createThrottleStore({ freeAttempts: 10_000, baseLockoutMs: 1, maxLockoutMs: 1, attemptResetMs: 1 }),
    logger: createSilentLogger(),
    trustProxy: false,
    instance: {
      name: 'openplate',
      language: 'en',
      mail: false,
      memberInvites: false,
      openSignup: false,
      ai: null,
      push: false,
      plans: false,
    },
    settings,
    admin: {
      token: ADMIN_TOKEN,
      blobs: createFakeBlobRollbackStore(),
      metadata: createFakeAdminStore(),
      invites: createFakeInviteStore(),
    },
  });

  const server = app.listen(0);
  servers.push(server);
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const address = server.address();
  if (address === null) throw new Error('expected a listening server');
  // SAFETY: `listen(0)` binds a TCP port; Node only returns a string address
  // for a Unix domain socket, which this never opens.
  const { port } = address as AddressInfo;
  const baseUrl = `http://127.0.0.1:${port}`;

  return {
    async request(input: { method: string; path: string; body?: JsonValue; token?: string }): Promise<Response> {
      const headers: Record<string, string> = {};
      const token = input.token ?? ADMIN_TOKEN;
      if (token !== '') headers.authorization = `Bearer ${token}`;
      if (input.body !== undefined) headers['content-type'] = 'application/json';
      return fetch(`${baseUrl}${input.path}`, {
        method: input.method,
        headers,
        body: input.body === undefined ? undefined : JSON.stringify(input.body),
      });
    },
    current(): NutrientReferenceBasis {
      if (settings === null) throw new Error('this harness wired no settings surface');
      return settings.current();
    },
  };
}

/** The `instance` block off a live `/health`, as a client decodes it. */
async function readInstance(harness: Harness): Promise<JsonObject> {
  const response = await harness.request({ method: 'GET', path: '/health', token: '' });
  assert.equal(response.status, 200, '/health must answer 200');
  const body = asObject(await response.json());
  assert.ok(body !== null, 'the handshake body must be a JSON object');
  const instance = asObject(body.instance);
  assert.ok(instance !== null, 'this harness publishes an instance block');
  return instance;
}

test('a patch naming a basis is answered with the wrapped settings the instance now holds', async () => {
  const harness = await startHarness({ basis: 'dge' });

  // The request body, copied from PROTOCOL.md §5.20.
  const response = await harness.request({
    method: 'PATCH',
    path: SETTINGS_PATH,
    body: { nutrientReferenceBasis: 'efsa' },
  });

  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { settings: { nutrientReferenceBasis: 'efsa' } });
  assert.equal(harness.current(), 'efsa', 'the process adopts what it stored');
});

test('the handshake publishes the basis, and the next read of it carries a change', async () => {
  const harness = await startHarness({ basis: 'dge' });

  assert.equal(asString((await readInstance(harness)).nutrientReferenceBasis), 'dge');

  const response = await harness.request({
    method: 'PATCH',
    path: SETTINGS_PATH,
    body: { nutrientReferenceBasis: 'us' },
  });
  assert.equal(response.status, 200);

  // READ AGAIN, because this is the field's whole purpose: an administrator
  // changes it while the service runs, so a value merged at boot would keep
  // publishing the old answer until a redeploy.
  assert.equal(asString((await readInstance(harness)).nutrientReferenceBasis), 'us');
});

test('a fourth name is refused and nothing is written', async () => {
  const harness = await startHarness({ basis: 'dge' });

  const response = await harness.request({
    method: 'PATCH',
    path: SETTINGS_PATH,
    body: { nutrientReferenceBasis: 'eu' },
  });

  assert.equal(response.status, 400);
  assert.equal(harness.current(), 'dge', 'a refused value must leave the instance where it was');
  assert.equal(asString((await readInstance(harness)).nutrientReferenceBasis), 'dge');
});

test('a patch that names nothing is refused, rather than read as a request for the default', async () => {
  const harness = await startHarness({ basis: 'efsa' });

  const response = await harness.request({ method: 'PATCH', path: SETTINGS_PATH, body: {} });

  assert.equal(response.status, 400);
  assert.equal(harness.current(), 'efsa');
});

test('a service that wires no settings surface publishes no basis and offers no route', async () => {
  const harness = await startHarness({ basis: null });

  const instance = await readInstance(harness);
  // ABSENT, NOT A DEFAULT. This is what a client older than M234 sees, and what
  // a self-hoster with no stored row sees, and the app's own decoder treats the
  // two the same: it names no basis and takes the server's own.
  assert.equal(instance.nutrientReferenceBasis, undefined);

  const response = await harness.request({
    method: 'PATCH',
    path: SETTINGS_PATH,
    body: { nutrientReferenceBasis: 'us' },
  });
  assert.equal(response.status, 404, 'the ordinary unknown-path answer, never a 501 announcing a feature that is off');
});
