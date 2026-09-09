/**
 * The abuse controls, exercised through the real HTTP stack with the REAL
 * throttle configuration (the round-trip suite deliberately runs permissive —
 * see `PERMISSIVE_THROTTLE` — because every test request comes from
 * 127.0.0.1 and would otherwise lock itself out after five accounts).
 *
 * Five properties, each a way a public instance gets abused:
 *  - repeated signups from one IP lock out with a `429` and a `Retry-After`
 *  - repeated failed logins lock out, and a *different* IP-scoped bucket is
 *    unaffected, so a throttle cannot be turned into an account-lockout DoS
 *  - bulk KDF-descriptor probing locks out, and rotating the probed address
 *    does not buy a fresh allowance
 *  - the namespaces are independent, so one endpoint's abuse does not deny
 *    service on the others
 *  - repeated reset requests lock out and are NEVER cleared, because a person
 *    forgets their password once and a caller filling a mailbox does not
 *
 * AND ONE THAT IS NOT A THROTTLE: the instance-wide AI ceiling must not be
 * refundable by deleting an account. It is here rather than in
 * `ai-proxy.test.ts` because it is an abuse property: the cheapest attack on a
 * ceiling built the obvious way is to spend it and then erase yourself.
 */
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { eq, sql } from 'drizzle-orm';
import { DEFAULT_THROTTLE_CONFIG } from '../../src/lib/throttle.js';
import { createDrizzleInviteStore } from '../../src/db/invite-store.js';
import { aiInstanceDays, aiUsageDays } from '../../src/db/schema.js';
import { utcDayKey } from '../../src/lib/utc-day.js';
import { setupTestDatabase, type TestDatabase } from './db-harness.js';
import {
  sampleAuthHash,
  sampleKdfDescriptor,
  sampleRecoveryCode,
  sampleWrappedDek,
  startService,
} from './service-harness.js';

let database: TestDatabase;

/**
 * A provider that answers everything. The ceiling case below has to make real
 * proxied requests, because the counter it is about is written by the proxy.
 */
let upstream: Server;
let upstreamBaseUrl: string;

before(async () => {
  database = await setupTestDatabase();

  upstream = createServer((_request, response) => {
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ choices: [{ message: { content: 'a bowl of rice' } }] }));
  });
  upstream.listen(0);
  await new Promise<void>((resolve) => upstream.once('listening', resolve));
  const address = upstream.address();
  if (address === null) throw new Error('expected a listening upstream');
  // SAFETY: `listen(0)` binds a TCP port; Node returns the string form of an
  // address only for a Unix domain socket, which this never opens.
  upstreamBaseUrl = `http://127.0.0.1:${(address as AddressInfo).port}`;
});

after(async () => {
  await new Promise<void>((resolve, reject) => upstream.close((error) => (error ? reject(error) : resolve())));
  await database.close();
});

beforeEach(async () => {
  await database.reset();
});

/** Mints one live invite for an address, straight through the store. */
async function mintInvite(email: string): Promise<string> {
  const store = createDrizzleInviteStore(database.db);
  const minted = await store.mint({
    email,
    displayName: null,
    role: 'member',
    dailyAiLimit: 0,
    expiresAt: new Date(Date.now() + 60 * 60 * 1000),
    now: new Date(),
    // An operator mint, which is what every fixture outside the member-invite
    // suite wants.
    invitedByAccountId: null,
  });
  if (!minted.ok) throw new Error(`could not mint an invite for ${email}: ${minted.reason}`);
  return minted.minted.token;
}

function signupBody(inviteToken: string) {
  return {
    inviteToken,
    authHash: sampleAuthHash(11),
    kdfDescriptor: sampleKdfDescriptor(),
    recoveryAuthHash: sampleAuthHash(31),
    recoveryCode: sampleRecoveryCode(),
    keyRecords: [
      { kind: 'passphrase', kdfDescriptor: sampleKdfDescriptor(), wrappedDek: sampleWrappedDek() },
      { kind: 'recovery', kdfDescriptor: null, wrappedDek: sampleWrappedDek(41) },
    ],
  };
}

test('signup throttles by IP after the free allowance, with a Retry-After', async () => {
  const service = await startService({ db: database.db, throttleConfig: DEFAULT_THROTTLE_CONFIG });
  try {
    // `freeAttempts` failures leave the bucket unlocked; it is the NEXT one
    // that trips it. So the free allowance plus one all still succeed, and
    // only the request after that is refused.
    for (let attempt = 0; attempt <= DEFAULT_THROTTLE_CONFIG.freeAttempts; attempt += 1) {
      const token = await mintInvite(`flood-${attempt}@example.org`);
      const response = await service.request({
        method: 'POST',
        path: '/v1/auth/signup',
        body: signupBody(token),
      });
      assert.equal(response.status, 201);
    }

    const last = await mintInvite('flood-last@example.org');
    const blocked = await service.request<{ error: string }>({
      method: 'POST',
      path: '/v1/auth/signup',
      body: signupBody(last),
    });
    assert.equal(blocked.status, 429);
    // A client that cannot tell how long to wait retries immediately and
    // makes the problem worse.
    assert.ok(Number(blocked.headers.get('retry-after')) >= 1);
  } finally {
    await service.close();
  }
});

