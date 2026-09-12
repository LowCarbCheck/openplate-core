/**
 * The shrink guard, at the handler and at the HTTP boundary (M224).
 *
 * ── WHAT EACH TEST IS FOR ───────────────────────────────────────────────────
 *
 * The refusal on its own would pass against a server that refuses every push,
 * so it is never asserted without its CONTROL: the same bytes, acknowledged,
 * must be accepted. And neither is asserted on the status alone — the property
 * that matters is that the STORED BLOB IS UNCHANGED, which is the one the
 * incident turned on.
 *
 * The boundary case (`BLOB_SHRINK_ACK_RATIO`) is here rather than only in
 * `blob-retention.test.ts` because the ratio being right in a pure function
 * says nothing about the handler having asked it.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import express from 'express';
import { handlePushBlob } from '../../src/server/push-handler.js';
import { registerSyncRoutes } from '../../src/server/register-routes.js';
import { createFakeStorageAdapter } from './fake-storage-adapter.js';
import type { SyncHostContext, SyncStorageAdapter } from '../../src/contract-types.js';
import { SHRINK_REFUSED_ERROR } from '../../src/protocol.js';
import { asNumber, asObject, asString, type JsonValue } from '../../src/lib/json.js';

const NOW = new Date('2026-09-12T12:00:00.000Z');

/** Opaque bytes of an exact length. The guard reads lengths and nothing else. */
function bytes(length: number): Uint8Array {
  return new Uint8Array(length).fill(7);
}

/** Seeds an account's stored blob at `sizeBytes`, and answers the version it landed on. */
async function seedBlob(storage: SyncStorageAdapter, accountId: number, sizeBytes: number): Promise<number> {
  const result = await handlePushBlob(
    { accountId, baseVersion: 0, envelopeVersion: 1, ciphertext: bytes(sizeBytes), shrinkAcknowledged: false, now: NOW },
    storage,
  );
  assert.equal(result.status, 'accepted');
  return result.status === 'accepted' ? result.newVersion : 0;
}

// ---------------------------------------------------------------------------
// The handler
// ---------------------------------------------------------------------------

test('an unacknowledged push under half the stored size is refused, and the stored bytes do not change', async () => {
  const storage = createFakeStorageAdapter();
  const baseVersion = await seedBlob(storage, 1, 5310);

  const result = await handlePushBlob(
    { accountId: 1, baseVersion, envelopeVersion: 1, ciphertext: bytes(1588), shrinkAcknowledged: false, now: NOW },
    storage,
  );

  assert.equal(result.status, 'shrink-refused');
  // THE ASSERTION THAT MATTERS. A status is a claim about a response; this is a
  // claim about the account's data, which is what the incident destroyed.
  const stored = await storage.getBlob(1);
  assert.equal(stored?.ciphertext.byteLength, 5310);
  assert.equal(stored?.blobVersion, baseVersion, 'a refused push must not consume a version either');
});

test('THE CONTROL: the same push WITH the acknowledgement is accepted', async () => {
  const storage = createFakeStorageAdapter();
  const baseVersion = await seedBlob(storage, 2, 5310);

  const result = await handlePushBlob(
    { accountId: 2, baseVersion, envelopeVersion: 1, ciphertext: bytes(1588), shrinkAcknowledged: true, now: NOW },
    storage,
  );

  assert.deepEqual(result, { status: 'accepted', newVersion: baseVersion + 1 });
  const stored = await storage.getBlob(2);
  assert.equal(stored?.ciphertext.byteLength, 1588);
});

test('a shrink just above the line is accepted unacknowledged: exactly half, and one byte over', async () => {
  const storage = createFakeStorageAdapter();
  const baseVersion = await seedBlob(storage, 3, 1000);

  const atHalf = await handlePushBlob(
    { accountId: 3, baseVersion, envelopeVersion: 1, ciphertext: bytes(500), shrinkAcknowledged: false, now: NOW },
    storage,
  );
  assert.equal(atHalf.status, 'accepted', 'exactly half is not a large shrink');

  // 500 stored now, so 250 is the new line and 251 is just above it.
  const justOver = await handlePushBlob(
    { accountId: 3, baseVersion: baseVersion + 1, envelopeVersion: 1, ciphertext: bytes(251), shrinkAcknowledged: false, now: NOW },
    storage,
  );
  assert.equal(justOver.status, 'accepted');
});

test('an account with no blob yet is never refused: a first push is not a deletion', async () => {
  const storage = createFakeStorageAdapter();
  const result = await handlePushBlob(
    { accountId: 4, baseVersion: 0, envelopeVersion: 1, ciphertext: bytes(1), shrinkAcknowledged: false, now: NOW },
    storage,
  );
  assert.equal(result.status, 'accepted');
});

