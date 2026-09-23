/**
 * The scan trial (M253), end to end: a real account, a real proxy, a real
 * upstream on an ephemeral port, and the real counters in Postgres.
 *
 * Every rule here has a control that goes red when the rule is removed:
 *
 *  - the ladder: two scans, then `403 trial-scans-spent`; a future date lifts
 *    the gate; a passed date is still `allowance-expired`;
 *  - one scan per intake id, a retry riding on it, a fourth request or one
 *    after thirty minutes costing a new one, and no id meaning its own scan;
 *  - the give-back: a 4xx, a 5xx, a connect error and a body cut mid-stream
 *    leave the count where it was, a 2xx moves it, and a 5xx still spends the
 *    daily unit;
 *  - concurrency: ten parallel requests on three scans claim three, and
 *    parallel requests on one new id claim one;
 *  - every refusal after the claim gives the scan back, and the trial
 *    accounts' sub-ceiling refuses them and nobody else;
 *  - redemption, the member door's switch, the admin fields, the lapsed day
 *    trials, the one mailbox, one trial rule across a deletion, and the
 *    headers a browser needs.
 */
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { eq, sql } from 'drizzle-orm';
import { setupTestDatabase, type TestDatabase } from './db-harness.js';
import {
  sampleAuthHash,
  sampleKdfDescriptor,
  sampleRecoveryCode,
  sampleWrappedDek,
  startService,
  type HttpResponse,
  type ServiceHarness,
  type StartServiceOptions,
} from './service-harness.js';
import {
  accounts,
  aiInstanceDays,
  aiTrialIntakes,
  aiUsageDays,
  signupInvites,
  trialAddressHashes,
} from '../../src/db/schema.js';
import { createDrizzleAiQuotaStore } from '../../src/ai/quota-store.js';
import { startAiUsageRetention } from '../../src/ai/usage-retention.js';
import { createDrizzleInviteStore } from '../../src/db/invite-store.js';
import { createTrialAddressHasher } from '../../src/accounts/trial-address.js';
import { createSilentLogger, type LogFields, type Logger } from '../../src/logger.js';

const UPSTREAM_KEY = 'sk-the-operators-own-provider-key';
const ADMIN_TOKEN = 'integration-admin-token-0123456789abcdef';
const PEPPER = 'a-trial-address-pepper-that-is-long-enough-0123';
const TRIAL = { scans: 10, dailyAiLimit: 50 };
const MS_PER_MINUTE = 60 * 1000;
const MS_PER_DAY = 24 * 60 * MS_PER_MINUTE;

/** What the fake upstream does with the next request. */
type UpstreamMode = 'ok' | 'cut' | 'slow-stream' | { status: number };

let database: TestDatabase;
let upstream: Server;
let upstreamBaseUrl: string;
let mode: UpstreamMode;
let upstreamCalls: number;
/** A delay before the fake upstream answers, so parallel requests overlap. */
let answerDelayMs: number;

before(async () => {
  database = await setupTestDatabase();
  upstream = createServer((request: IncomingMessage, response: ServerResponse) => {
    request.resume();
    request.on('end', () => {
      upstreamCalls += 1;
      setTimeout(() => answer(response), answerDelayMs);
    });
  });
  upstream.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => upstream.once('listening', resolve));
  // SAFETY: `listen(0, host)` binds a TCP port, so the address is never a string.
  upstreamBaseUrl = `http://127.0.0.1:${(upstream.address() as AddressInfo).port}`;
});

after(async () => {
  await new Promise<void>((resolve) => upstream.close(() => resolve()));
  await database.close();
});

beforeEach(async () => {
  await database.reset();
  mode = 'ok';
  upstreamCalls = 0;
  answerDelayMs = 0;
});

function answer(response: ServerResponse): void {
  if (mode === 'ok') {
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ choices: [{ message: { content: 'rice' } }] }));
    return;
  }
  if (mode === 'cut') {
    // Headers and half a body, then the socket dies: the provider stopped.
    response.writeHead(200, { 'content-type': 'application/json' });
    response.write('{"choices":[');
    setTimeout(() => response.socket?.destroy(), 20);
    return;
  }
  if (mode === 'slow-stream') {
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    let sent = 0;
    const timer = setInterval(() => {
      sent += 1;
      if (response.destroyed || sent > 20) {
        clearInterval(timer);
        response.end();
        return;
      }
      response.write(`data: ${sent}\n\n`);
    }, 50);
    return;
  }
  response.writeHead(mode.status, { 'content-type': 'application/json' });
  response.end(JSON.stringify({ error: { message: 'no' } }));
}