test('repeated failed logins lock the bucket, and a successful login clears it', async () => {
  const service = await startService({ db: database.db, throttleConfig: DEFAULT_THROTTLE_CONFIG });
  try {
    const token = await mintInvite('target@example.org');
    const created = await service.request({ method: 'POST', path: '/v1/auth/signup', body: signupBody(token) });
    assert.equal(created.status, 201);

    // One short of the lockout, then a correct login, which must reset the
    // counter — a user who fumbles their passphrase twice and then gets it
    // right must not be walking around one mistake from a lockout.
    for (let attempt = 0; attempt < DEFAULT_THROTTLE_CONFIG.freeAttempts - 1; attempt += 1) {
      const failed = await service.request({
        method: 'POST',
        path: '/v1/auth/login',
        body: { email: 'target@example.org', authHash: sampleAuthHash(99) },
      });
      assert.equal(failed.status, 401);
    }

    const success = await service.request({
      method: 'POST',
      path: '/v1/auth/login',
      body: { email: 'target@example.org', authHash: sampleAuthHash(11) },
    });
    assert.equal(success.status, 200);

    for (let attempt = 0; attempt <= DEFAULT_THROTTLE_CONFIG.freeAttempts; attempt += 1) {
      const failed = await service.request({
        method: 'POST',
        path: '/v1/auth/login',
        body: { email: 'target@example.org', authHash: sampleAuthHash(99) },
      });
      assert.equal(failed.status, 401);
    }

    const locked = await service.request({
      method: 'POST',
      path: '/v1/auth/login',
      body: { email: 'target@example.org', authHash: sampleAuthHash(99) },
    });
    assert.equal(locked.status, 429);

    // A DIFFERENT account from the same IP is a different bucket, so hammering
    // one address cannot lock the whole instance.
    const otherAccount = await service.request({
      method: 'POST',
      path: '/v1/auth/login',
      body: { email: 'someone-else@example.org', authHash: sampleAuthHash(11) },
    });
    assert.equal(otherAccount.status, 401);
  } finally {
    await service.close();
  }
});

test('bulk KDF probing locks out, and rotating the probed address does not evade it', async () => {
  const service = await startService({ db: database.db, throttleConfig: DEFAULT_THROTTLE_CONFIG });
  try {
    // A DIFFERENT address every time — this is exactly the enumeration attack,
    // so the bucket must be keyed by source alone. A per-address bucket would
    // hand out a fresh allowance for every address probed and never fire.
    for (let attempt = 0; attempt <= DEFAULT_THROTTLE_CONFIG.freeAttempts; attempt += 1) {
      const response = await service.request<{ kdfDescriptor: unknown }>({
        method: 'POST',
        path: '/v1/auth/kdf',
        body: { email: `probe-${attempt}@example.org` },
      });
      assert.equal(response.status, 200);
    }

    const blocked = await service.request<{ error: string }>({
      method: 'POST',
      path: '/v1/auth/kdf',
      body: { email: 'probe-last@example.org' },
    });
    assert.equal(blocked.status, 429);
    assert.ok(Number(blocked.headers.get('retry-after')) >= 1);
  } finally {
    await service.close();
  }
});

test('the KDF throttle is independent of the login and signup buckets', async () => {
  const service = await startService({ db: database.db, throttleConfig: DEFAULT_THROTTLE_CONFIG });
  try {
    // Exhaust kdf...
    for (let attempt = 0; attempt <= DEFAULT_THROTTLE_CONFIG.freeAttempts; attempt += 1) {
      await service.request({ method: 'POST', path: '/v1/auth/kdf', body: { email: `probe-${attempt}@example.org` } });
    }
    assert.equal(
      (await service.request({ method: 'POST', path: '/v1/auth/kdf', body: { email: 'probe-x@example.org' } })).status,
      429,
    );

    // ...and a legitimate signup from the same IP still works. Namespaces keep
    // one endpoint's abuse from denying service on the others.
    const token = await mintInvite('unaffected@example.org');
    const created = await service.request({ method: 'POST', path: '/v1/auth/signup', body: signupBody(token) });
    assert.equal(created.status, 201);
  } finally {
    await service.close();
  }
});