test('a large shrink the CAS would have lost is a conflict, never a shrink refusal', async () => {
  // THE ORDERING ASSERTION. The acknowledgement is deliberately `false`, so
  // this can only pass if the CAS is consulted first: a client this stale must
  // be told to pull and merge, and a refusal would send it off to update an app
  // that is not the problem. It writes nothing either way.
  const storage = createFakeStorageAdapter();
  await seedBlob(storage, 5, 5310);
  const result = await handlePushBlob(
    { accountId: 5, baseVersion: 0, envelopeVersion: 1, ciphertext: bytes(1588), shrinkAcknowledged: false, now: NOW },
    storage,
  );
  assert.deepEqual(result, { status: 'conflict', currentVersion: 1 });
  assert.equal((await storage.getBlob(5))?.ciphertext.byteLength, 5310);
});

// ---------------------------------------------------------------------------
// The HTTP boundary
// ---------------------------------------------------------------------------

let server: Server;
let baseUrl: string;
let storage: SyncStorageAdapter;
let entitledUserId = 100;

before(async () => {
  const app = express();
  storage = createFakeStorageAdapter();
  const context: SyncHostContext = { storage, resolveEntitledUser: async () => ({ userId: entitledUserId }) };
  registerSyncRoutes(app, context);
  server = app.listen(0);
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const address = server.address();
  if (address === null) throw new Error('expected a listening server');
  // SAFETY: `listen(0)` binds a TCP port, and Node only returns the string form
  // of an address for a Unix domain socket, which this never opens.
  const { port } = address as AddressInfo;
  baseUrl = `http://127.0.0.1:${port}`;
});

after(async () => {
  await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
});

/** A push body as a test states it. `shrinkAcknowledged` is `unknown` because one case sends a string on purpose. */
interface PushRequestBody {
  baseVersion: number;
  envelopeVersion: number;
  ciphertext: string;
  shrinkAcknowledged?: unknown;
}

async function push(body: PushRequestBody): Promise<{ status: number; body: JsonValue }> {
  const response = await fetch(`${baseUrl}/v1/sync/blob`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  // SAFETY: every route under `SYNC_API_PREFIX` answers JSON on every status
  // (`register-routes.ts`), and `asObject`/`asNumber` below re-establish the
  // shape rather than trusting it.
  return { status: response.status, body: (await response.json()) as JsonValue };
}

function base64(length: number): string {
  return Buffer.from(bytes(length)).toString('base64');
}

test('the route answers 400 with a sentence a person can act on, and never 409', async () => {
  entitledUserId = 101;
  const seeded = await push({ baseVersion: 0, envelopeVersion: 1, ciphertext: base64(5310) });
  assert.equal(seeded.status, 200);

  const refused = await push({ baseVersion: 1, envelopeVersion: 1, ciphertext: base64(1588) });
  // 409 IS THE ONE STATUS THIS MUST NOT BE. The deployed client reads a 409 on
  // this route as "another device wrote first", pulls, merges and pushes the
  // same bytes again, which is the loop the refusal exists to stop.
  assert.notEqual(refused.status, 409);
  assert.equal(refused.status, 400);
  assert.equal(asString(asObject(refused.body)?.error), SHRINK_REFUSED_ERROR);
  assert.equal(asNumber(asObject(refused.body)?.currentSizeBytes), 5310);
  assert.equal(asNumber(asObject(refused.body)?.nextSizeBytes), 1588);
});

test('THE CONTROL over HTTP: the same body with shrinkAcknowledged: true is accepted', async () => {
  entitledUserId = 102;
  assert.equal((await push({ baseVersion: 0, envelopeVersion: 1, ciphertext: base64(5310) })).status, 200);

  const accepted = await push({
    baseVersion: 1,
    envelopeVersion: 1,
    ciphertext: base64(1588),
    shrinkAcknowledged: true,
  });
  assert.equal(accepted.status, 200);
  assert.equal(asNumber(asObject(accepted.body)?.newVersion), 2);
});

test('a present non-boolean shrinkAcknowledged is a 400 about the body, not a lenient false', async () => {
  entitledUserId = 103;
  const response = await push({
    baseVersion: 0,
    envelopeVersion: 1,
    ciphertext: base64(64),
    shrinkAcknowledged: 'true',
  });
  assert.equal(response.status, 400);
  assert.equal(asString(asObject(response.body)?.error), 'invalid request body');
});
