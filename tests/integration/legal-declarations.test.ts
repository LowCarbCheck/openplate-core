/**
 * `POST /v1/legal/declarations` (M214/09), end to end against a real Postgres
 * and a real listening fake biller.
 *
 * WHY A REAL BILLER AND NOT AN INJECTED `fetch`. `legal/forward-declaration.ts`
 * builds headers off the wire, and a fake function records what the handler
 * MEANT to send. A socket records what it sent — the same argument
 * `plans-harness.ts` makes for the authenticated proxy this route forwards
 * through the same internal door as.
 *
 * FIVE CLAIMS, EACH WITH ITS OWN TEST:
 *  - the row is written before the biller is ever called (a hanging biller
 *    proves this by concurrency, not by reading the handler's own comments);
 *  - a forward failure still answers `202`, and the row remembers why;
 *  - a matched declaration whose typed address differs from the account's own
 *    (case alone, here) sends the receipt TWICE and the operator alert once —
 *    three letters;
 *  - the `202` body is the same shape whether the email matched an account or
 *    not;
 *  - a malformed field is a `400` that names it.
 */
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo, Socket } from 'node:net';
import { legalDeclarations } from '../../src/db/schema.js';
import { setupTestDatabase, type TestDatabase } from './db-harness.js';
import { startService, type ServiceHarness } from './service-harness.js';

interface DeclarationRequestBody {
  kind?: string | null;
  name?: string | null;
  email?: string | null;
  contractReference?: string | null;
  terminationType?: string | null;
  reason?: string | null;
  requestedDate?: string | null;
  timing?: string | null;
  language?: string | null;
}

interface DeclarationResponse {
  receiptId: string;
  receivedAt: string;
  kind: string;
}

function sampleDeclaration(overrides: Partial<DeclarationRequestBody> = {}): DeclarationRequestBody {
  return {
    kind: 'kuendigung',
    name: 'Anna Beispiel',
    email: 'anna@example.org',
    contractReference: 'K-1234',
    terminationType: 'ordentlich',
    reason: null,
    requestedDate: null,
    timing: 'earliest',
    language: 'de',
    ...overrides,
  };
}

interface RecordedBillerRequest {
  method: string;
  url: string;
  headers: Record<string, string | undefined>;
  body: string;
}

interface FakeBiller {
  baseUrl: string;
  received: RecordedBillerRequest[];
  reply: { status: number; body: string; hang: boolean };
  close(): Promise<void>;
}

/** A port nothing listens on, reserved by IANA for documentation. Used to make an unreachable upstream without waiting on a real timeout. */
const UNREACHABLE_UPSTREAM_URL = 'http://127.0.0.1:1/plans';

async function startFakeBiller(): Promise<FakeBiller> {
  const received: RecordedBillerRequest[] = [];
  const reply = { status: 202, body: JSON.stringify({ id: 'd_1', receivedAt: new Date().toISOString() }), hang: false };
  const sockets = new Set<Socket>();

  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      const headers: Record<string, string | undefined> = {};
      for (const [name, value] of Object.entries(req.headers)) {
        headers[name] = Array.isArray(value) ? value.join(', ') : value;
      }
      received.push({ method: req.method ?? '', url: req.url ?? '', headers, body: Buffer.concat(chunks).toString('utf8') });
      // A hang is an accepted request that is never answered, exactly what a
      // biller stuck on its own database looks like from here.
      if (reply.hang) return;
      res.writeHead(reply.status, { 'content-type': 'application/json' });
      res.end(reply.body);
    });
  });
  server.on('connection', (socket: Socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });
  server.listen(0);
  await new Promise<void>((resolve) => server.once('listening', resolve));
  // SAFETY: `listen(0)` binds a TCP port; Node returns the string form of an
  // address only for a Unix domain socket, which this never opens.
  const { port } = server.address() as AddressInfo;

  return {
    baseUrl: `http://127.0.0.1:${port}/plans`,
    received,
    reply,
    async close(): Promise<void> {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    },
  };
}

let database: TestDatabase;
let biller: FakeBiller;
let harness: ServiceHarness;
const servers: { close(): Promise<void> }[] = [];

before(async () => {
  database = await setupTestDatabase();
  biller = await startFakeBiller();
  servers.push(biller);
});

after(async () => {
  await harness?.close();
  await Promise.all(servers.map((server) => server.close()));
  await database.close();
});

beforeEach(async () => {
  await database.reset();
  biller.received.length = 0;
  biller.reply.status = 202;
  biller.reply.body = JSON.stringify({ id: 'd_1', receivedAt: new Date().toISOString() });
  biller.reply.hang = false;
  await harness?.close();
  harness = await startService({
    db: database.db,
    plans: { baseUrl: biller.baseUrl, secret: 'a-shared-secret', timeoutMs: 300 },
  });
});