test('reset requests throttle per address and are never cleared by a success', async () => {
  const service = await startService({ db: database.db, throttleConfig: DEFAULT_THROTTLE_CONFIG });
  try {
    const token = await mintInvite('forgetful@example.org');
    assert.equal(
      (await service.request({ method: 'POST', path: '/v1/auth/signup', body: signupBody(token) })).status,
      201,
    );

    // Every request counts, including the ones that found an account and sent a
    // letter. A person forgets their password once; a caller filling somebody's
    // mailbox, or measuring the difference between a known and an unknown
    // address, does it thousands of times.
    for (let attempt = 0; attempt <= DEFAULT_THROTTLE_CONFIG.freeAttempts; attempt += 1) {
      const response = await service.request({
        method: 'POST',
        path: '/v1/auth/reset/request',
        body: { email: 'forgetful@example.org' },
      });
      assert.equal(response.status, 202);
    }

    const blocked = await service.request<{ error: string }>({
      method: 'POST',
      path: '/v1/auth/reset/request',
      body: { email: 'forgetful@example.org' },
    });
    assert.equal(blocked.status, 429);
    assert.ok(Number(blocked.headers.get('retry-after')) >= 1);

    // A DIFFERENT address from the same IP is a different bucket, so one
    // person's flood cannot lock everybody else out of their own reset.
    const other = await service.request({
      method: 'POST',
      path: '/v1/auth/reset/request',
      body: { email: 'somebody-else@example.org' },
    });
    assert.equal(other.status, 202);
  } finally {
    await service.close();
  }
});

test('deleting an account does not refund the instance ceiling it spent', async () => {
  // THE ATTACK THIS SHAPE OF COUNTER EXISTS TO STOP. A ceiling read as a `SUM`
  // over `ai_usage_days` would be refundable: `account_id` cascades on delete
  // (`db/schema.ts`), so erasing an account removes the days it spent and
  // today's total falls. Spend the instance's capacity, delete yourself,
  // redeem another invitation, spend it again.
  const service = await startService({
    db: database.db,
    ai: { baseUrl: upstreamBaseUrl, apiKey: 'sk-the-operators-key', instanceDailyLimit: 10 },
  });
  try {
    const leaver = await service.signupThroughInvite({ email: 'leaver@example.org', dailyAiLimit: 5 });
    const stayer = await service.signupThroughInvite({ email: 'stayer@example.org', dailyAiLimit: 5 });
    const send = (accessToken: string) =>
      service.request<unknown>({
        method: 'POST',
        path: '/v1/chat/completions',
        accessToken,
        body: { model: 'a-vision-model', messages: [{ role: 'user', content: 'what is on this plate?' }] },
      });

    assert.equal((await send(leaver.tokens.accessToken)).status, 200);
    assert.equal((await send(leaver.tokens.accessToken)).status, 200);
    assert.equal((await send(stayer.tokens.accessToken)).status, 200);

    const day = utcDayKey(new Date());
    const instanceBefore = await database.db.select().from(aiInstanceDays).where(eq(aiInstanceDays.day, day));
    assert.equal(instanceBefore[0]?.count, 3);
    // The number the rejected design would have used, measured before the
    // delete so the comparison after it is against something real.
    const sumBefore = await usageSumOn(day);
    assert.equal(sumBefore, 3);

    // The real erasure path, the same method the self-service delete calls.
    await service.authContext.store.deleteAccount(leaver.account.id);

    // ── THE CONTROL, and it must hold or the test below proves nothing ──────
    // The cascade IS real: the leaver's per-account rows are gone, and the sum
    // a `SUM`-based ceiling would have read has FALLEN by two. Without this
    // half, a ceiling that happened to be immune for some other reason would
    // look like a design that worked.
    const leftovers = await database.db.select().from(aiUsageDays).where(eq(aiUsageDays.accountId, leaver.account.id));
    assert.deepEqual(leftovers, [], 'deleting an account must still erase its own usage rows');
    assert.equal(await usageSumOn(day), 1, 'the sum a SUM-based ceiling would read fell from 3 to 1');

    // ── THE PROPERTY ───────────────────────────────────────────────────────
    // The instance's own counter did not move. It references nothing, so no
    // cascade can reach it, and a day's spend only ever goes up.
    const instanceAfter = await database.db.select().from(aiInstanceDays).where(eq(aiInstanceDays.day, day));
    assert.equal(instanceAfter[0]?.count, 3, 'an erasure must not hand the instance its spend back');
  } finally {
    await service.close();
  }
});

/** What a ceiling built as a `SUM` over `ai_usage_days` would have read for one UTC day. */
async function usageSumOn(day: string): Promise<number> {
  const rows = await database.db
    .select({ total: sql<number>`coalesce(sum(${aiUsageDays.count}), 0)::int` })
    .from(aiUsageDays)
    .where(eq(aiUsageDays.day, day));
  return rows[0]?.total ?? 0;
}
