/**
 * The retention window a person is PROMISED is the one this service KEEPS.
 *
 * WHY THIS FILE EXISTS. The number lived twice: here, where the sweep deletes
 * on it, and in the app's consent dialog, where a person reads it just before
 * they hand over a photograph of their food. Two copies in two repositories
 * that cannot import each other is one wrong sentence away from a false
 * statement made at the exact moment somebody is deciding. So the service
 * ADVERTISES its own window on `/health` and the app reads it.
 *
 * AND TWO MATCHING LITERALS WOULD PROVE NOTHING. A test that asserted
 * `retentionDays === 30` beside a constant that says `30` passes on the day
 * somebody changes one of them. So the assertions below never name a number:
 * the window is taken OFF THE WIRE, and then used to build a report that is
 * one minute over age and one that is one minute under, which the real purge
 * is then asked to sweep. The advertised value is proven to be the value the
 * deletion happens on, whatever it is.
 *
 * THE ABSENCE BRANCH IS THE OTHER HALF. An instance with `SYNC_FEEDBACK` unset
 * has no promise to make, so it must send no field at all — the same bargain
 * its 404 makes for the `/v1/feedback` tree, and what keeps it
 * indistinguishable from an instance built before any of this existed.
 */
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { fileURLToPath } from 'node:url';

import { createApp } from '../../src/server/create-app.js';
import { isProtocolHandshake, type InstanceInfo } from '../../src/protocol.js';
import { asNumber, asObject, type JsonObject, type JsonValue } from '../../src/lib/json.js';
import { createThrottleStore } from '../../src/lib/throttle.js';
import { createSilentLogger } from '../../src/logger.js';
import {
  feedbackRetentionAdvertisement,
  feedbackRetentionCutoff,
  purgeExpiredFeedback,
} from '../../src/feedback/feedback-retention.js';
import { createAuthFixture } from './auth-context-fixture.js';
import { createFakeStorageAdapter } from './fake-storage-adapter.js';
import { createFakeRotationStore } from './fake-rotation-store.js';
import { createFakePulseStore } from './fake-pulse-store.js';
import { createFakeAdminStore } from './fake-admin-store.js';
import { createFakeInviteStore } from './fake-invite-store.js';
import { createFakeFeedbackAdminStore, createFakeFeedbackImageStore } from './feedback-harness.js';
import type { FeedbackReportDetail } from '../../src/feedback/feedback-admin-store.js';

const MS_PER_DAY = 24 * 60 * 60 * 1000;
const MS_PER_MINUTE = 60 * 1000;

const MAIN = fileURLToPath(new URL('../../src/main.ts', import.meta.url));

const servers: Server[] = [];

after(async () => {
  await Promise.all(servers.map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
});

/**
 * The instance block exactly as `main.ts` assembles it, for an instance whose
 * feedback surface is on or off. The wiring under test is the CONDITIONAL: the
 * field is added by the same expression the service uses, or not added at all.
 */
function instanceInfo({ feedbackEnabled }: { feedbackEnabled: boolean }): InstanceInfo {
  const instance: InstanceInfo = {
    name: 'openplate',
    language: 'en',
    mail: false,
    memberInvites: false,
    ai: null,
    plans: false,
  };
  if (feedbackEnabled) instance.feedback = feedbackRetentionAdvertisement();
  return instance;
}

/** Reads `/health` off a real listening app, so this observes a PUBLICATION rather than an object literal. */
async function readHandshake(instance: InstanceInfo): Promise<JsonObject> {
  const fixture = createAuthFixture();
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
    instance,
    admin: { token: null, metadata: createFakeAdminStore(), invites: createFakeInviteStore() },
  });
  const server = app.listen(0);
  servers.push(server);
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const address = server.address();
  if (address === null) throw new Error('expected a listening server');
  // SAFETY: `listen(0)` binds a TCP port; Node only returns a string address
  // for a Unix domain socket, which this never opens.
  const { port } = address as AddressInfo;

  const response = await fetch(`http://127.0.0.1:${port}/health`);
  assert.equal(response.status, 200);
  const body: JsonValue = await response.json();
  const decoded = asObject(body);
  assert.ok(decoded !== null, 'the handshake body must be a JSON object');
  return decoded;
}