test('an unmatched declaration is persisted, forwarded, and answers 202', async () => {
  const response = await harness.request<DeclarationResponse>({
    method: 'POST',
    path: '/v1/legal/declarations',
    body: sampleDeclaration(),
  });

  assert.equal(response.status, 202);
  assert.equal(response.body.kind, 'kuendigung');
  assert.match(response.body.receiptId, /^[0-9a-f-]{36}$/);
  assert.equal(Number.isNaN(Date.parse(response.body.receivedAt)), false, 'receivedAt must be a parseable instant');

  const rows = await database.db.select().from(legalDeclarations);
  assert.equal(rows.length, 1);
  assert.equal(rows[0]?.id, response.body.receiptId);
  assert.equal(rows[0]?.accountId, null);
  assert.equal(rows[0]?.forwardedAt !== null, true, 'a configured biller that answers 202 must be recorded as forwarded');
  assert.equal(rows[0]?.forwardError, null);

  assert.equal(biller.received.length, 1);
  // The biller's own base already ends in `/plans` (`upstreamBaseUrl`), so the
  // suffix this forwarder appends lands here.
  assert.equal(biller.received[0]?.url, '/plans/declarations');
  assert.equal(biller.received[0]?.headers['x-plans-secret'], 'a-shared-secret');
  assert.equal(biller.received[0]?.headers['x-account-id'], undefined, 'no account matched, so no account headers');
  assert.equal(biller.received[0]?.headers['x-account-email'], undefined);
});

test('persisted BEFORE the forward: the row exists while the biller is still hanging', async () => {
  biller.reply.hang = true;

  const requestPromise = harness.request<DeclarationResponse>({
    method: 'POST',
    path: '/v1/legal/declarations',
    body: sampleDeclaration(),
  });

  // Well under the 300ms forward timeout configured above, and well over the
  // time a local INSERT takes.
  await new Promise((resolve) => setTimeout(resolve, 60));
  const midFlightRows = await database.db.select().from(legalDeclarations);
  assert.equal(midFlightRows.length, 1, 'the row must exist while the forward is still in flight');
  assert.equal(midFlightRows[0]?.forwardedAt, null, 'the forward has not resolved yet');

  const response = await requestPromise;
  assert.equal(response.status, 202, 'a forward that never answers must still be a 202');

  const finalRows = await database.db.select().from(legalDeclarations);
  assert.equal(finalRows.length, 1, 'no second row from the timeout path');
  assert.equal(finalRows[0]?.forwardError, 'timeout');
});

test('a forward failure still answers 202, and the row remembers why', async () => {
  await harness.close();
  harness = await startService({
    db: database.db,
    plans: { baseUrl: UNREACHABLE_UPSTREAM_URL, secret: 'a-shared-secret', timeoutMs: 300 },
  });

  const response = await harness.request<DeclarationResponse>({
    method: 'POST',
    path: '/v1/legal/declarations',
    body: sampleDeclaration(),
  });

  assert.equal(response.status, 202);
  const rows = await database.db.select().from(legalDeclarations);
  assert.equal(rows.length, 1);
  assert.equal(rows[0]?.forwardedAt, null);
  assert.equal(rows[0]?.forwardError, 'unreachable');
});

test('no biller configured: still persisted, still 202, forward_error names it', async () => {
  await harness.close();
  harness = await startService({ db: database.db });

  const response = await harness.request<DeclarationResponse>({
    method: 'POST',
    path: '/v1/legal/declarations',
    body: sampleDeclaration(),
  });

  assert.equal(response.status, 202);
  const rows = await database.db.select().from(legalDeclarations);
  assert.equal(rows.length, 1);
  assert.equal(rows[0]?.forwardError, 'plans-not-configured');
  assert.equal(biller.received.length, 0);
});

test('a matched declaration whose typed address differs from the account sends the receipt twice, plus one operator alert', async () => {
  // Signed up already normalized, the way `accounts.email` is in production
  // (`accounts/auth-input.ts`'s `parseEmail`): this harness helper mints the
  // invite directly and does not re-run that normalization itself.
  await harness.signupThroughInvite({ email: 'anna.mueller@example.org' });

  const response = await harness.request<DeclarationResponse>({
    method: 'POST',
    path: '/v1/legal/declarations',
    body: sampleDeclaration({ name: 'Anna Müller', email: 'Anna.Mueller@Example.ORG' }),
  });

  assert.equal(response.status, 202);
  const [row] = await database.db.select().from(legalDeclarations);
  assert.notEqual(row?.accountId, null, 'the normalized email must match the account');

  // THREE LETTERS: the typed address, the account's own (differently cased)
  // address, and one operator alert.
  assert.equal(harness.mailer.declarationReceipts.length, 2);
  const recipients = harness.mailer.declarationReceipts.map((receipt) => receipt.to).toSorted();
  assert.deepEqual(recipients, ['Anna.Mueller@Example.ORG', 'anna.mueller@example.org']);
  assert.equal(harness.mailer.declarationOperatorAlerts.length, 1);
  assert.equal(harness.mailer.declarationOperatorAlerts[0]?.matched, true);
  assert.equal(harness.mailer.declarationOperatorAlerts[0]?.receiptId, response.body.receiptId);

  // The forward carried the matched account's own headers, built from the row.
  assert.equal(biller.received.length, 1);
  assert.equal(biller.received[0]?.headers['x-account-id'], String(row?.accountId));
  assert.equal(biller.received[0]?.headers['x-account-email'], 'anna.mueller@example.org');
});