async function startWithTrial(options: Partial<StartServiceOptions> = {}): Promise<ServiceHarness> {
  return startService({
    db: database.db,
    adminToken: ADMIN_TOKEN,
    trial: TRIAL,
    trialAddressPepper: PEPPER,
    ai: { baseUrl: upstreamBaseUrl, apiKey: UPSTREAM_KEY, timeoutMs: 2_000 },
    ...options,
  });
}

async function withService(
  options: Partial<StartServiceOptions>,
  body: (service: ServiceHarness) => Promise<void>,
): Promise<void> {
  const service = await startWithTrial(options);
  try {
    await body(service);
  } finally {
    await service.close();
  }
}

/** A signed-in account with `granted` free scans and no date. */
async function trialAccount(service: ServiceHarness, input: { email: string; granted: number }): Promise<string> {
  const session = await service.signupThroughInvite({
    email: input.email,
    dailyAiLimit: TRIAL.dailyAiLimit,
    trialScans: input.granted,
  });
  return session.tokens.accessToken;
}

function scan(service: ServiceHarness, input: { token: string; intakeId?: string }): Promise<HttpResponse<unknown>> {
  const headers: Record<string, string> = {};
  if (input.intakeId !== undefined) headers['x-intake-id'] = input.intakeId;
  return service.request<unknown>({
    method: 'POST',
    path: '/v1/chat/completions',
    accessToken: input.token,
    headers,
    body: { model: 'm', messages: [{ role: 'user', content: 'a plate' }] },
  });
}

async function usedScans(email: string): Promise<number> {
  const [row] = await database.db
    .select({ used: accounts.trialScansUsed })
    .from(accounts)
    .where(eq(accounts.email, email));
  if (!row) throw new Error(`no account for ${email}`);
  return row.used;
}

async function usageToday(email: string): Promise<number> {
  const rows = await database.db
    .select({ count: aiUsageDays.count })
    .from(aiUsageDays)
    .innerJoin(accounts, eq(accounts.id, aiUsageDays.accountId))
    .where(eq(accounts.email, email));
  return rows.reduce((total, row) => total + row.count, 0);
}

/**
 * A new access token for an account, after the harness clock moved past the
 * old one's lifetime. The same credential every fixture account signs up with.
 */
async function signInAgain(service: ServiceHarness, email: string): Promise<string> {
  const response = await service.request<{ tokens: { accessToken: string } }>({
    method: 'POST',
    path: '/v1/auth/login',
    body: { email, authHash: sampleAuthHash() },
  });
  if (response.status !== 200) throw new Error(`could not sign ${email} in again: ${response.status}`);
  return response.body.tokens.accessToken;
}

/** A 16+ character intake id, as the app makes one per action. */
function intake(label: string): string {
  return `intake${label.padStart(12, '0')}`;
}

// ── the ladder ─────────────────────────────────────────────────────────────

test('two scans, then 403 trial-scans-spent before any upstream call or usage row', async () => {
  await withService({}, async (service) => {
    const token = await trialAccount(service, { email: 'two@example.org', granted: 2 });
    const first = await scan(service, { token, intakeId: intake('a') });
    const second = await scan(service, { token, intakeId: intake('b') });
    assert.equal(first.status, 200);
    assert.equal(first.headers.get('x-trial-scans-left'), '1');
    assert.equal(second.status, 200);
    assert.equal(second.headers.get('x-trial-scans-left'), '0');

    const third = await scan(service, { token, intakeId: intake('c') });
    assert.equal(third.status, 403);
    assert.deepEqual(third.body, { error: 'trial-scans-spent' });
    assert.equal(third.headers.get('x-trial-scans-left'), '0');
    assert.equal(upstreamCalls, 2, 'the refused scan never reached the provider');
    assert.equal(await usageToday('two@example.org'), 2, 'the refused scan spent no daily unit');
  });
});

test('a future date lifts the scan gate, and a passed date is still allowance-expired', async () => {
  // THE CONTROL for the refusal above: the same account with a paid window.
  await withService({}, async (service) => {
    const token = await trialAccount(service, { email: 'paid@example.org', granted: 2 });
    await database.db
      .update(accounts)
      .set({ allowanceExpiresAt: new Date(service.now() + 30 * MS_PER_DAY) })
      .where(eq(accounts.email, 'paid@example.org'));
    for (const label of ['a', 'b', 'c']) {
      assert.equal((await scan(service, { token, intakeId: intake(label) })).status, 200, label);
    }
    assert.equal(await usedScans('paid@example.org'), 0, 'a paid window counts no scans');

    await database.db
      .update(accounts)
      .set({ allowanceExpiresAt: new Date(service.now() - 1) })
      .where(eq(accounts.email, 'paid@example.org'));
    const expired = await scan(service, { token, intakeId: intake('d') });
    assert.equal(expired.status, 403);
    assert.deepEqual(expired.body, { error: 'allowance-expired' });
  });
});