/** The advertised window, decoded off the wire the way a client decodes it. Never a constant read from source. */
async function readAdvertisedRetentionDays(): Promise<number> {
  const body = await readHandshake(instanceInfo({ feedbackEnabled: true }));
  const instance = asObject(body.instance);
  assert.ok(instance !== null, 'an instance that accepts reports must publish an instance block');
  const feedback = asObject(instance.feedback);
  assert.ok(feedback !== null, 'an instance that accepts reports must publish its retention window');
  const days = asNumber(feedback.retentionDays);
  assert.ok(days !== null, 'retentionDays must be a number a client can put in a sentence');
  return days;
}

function sampleReport(input: { id: number; createdAt: Date }): FeedbackReportDetail {
  return {
    id: input.id,
    accountId: 1,
    hasImage: true,
    measurements: { carbohydrateGrams: 12 },
    consentAgreedAt: input.createdAt,
    consentWordingVersion: 'feedback-consent:v1',
    createdAt: input.createdAt,
  };
}

test('the number /health advertises is the number the sweep deletes on', async () => {
  const retentionDays = await readAdvertisedRetentionDays();

  // Straddling the advertised window by a minute on each side. Nothing here
  // names a number of days: if the constant moves and the advertisement does
  // not, these two reports land on the wrong side of the cutoff and the
  // assertions below fail.
  const now = new Date('2026-09-07T12:00:00.000Z');
  const overAge = new Date(now.getTime() - retentionDays * MS_PER_DAY - MS_PER_MINUTE);
  const insideWindow = new Date(now.getTime() - retentionDays * MS_PER_DAY + MS_PER_MINUTE);

  const rows = [sampleReport({ id: 1, createdAt: overAge }), sampleReport({ id: 2, createdAt: insideWindow })];
  const reports = createFakeFeedbackAdminStore(rows);
  const images = createFakeFeedbackImageStore();
  images.images.set(1, { contentType: 'image/jpeg', bytes: Buffer.from([1, 2, 3]) });
  images.images.set(2, { contentType: 'image/jpeg', bytes: Buffer.from([4, 5, 6]) });

  const result = await purgeExpiredFeedback({
    reports,
    images,
    before: feedbackRetentionCutoff(now),
  });

  assert.equal(result.deleted, 1);
  assert.deepEqual(
    rows.map((row) => row.id),
    [2],
    'a report one minute past the ADVERTISED window must be gone, and one a minute inside it must remain',
  );
  assert.equal(images.images.has(1), false, 'the photograph goes with the row the promise covered');
  assert.equal(images.images.has(2), true);
});

test('an instance that accepts no reports advertises no window at all', async () => {
  const body = await readHandshake(instanceInfo({ feedbackEnabled: false }));

  const instance = asObject(body.instance);
  assert.ok(instance !== null);
  // ABSENT, not `null`. A key carrying `null` would tell a prober this build
  // has the feature and that this operator turned it off, and it would make an
  // instance without it distinguishable from one built before it existed.
  assert.ok(!('feedback' in instance), 'an instance with the feature off must add no key to the healthcheck body');
  // And the rest of the handshake is untouched: additive or nothing.
  assert.ok(isProtocolHandshake(body), 'the body must still decode as a handshake');
  assert.deepEqual(instance, { name: 'openplate', language: 'en', mail: false, memberInvites: false, ai: null, plans: false });
});

test('the service wires the advertisement from the retention module, under the feedback gate', () => {
  // A SOURCE READ, because the wiring is the one step no request can observe:
  // the tests above hand `createApp` an instance block, and `main.ts` is what
  // builds the real one. A literal typed in there would satisfy every
  // assertion above while promising a window nothing sweeps on.
  const source = readFileSync(MAIN, 'utf8');

  assert.match(
    source,
    /if \(feedback !== null\) instance\.feedback = feedbackRetentionAdvertisement\(\);/,
    'the published window must come from the retention module, and only when the feature is on',
  );
  // No second literal anywhere in the entry point: the days may be named only
  // by the constant, never typed out beside it.
  assert.doesNotMatch(source, /retentionDays:\s*\d/, 'main.ts must never write a retention number of its own');
});