test('an unmatched declaration sends exactly one receipt and one operator alert, not matched', async () => {
  const response = await harness.request<DeclarationResponse>({
    method: 'POST',
    path: '/v1/legal/declarations',
    body: sampleDeclaration(),
  });

  assert.equal(response.status, 202);
  assert.equal(harness.mailer.declarationReceipts.length, 1);
  assert.equal(harness.mailer.declarationOperatorAlerts.length, 1);
  assert.equal(harness.mailer.declarationOperatorAlerts[0]?.matched, false);
});

test('the 202 body is the same shape whether the email matched an account or not', async () => {
  await harness.signupThroughInvite({ email: 'matched@example.org' });

  const matched = await harness.request<DeclarationResponse>({
    method: 'POST',
    path: '/v1/legal/declarations',
    body: sampleDeclaration({ email: 'matched@example.org' }),
  });
  const unmatched = await harness.request<DeclarationResponse>({
    method: 'POST',
    path: '/v1/legal/declarations',
    body: sampleDeclaration({ email: 'nobody-here@example.org' }),
  });

  assert.equal(matched.status, 202);
  assert.equal(unmatched.status, 202);
  assert.deepEqual(Object.keys(matched.body).toSorted(), ['kind', 'receiptId', 'receivedAt']);
  assert.deepEqual(Object.keys(matched.body).toSorted(), Object.keys(unmatched.body).toSorted());
  // Neither answer names whether the account matched, an account id, or a
  // forward outcome: none of that is the caller's to learn from the response.
  assert.equal(JSON.stringify(matched.body).includes('account'), false);
  assert.equal(JSON.stringify(unmatched.body).includes('account'), false);
});

test('a malformed field is a 400 that names it', async () => {
  const cases: { overrides: Partial<DeclarationRequestBody>; field: string }[] = [
    { overrides: { kind: 'not-a-kind' }, field: 'kind' },
    { overrides: { name: '' }, field: 'name' },
    { overrides: { email: 'not-an-address' }, field: 'email' },
    { overrides: { terminationType: 'immediately' }, field: 'terminationType' },
    { overrides: { requestedDate: '2026-02-30' }, field: 'requestedDate' },
    { overrides: { requestedDate: 'not-a-date' }, field: 'requestedDate' },
    { overrides: { timing: 'yesterday' }, field: 'timing' },
    { overrides: { language: 'fr' }, field: 'language' },
  ];

  for (const testCase of cases) {
    const response = await harness.request<{ error: string; field: string }>({
      method: 'POST',
      path: '/v1/legal/declarations',
      body: sampleDeclaration(testCase.overrides),
    });
    assert.equal(response.status, 400, `${testCase.field} must be a 400`);
    assert.equal(response.body.error, 'declaration-invalid');
    assert.equal(response.body.field, testCase.field);
  }

  assert.equal(biller.received.length, 0, 'no request that failed validation ever reached the biller');
  const rows = await database.db.select().from(legalDeclarations);
  assert.equal(rows.length, 0, 'no request that failed validation ever wrote a row');
});

test('a sixth request from the same IP inside a minute is refused, and the fifth was not', async () => {
  await harness.close();
  harness = await startService({
    db: database.db,
    plans: { baseUrl: biller.baseUrl, secret: 'a-shared-secret', timeoutMs: 300 },
    legal: { rateLimitPerMinute: 5 },
  });

  for (let attempt = 1; attempt <= 5; attempt += 1) {
    const response = await harness.request<DeclarationResponse>({
      method: 'POST',
      path: '/v1/legal/declarations',
      body: sampleDeclaration({ email: `person-${attempt}@example.org` }),
    });
    assert.equal(response.status, 202, `attempt ${attempt} must be accepted`);
  }

  const sixth = await harness.request<{ error: string }>({
    method: 'POST',
    path: '/v1/legal/declarations',
    body: sampleDeclaration({ email: 'person-6@example.org' }),
  });
  assert.equal(sixth.status, 429);
  assert.equal(sixth.body.error, 'declaration-rate-limited');
  assert.equal(sixth.headers.get('retry-after') !== null, true);
});