test('an account with no scan trial is never counted and never sees the header', async () => {
  await withService({}, async (service) => {
    const session = await service.signupThroughInvite({ email: 'standing@example.org', dailyAiLimit: 50 });
    const response = await scan(service, { token: session.tokens.accessToken, intakeId: intake('a') });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('x-trial-scans-left'), null);
    assert.equal((await database.db.select().from(aiTrialIntakes)).length, 0);
  });
});

// ── the intake id ──────────────────────────────────────────────────────────

test('two requests with one intake id cost one scan; two ids cost two', async () => {
  await withService({}, async (service) => {
    const one = await trialAccount(service, { email: 'one-id@example.org', granted: 5 });
    await scan(service, { token: one, intakeId: intake('same') });
    await scan(service, { token: one, intakeId: intake('same') });
    assert.equal(await usedScans('one-id@example.org'), 1);

    // THE CONTROL: the same two requests under two ids.
    const two = await trialAccount(service, { email: 'two-ids@example.org', granted: 5 });
    await scan(service, { token: two, intakeId: intake('x') });
    await scan(service, { token: two, intakeId: intake('y') });
    assert.equal(await usedScans('two-ids@example.org'), 2);
  });
});

test('a fourth request on one id, or one after thirty minutes, costs a new scan', async () => {
  await withService({}, async (service) => {
    const token = await trialAccount(service, { email: 'fourth@example.org', granted: 5 });
    for (let request = 1; request <= 3; request += 1) await scan(service, { token, intakeId: intake('r') });
    assert.equal(await usedScans('fourth@example.org'), 1);
    await scan(service, { token, intakeId: intake('r') });
    assert.equal(await usedScans('fourth@example.org'), 2, 'the fourth request is a new action');

    const later = await trialAccount(service, { email: 'later@example.org', granted: 5 });
    await scan(service, { token: later, intakeId: intake('t') });
    service.advance(30 * MS_PER_MINUTE);
    const renewed = await signInAgain(service, 'later@example.org');
    await scan(service, { token: renewed, intakeId: intake('t') });
    assert.equal(await usedScans('later@example.org'), 2, 'thirty minutes later the id is a new action');
  });
});

test('a request with no intake id is its own scan', async () => {
  await withService({}, async (service) => {
    const token = await trialAccount(service, { email: 'no-id@example.org', granted: 5 });
    await scan(service, { token });
    await scan(service, { token });
    assert.equal(await usedScans('no-id@example.org'), 2);
  });
});

test('a malformed intake id is a 400 before any row is written', async () => {
  await withService({}, async (service) => {
    const token = await trialAccount(service, { email: 'bad-id@example.org', granted: 5 });
    const response = await scan(service, { token, intakeId: 'short' });
    assert.equal(response.status, 400);
    assert.deepEqual(response.body, { error: 'intake-id-invalid' });
    assert.equal(await usedScans('bad-id@example.org'), 0);
    assert.equal((await database.db.select().from(aiTrialIntakes)).length, 0);
    assert.equal(upstreamCalls, 0);
  });
});

// ── the give-back ──────────────────────────────────────────────────────────

test('an upstream 4xx and 5xx leave the scan count where it was; a 2xx moves it', async () => {
  await withService({}, async (service) => {
    const token = await trialAccount(service, { email: 'errors@example.org', granted: 5 });
    mode = { status: 400 };
    const refused = await scan(service, { token, intakeId: intake('four') });
    assert.equal(refused.status, 400);
    assert.equal(refused.headers.get('x-trial-scans-left'), '5', 'the answer says the attempt cost nothing');
    mode = { status: 502 };
    assert.equal((await scan(service, { token, intakeId: intake('five') })).status, 502);
    assert.equal(await usedScans('errors@example.org'), 0);
    // THE UNIT IS NOT THE SCAN: the 5xx still spent the daily unit, the 4xx did not.
    assert.equal(await usageToday('errors@example.org'), 1);

    // THE CONTROL: the same account, a 2xx.
    mode = 'ok';
    assert.equal((await scan(service, { token, intakeId: intake('ok') })).status, 200);
    assert.equal(await usedScans('errors@example.org'), 1);
  });
});

test('a connect error gives the scan back', async () => {
  await withService(
    // A port nothing listens on: the connection is refused.
    { ai: { baseUrl: 'http://127.0.0.1:9', apiKey: UPSTREAM_KEY, timeoutMs: 1_000 } },
    async (service) => {
      const token = await trialAccount(service, { email: 'refused@example.org', granted: 5 });
      assert.equal((await scan(service, { token, intakeId: intake('c') })).status, 502);
      assert.equal(await usedScans('refused@example.org'), 0);
    },
  );
});

test('an upstream body cut after its headers gives the scan back', async () => {
  await withService({}, async (service) => {
    const token = await trialAccount(service, { email: 'cut@example.org', granted: 5 });
    mode = 'cut';
    await assert.rejects(scan(service, { token, intakeId: intake('cut') }));
    // The give-back runs after the socket is destroyed; poll briefly.
    for (let attempt = 0; attempt < 50 && (await usedScans('cut@example.org')) !== 0; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    assert.equal(await usedScans('cut@example.org'), 0);
  });
});

test('a caller that hangs up after a 2xx keeps the scan spent', async () => {
  // THE CONTROL for the cut body: the provider answered, the caller left.
  await withService({}, async (service) => {
    const token = await trialAccount(service, { email: 'hangup@example.org', granted: 5 });
    mode = 'slow-stream';
    const abort = new AbortController();
    const response = await fetch(`${service.baseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', 'x-intake-id': intake('h') },
      body: JSON.stringify({ model: 'm', messages: [], stream: true }),
      signal: abort.signal,
    });
    assert.equal(response.status, 200);
    abort.abort();
    await new Promise((resolve) => setTimeout(resolve, 300));
    assert.equal(await usedScans('hangup@example.org'), 1);
  });
});

// ── concurrency ────────────────────────────────────────────────────────────

test('ten parallel requests with ten ids on three scans claim exactly three', async () => {
  await withService({}, async (service) => {
    answerDelayMs = 50;
    const token = await trialAccount(service, { email: 'parallel@example.org', granted: 3 });
    const responses = await Promise.all(
      Array.from({ length: 10 }, (_unused, index) => scan(service, { token, intakeId: intake(`p${index}`) })),
    );
    assert.equal(responses.filter((response) => response.status === 200).length, 3);
    assert.equal(responses.filter((response) => response.status === 403).length, 7);
    assert.equal(await usedScans('parallel@example.org'), 3);
  });
});

test('parallel requests with one new id claim exactly one scan', async () => {
  await withService({}, async (service) => {
    answerDelayMs = 50;
    const token = await trialAccount(service, { email: 'same-id@example.org', granted: 5 });
    // Three, the most one id may carry: a fourth would be a new action by the
    // rule the test above pins.
    const responses = await Promise.all([1, 2, 3].map(() => scan(service, { token, intakeId: intake('one') })));
    assert.deepEqual(
      responses.map((response) => response.status),
      [200, 200, 200],
    );
    assert.equal(await usedScans('same-id@example.org'), 1);
  });
});

// ── refusals after the claim ───────────────────────────────────────────────

test('the instance ceiling and the daily quota give the scan back', async () => {
  await withService(
    { ai: { baseUrl: upstreamBaseUrl, apiKey: UPSTREAM_KEY, timeoutMs: 2_000, instanceDailyLimit: 1 } },
    async (service) => {
      const standing = await service.signupThroughInvite({ email: 'first@example.org', dailyAiLimit: 50 });
      assert.equal((await scan(service, { token: standing.tokens.accessToken })).status, 200);

      const token = await trialAccount(service, { email: 'ceiling@example.org', granted: 5 });
      const refused = await scan(service, { token, intakeId: intake('c') });
      assert.equal(refused.status, 503);
      assert.deepEqual(refused.body, { error: 'ai-instance-ceiling' });
      assert.equal(await usedScans('ceiling@example.org'), 0);
    },
  );

  await withService({}, async (service) => {
    const session = await service.signupThroughInvite({
      email: 'quota@example.org',
      dailyAiLimit: 1,
      trialScans: 5,
    });
    const token = session.tokens.accessToken;
    assert.equal((await scan(service, { token, intakeId: intake('q1') })).status, 200);
    assert.equal((await scan(service, { token, intakeId: intake('q2') })).status, 429);
    assert.equal(await usedScans('quota@example.org'), 1, 'the refused request gave its scan back');
  });
});

test('the trial sub-ceiling refuses trial accounts and not a standing account on the same day', async () => {
  await withService(
    { ai: { baseUrl: upstreamBaseUrl, apiKey: UPSTREAM_KEY, timeoutMs: 2_000, trialInstanceDailyLimit: 1 } },
    async (service) => {
      const first = await trialAccount(service, { email: 'trial-a@example.org', granted: 5 });
      assert.equal((await scan(service, { token: first, intakeId: intake('a') })).status, 200);

      const second = await trialAccount(service, { email: 'trial-b@example.org', granted: 5 });
      const refused = await scan(service, { token: second, intakeId: intake('b') });
      assert.equal(refused.status, 503);
      assert.deepEqual(refused.body, { error: 'ai-instance-ceiling' });
      assert.equal(await usedScans('trial-b@example.org'), 0);

      // THE CONTROL: a paying or granted account is not the trials' budget.
      const standing = await service.signupThroughInvite({ email: 'standing@example.org', dailyAiLimit: 50 });
      assert.equal((await scan(service, { token: standing.tokens.accessToken })).status, 200);

      const [day] = await database.db.select().from(aiInstanceDays);
      assert.equal(day?.trialCount, 1);
    },
  );
});

// ── redemption, the member door and /health ────────────────────────────────

/** Redeems an invite token through the real signup route. */
async function redeem(service: ServiceHarness, inviteToken: string): Promise<HttpResponse<RedeemedBody>> {
  return service.request<RedeemedBody>({
    method: 'POST',
    path: '/v1/auth/signup',
    body: {
      inviteToken,
      authHash: sampleAuthHash(),
      kdfDescriptor: sampleKdfDescriptor(),
      recoveryAuthHash: sampleAuthHash(31),
      recoveryCode: sampleRecoveryCode(),
      keyRecords: [
        { kind: 'passphrase', kdfDescriptor: sampleKdfDescriptor(), wrappedDek: sampleWrappedDek() },
        { kind: 'recovery', kdfDescriptor: null, wrappedDek: sampleWrappedDek(41) },
      ],
    },
  });
}

interface RedeemedBody {
  account: {
    id: number;
    dailyAiLimit: number;
    allowanceExpiresAt: string | null;
    trialScans: { granted: number; left: number } | null;
  };
  tokens: { accessToken: string };
}

test('a trial invite redeems into ten scans and no date', async () => {
  await withService({ openSignup: {} }, async (service) => {
    await service.request({ method: 'POST', path: '/v1/auth/signup-request', body: { email: 'new@example.org' } });
    const letter = service.mailer.signupRequests[0];
    assert.ok(letter);
    const created = await redeem(service, letter.inviteToken);
    assert.equal(created.status, 201);
    assert.deepEqual(created.body.account.trialScans, { granted: 10, left: 10 });
    assert.equal(created.body.account.allowanceExpiresAt, null);
    assert.equal(created.body.account.dailyAiLimit, TRIAL.dailyAiLimit);
  });
});

/** Mints a member-caused invite with no scan trial on the row, as a letter from before the switch. */
async function mintMemberRow(service: ServiceHarness, input: { email: string; inviterId: number }): Promise<string> {
  const minted = await createDrizzleInviteStore(database.db).mint({
    email: input.email,
    displayName: null,
    role: 'member',
    dailyAiLimit: 50,
    trialScans: null,
    expiresAt: new Date(service.now() + 7 * MS_PER_DAY),
    now: new Date(service.now()),
    invitedByAccountId: input.inviterId,
    source: null,
  });
  if (!minted.ok) throw new Error('could not mint');
  return minted.minted.token;
}

test('an old member letter redeemed after the switch gets the scan trial, not a date', async () => {
  await withService({ memberInvites: { trial: true } }, async (service) => {
    const inviter = await service.signupThroughInvite({ email: 'inviter@example.org' });
    const token = await mintMemberRow(service, { email: 'invited@example.org', inviterId: inviter.account.id });
    const created = await redeem(service, token);
    assert.equal(created.status, 201);
    assert.deepEqual(created.body.account.trialScans, { granted: 10, left: 10 });
    assert.equal(created.body.account.allowanceExpiresAt, null);
  });

  // THE CONTROL: the same letter on an instance that still runs the day pair.
  await database.reset();
  await withService({ memberInvites: { allowanceDays: 3 } }, async (service) => {
    const inviter = await service.signupThroughInvite({ email: 'inviter@example.org' });
    const token = await mintMemberRow(service, { email: 'invited@example.org', inviterId: inviter.account.id });
    const created = await redeem(service, token);
    assert.equal(created.body.account.trialScans, null);
    assert.notEqual(created.body.account.allowanceExpiresAt, null);
  });
});

test('/health promises the trial only where there is one: the key is absent, not null, without it', async () => {
  await withService({}, async (service) => {
    const health = await service.request<{ instance: { trial?: { scans: number } } }>({
      method: 'GET',
      path: '/health',
    });
    assert.deepEqual(health.body.instance.trial, { scans: 10 });
  });
  const plain = await startService({ db: database.db });
  try {
    const health = await plain.request<{ instance: object }>({ method: 'GET', path: '/health' });
    assert.equal('trial' in health.body.instance, false);
  } finally {
    await plain.close();
  }
});

// ── one mailbox, one trial ─────────────────────────────────────────────────

/** Opens a trial account through the door and returns its session. */
async function openAccount(service: ServiceHarness, email: string): Promise<HttpResponse<RedeemedBody>> {
  const lettersBefore = service.mailer.signupRequests.length;
  await service.request({ method: 'POST', path: '/v1/auth/signup-request', body: { email } });
  const letter = service.mailer.signupRequests[lettersBefore];
  if (letter === undefined) throw new Error(`no letter for ${email}`);
  return redeem(service, letter.inviteToken);
}

test('a deleted trial mailbox keeps only a keyed hash, and asking again gets zero scans', async () => {
  await withService({ openSignup: {} }, async (service) => {
    const first = await openAccount(service, 'anna@gmail.com');
    assert.deepEqual(first.body.account.trialScans, { granted: 10, left: 10 });

    const deleted = await service.request({
      method: 'POST',
      path: '/v1/auth/delete',
      accessToken: first.body.tokens.accessToken,
      body: { authHash: sampleAuthHash() },
    });
    assert.equal(deleted.status, 204);

    // ONLY THE HASH. No invite row still names the mailbox, and the one kept
    // value is the keyed hash, not the address.
    const hashes = await database.db.select().from(trialAddressHashes);
    assert.equal(hashes.length, 1);
    assert.equal(hashes[0]?.hash, createTrialAddressHasher(PEPPER)('anna@gmail.com'));
    assert.match(hashes[0]?.hash ?? '', /^[0-9a-f]{64}$/);
    const rows = await database.db.select().from(signupInvites);
    assert.ok(rows.length > 0);
    for (const row of rows) {
      assert.equal(JSON.stringify(row).includes('anna'), false, 'an invite row still names the mailbox');
      assert.equal(row.trialKey, null);
    }

    // A dotted spelling after the next day's letter bound: the same mailbox.
    service.advance(MS_PER_DAY + MS_PER_MINUTE);
    const again = await openAccount(service, 'a.n.n.a+back@gmail.com');
    assert.equal(again.status, 201);
    assert.deepEqual(again.body.account.trialScans, { granted: 0, left: 0 });

    // THE CONTROL: another mailbox through the same door still gets ten.
    const other = await openAccount(service, 'bert@example.org');
    assert.deepEqual(other.body.account.trialScans, { granted: 10, left: 10 });
  });
});

test('a live trial account blocks a second spelling of its mailbox', async () => {
  await withService({ openSignup: {} }, async (service) => {
    await openAccount(service, 'carla@gmail.com');
    // Past the one letter per mailbox per day, which the two spellings share.
    service.advance(MS_PER_DAY + MS_PER_MINUTE);
    const second = await openAccount(service, 'c.arla@gmail.com');
    assert.deepEqual(second.body.account.trialScans, { granted: 0, left: 0 });
  });
});

test('without a pepper a deletion keeps the invite rows as before and writes no hash', async () => {
  // THE CONTROL for the scrub: the rule is the pepper's, not every deletion's.
  const service = await startService({ db: database.db });
  try {
    const session = await service.signupThroughInvite({ email: 'plain@example.org' });
    await service.request({
      method: 'POST',
      path: '/v1/auth/delete',
      accessToken: session.tokens.accessToken,
      body: { authHash: sampleAuthHash() },
    });
    assert.equal((await database.db.select().from(trialAddressHashes)).length, 0);
    const [row] = await database.db.select().from(signupInvites);
    assert.equal(row?.email, 'plain@example.org');
  } finally {
    await service.close();
  }
});

// ── the operator ───────────────────────────────────────────────────────────

test('an admin mint with "trial": true writes the instance pair, and is a 400 where there is none', async () => {
  await withService({}, async (service) => {
    const minted = await service.request<{ invite: { trialScans: number | null; dailyAiLimit: number } }>({
      method: 'POST',
      path: '/v1/admin/invites',
      adminToken: ADMIN_TOKEN,
      body: { email: 'op-trial@example.org', trial: true },
    });
    assert.equal(minted.status, 201);
    assert.equal(minted.body.invite.trialScans, 10);
    assert.equal(minted.body.invite.dailyAiLimit, TRIAL.dailyAiLimit);

    // THE CONTROL: without the field, the mint is the standing grant it always was.
    const standing = await service.request<{ invite: { trialScans: number | null } }>({
      method: 'POST',
      path: '/v1/admin/invites',
      adminToken: ADMIN_TOKEN,
      body: { email: 'op-standing@example.org', dailyAiLimit: 20 },
    });
    assert.equal(standing.body.invite.trialScans, null);
  });

  const plain = await startService({ db: database.db, adminToken: ADMIN_TOKEN });
  try {
    const refused = await plain.request({
      method: 'POST',
      path: '/v1/admin/invites',
      adminToken: ADMIN_TOKEN,
      body: { email: 'nothing@example.org', trial: true },
    });
    assert.equal(refused.status, 400);
  } finally {
    await plain.close();
  }
});

test('the operator PATCH sets the granted scans, and the account view shows them', async () => {
  await withService({}, async (service) => {
    const session = await service.signupThroughInvite({ email: 'patched@example.org', dailyAiLimit: 50 });
    const patched = await service.request<{ account: { trialScans: { granted: number; left: number } | null } }>({
      method: 'PATCH',
      path: `/v1/admin/accounts/${session.account.id}`,
      adminToken: ADMIN_TOKEN,
      body: { trialScans: 3 },
    });
    assert.equal(patched.status, 200);
    assert.deepEqual(patched.body.account.trialScans, { granted: 3, left: 3 });
    const outOfRange = await service.request({
      method: 'PATCH',
      path: `/v1/admin/accounts/${session.account.id}`,
      adminToken: ADMIN_TOKEN,
      body: { trialScans: 101 },
    });
    assert.equal(outOfRange.status, 400);
  });
});

test('lapsed day trials that nobody paid for get the scan trial once, and nobody else does', async () => {
  await withService({ memberInvites: { allowanceDays: 3, dailyAiLimit: 50 } }, async (service) => {
    const inviter = await service.signupThroughInvite({ email: 'inviter@example.org' });
    const lapsed = await service.signupThroughInvite({
      email: 'lapsed@example.org',
      invitedByAccountId: inviter.account.id,
      dailyAiLimit: 50,
    });
    const paid = await service.signupThroughInvite({
      email: 'paid-once@example.org',
      invitedByAccountId: inviter.account.id,
      dailyAiLimit: 50,
    });
    const running = await service.signupThroughInvite({
      email: 'running@example.org',
      invitedByAccountId: inviter.account.id,
      dailyAiLimit: 50,
    });
    // A payment moved this date, and it has run out since: it is not unpaid.
    await database.db
      .update(accounts)
      .set({ allowanceExpiresAt: sql`${accounts.allowanceExpiresAt} + interval '1 day'` })
      .where(eq(accounts.id, paid.account.id));

    service.advance(5 * MS_PER_DAY);
    // A trial that started later is still running and keeps its date.
    await database.db
      .update(accounts)
      .set({ allowanceExpiresAt: new Date(service.now() + MS_PER_DAY) })
      .where(eq(accounts.id, running.account.id));

    const dryRun = await service.request<{ accountIds: number[]; applied: boolean }>({
      method: 'POST',
      path: '/v1/admin/trials/grant-lapsed',
      adminToken: ADMIN_TOKEN,
      body: { trialDays: 3 },
    });
    assert.equal(dryRun.status, 200);
    assert.deepEqual(dryRun.body, { accountIds: [lapsed.account.id], applied: false });
    const [untouched] = await database.db.select().from(accounts).where(eq(accounts.id, lapsed.account.id));
    assert.equal(untouched?.trialScans, null, 'a dry run writes nothing');

    const applied = await service.request<{ accountIds: number[]; applied: boolean }>({
      method: 'POST',
      path: '/v1/admin/trials/grant-lapsed',
      adminToken: ADMIN_TOKEN,
      body: { trialDays: 3, apply: true },
    });
    assert.deepEqual(applied.body, { accountIds: [lapsed.account.id], applied: true });
    const [granted] = await database.db.select().from(accounts).where(eq(accounts.id, lapsed.account.id));
    assert.equal(granted?.trialScans, 10);
    assert.equal(granted?.allowanceExpiresAt, null);
    assert.equal(granted?.dailyAiLimit, TRIAL.dailyAiLimit);

    // IDEMPOTENT: the second run finds nobody.
    const rerun = await service.request<{ accountIds: number[] }>({
      method: 'POST',
      path: '/v1/admin/trials/grant-lapsed',
      adminToken: ADMIN_TOKEN,
      body: { trialDays: 3, apply: true },
    });
    assert.deepEqual(rerun.body.accountIds, []);
  });
});

test("the stats report the trials granted, today's trial requests and the sub-ceiling", async () => {
  await withService(
    {
      openSignup: {},
      ai: { baseUrl: upstreamBaseUrl, apiKey: UPSTREAM_KEY, timeoutMs: 2_000, trialInstanceDailyLimit: 40 },
    },
    async (service) => {
      const created = await openAccount(service, 'stats@example.org');
      await scan(service, { token: created.body.tokens.accessToken, intakeId: intake('s') });
      const stats = await service.request<{
        stats: {
          aiTrialInstanceDailyLimit: number | null;
          signup: { trialsGrantedLast7Days: number; trialRequestsToday: number };
        };
      }>({ method: 'GET', path: '/v1/admin/stats', adminToken: ADMIN_TOKEN });
      assert.equal(stats.body.stats.aiTrialInstanceDailyLimit, 40);
      assert.equal(stats.body.stats.signup.trialsGrantedLast7Days, 1);
      assert.equal(stats.body.stats.signup.trialRequestsToday, 1);
    },
  );
});

// ── the browser, the sweep and the logs ────────────────────────────────────

test('a browser may send X-Intake-Id to the proxy and read X-Trial-Scans-Left off the answer', async () => {
  await withService({}, async (service) => {
    const preflight = await service.request<undefined>({
      method: 'OPTIONS',
      path: '/v1/chat/completions',
      headers: {
        origin: 'https://app.openplate.de',
        'access-control-request-method': 'POST',
        'access-control-request-headers': 'authorization,content-type,x-intake-id',
      },
    });
    assert.equal(preflight.status, 204);
    const allowed = (preflight.headers.get('access-control-allow-headers') ?? '').toLowerCase();
    for (const name of ['authorization', 'content-type', 'x-intake-id']) {
      assert.ok(
        allowed
          .split(',')
          .map((part) => part.trim())
          .includes(name),
        `${name} is refused by the preflight`,
      );
    }

    const token = await trialAccount(service, { email: 'browser@example.org', granted: 5 });
    const response = await scan(service, { token, intakeId: intake('b') });
    const exposed = (response.headers.get('access-control-expose-headers') ?? '')
      .toLowerCase()
      .split(',')
      .map((part) => part.trim());
    assert.ok(exposed.includes('x-trial-scans-left'));
  });
});

test('the hourly sweep deletes intake rows older than a day and keeps younger ones', async () => {
  await withService({}, async (service) => {
    const token = await trialAccount(service, { email: 'sweep@example.org', granted: 5 });
    await scan(service, { token, intakeId: intake('old') });
    service.advance(25 * 60 * MS_PER_MINUTE);
    const renewed = await signInAgain(service, 'sweep@example.org');
    assert.equal((await scan(service, { token: renewed, intakeId: intake('new') })).status, 200);

    const sweep = startAiUsageRetention({
      quota: createDrizzleAiQuotaStore(database.db),
      logger: createSilentLogger(),
      now: () => new Date(service.now()),
      intervalMs: 60 * MS_PER_MINUTE,
    });
    try {
      await sweep.runOnce();
    } finally {
      sweep.stop();
    }
    const rows = await database.db.select({ intakeId: aiTrialIntakes.intakeId }).from(aiTrialIntakes);
    assert.deepEqual(
      rows.map((row) => row.intakeId),
      [intake('new')],
    );
  });
});

interface RecordedLine {
  message: string;
  fields: LogFields | undefined;
}

test('no intake id and no address reaches a log line', async () => {
  const lines: RecordedLine[] = [];
  const logger: Logger = {
    debug: (message, fields) => lines.push({ message, fields }),
    info: (message, fields) => lines.push({ message, fields }),
    warn: (message, fields) => lines.push({ message, fields }),
    error: (message, fields) => lines.push({ message, fields }),
  };
  await withService({ logger, authLogger: logger }, async (service) => {
    // Every branch that touches an intake: a claim, a give-back after a 5xx,
    // a reuse, and the refusal after the last scan.
    const token = await trialAccount(service, { email: 'quiet@example.org', granted: 2 });
    assert.equal((await scan(service, { token, intakeId: intake('quiet') })).status, 200);
    mode = { status: 500 };
    assert.equal((await scan(service, { token, intakeId: intake('loud') })).status, 500);
    mode = 'ok';
    assert.equal((await scan(service, { token, intakeId: intake('spent') })).status, 200);
    assert.equal((await scan(service, { token, intakeId: intake('spent') })).status, 200);
    assert.equal((await scan(service, { token, intakeId: intake('over') })).status, 403);
  });
  // THE CONTROL the sweep cannot pass by finding nothing.
  assert.ok(lines.some((line) => line.message === 'Proxied a completion'));
  for (const needle of [intake('quiet'), intake('loud'), intake('spent'), intake('over'), 'quiet@example.org']) {
    assert.equal(
      lines.some((line) => JSON.stringify(line).includes(needle)),
      false,
      `a log line carries ${needle}`,
    );
  }
});
