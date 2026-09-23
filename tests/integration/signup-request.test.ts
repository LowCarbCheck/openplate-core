/**
 * The open sign-up door (M253), against REAL Postgres through the real app.
 *
 * What this file proves, each with a control that goes red when the rule is
 * removed:
 *
 *  - the door exists only where `OPEN_SIGNUP` is set, and `/health` says so;
 *  - a new address, an address with a pending letter from another door and an
 *    address that holds an account get the SAME answer, and only the letters
 *    differ;
 *  - five requests per source per hour, and a second source is not touched;
 *  - one letter per mailbox per day, dots and tags included;
 *  - a throwaway domain and a failed captcha are refused before anything is
 *    minted;
 *  - the mailed token redeems into an ordinary account;
 *  - the operator's farming count moves, and no address reaches a log line.
 */
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { eq } from 'drizzle-orm';
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
import { createDrizzleInviteStore } from '../../src/db/invite-store.js';
import { signupInvites } from '../../src/db/schema.js';
import { SIGNUP_REQUEST_IP_THROTTLE } from '../../src/accounts/open-signup.js';
import type { CaptchaVerdict, CaptchaVerifier } from '../../src/accounts/captcha.js';
import type { LogFields, Logger } from '../../src/logger.js';

const ADMIN_TOKEN = 'integration-admin-token-0123456789abcdef';

let database: TestDatabase;

before(async () => {
  database = await setupTestDatabase();
});

after(async () => {
  await database.close();
});

beforeEach(async () => {
  await database.reset();
});

/** Boots a service with the door open, and closes it after the body ran. */
async function withOpenDoor(
  options: Partial<StartServiceOptions>,
  body: (service: ServiceHarness) => Promise<void>,
): Promise<void> {
  const service = await startService({ db: database.db, adminToken: ADMIN_TOKEN, openSignup: {}, ...options });
  try {
    await body(service);
  } finally {
    await service.close();
  }
}

/** What a caller may post. `dailyAiLimit` and `role` are here to prove the door never reads them. */
interface SignupRequestBody {
  email: string;
  captchaToken?: string;
  dailyAiLimit?: number;
  role?: string;
}

/** The part of `/health` this suite reads. */
interface HealthBody {
  instance: { openSignup: boolean; signupCaptcha?: { provider: string; siteKey: string } };
}

function requestSignup(
  service: ServiceHarness,
  body: SignupRequestBody,
  headers?: Record<string, string>,
): Promise<HttpResponse<unknown>> {
  return service.request<unknown>({ method: 'POST', path: '/v1/auth/signup-request', body, headers });
}

/** Every response header but `date`, which names the second the answer left and nothing about the address. */
function comparableHeaders(headers: Headers): [string, string][] {
  return [...headers.entries()].filter(([name]) => name !== 'date').toSorted(([a], [b]) => a.localeCompare(b));
}

/** A captcha stub that answers what the test names, and remembers every token it was asked about. */
function stubCaptcha(verdict: CaptchaVerdict): CaptchaVerifier & { tokens: (string | null)[] } {
  const tokens: (string | null)[] = [];
  return {
    tokens,
    async verify(input: { token: string | null }): Promise<CaptchaVerdict> {
      tokens.push(input.token);
      return verdict;
    },
  };
}

interface RecordedLine {
  message: string;
  fields: LogFields | undefined;
}

function recordingLogger(lines: RecordedLine[]): Logger {
  return {
    debug: (message, fields) => lines.push({ message, fields }),
    info: (message, fields) => lines.push({ message, fields }),
    warn: (message, fields) => lines.push({ message, fields }),
    error: (message, fields) => lines.push({ message, fields }),
  };
}

/** Every log line that carries `needle` anywhere, message or field. */
function linesCarrying(lines: RecordedLine[], needle: string): RecordedLine[] {
  return lines.filter((line) => JSON.stringify(line).includes(needle));
}

test('with OPEN_SIGNUP unset the route is the ordinary 404 and /health says openSignup: false', async () => {
  const service = await startService({ db: database.db });
  try {
    const response = await requestSignup(service, { email: 'anna@example.org' });
    assert.equal(response.status, 404);
    const health = await service.request<HealthBody>({ method: 'GET', path: '/health' });
    assert.equal(health.body.instance.openSignup, false);
    assert.equal(service.mailer.invites.length, 0);
  } finally {
    await service.close();
  }
});

test('with OPEN_SIGNUP set the route answers 202 and /health says openSignup: true', async () => {
  // THE CONTROL for the test above.
  await withOpenDoor({}, async (service) => {
    const response = await requestSignup(service, { email: 'anna@example.org' });
    assert.equal(response.status, 202);
    assert.deepEqual(response.body, {});
    const health = await service.request<HealthBody>({ method: 'GET', path: '/health' });
    assert.equal(health.body.instance.openSignup, true);
    // No captcha configured, so no captcha is advertised: absent, not null.
    assert.equal('signupCaptcha' in health.body.instance, false);
  });
});

test('the mailed invitation is an ordinary one: member, no AI, no inviter, and it redeems', async () => {
  await withOpenDoor({}, async (service) => {
    await requestSignup(service, { email: 'Anna@Example.org ', dailyAiLimit: 500, role: 'admin' });
    assert.equal(service.mailer.invites.length, 1);
    const letter = service.mailer.invites[0];
    // Canonicalised by the one `parseEmail`, and nothing else from the body was read.
    assert.equal(letter?.email, 'anna@example.org');

    const [row] = await database.db.select().from(signupInvites).where(eq(signupInvites.email, 'anna@example.org'));
    assert.equal(row?.source, 'open-signup');
    assert.equal(row?.role, 'member');
    assert.equal(row?.dailyAiLimit, 0);
    assert.equal(row?.invitedByAccountId, null);
    // No pepper on this instance, so no mailbox hash, and never the address.
    assert.equal(row?.trialKey, null);

    const signup = await service.request<{ account: { email: string; role: string } }>({
      method: 'POST',
      path: '/v1/auth/signup',
      body: {
        inviteToken: letter?.inviteToken,
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
    assert.equal(signup.status, 201);
    assert.equal(signup.body.account.email, 'anna@example.org');
    assert.equal(signup.body.account.role, 'member');
  });
});

test('a new address, a pending letter from another door and an existing account get the same answer', async () => {
  await withOpenDoor({}, async (service) => {
    await service.signupThroughInvite({ email: 'existing@example.org' });
    const operatorMint = await createDrizzleInviteStore(database.db).mint({
      email: 'pending@example.org',
      displayName: null,
      role: 'member',
      dailyAiLimit: 200,
      expiresAt: new Date(service.now() + 24 * 60 * 60 * 1000),
      now: new Date(service.now()),
      invitedByAccountId: null,
      source: null,
      trialScans: null,
    });
    assert.ok(operatorMint.ok);

    const fresh = await requestSignup(service, { email: 'new@example.org' });
    const pending = await requestSignup(service, { email: 'pending@example.org' });
    const existing = await requestSignup(service, { email: 'existing@example.org' });

    for (const response of [pending, existing]) {
      assert.equal(response.status, fresh.status);
      assert.deepEqual(response.body, fresh.body);
      assert.deepEqual(comparableHeaders(response.headers), comparableHeaders(fresh.headers));
    }

    // ONLY THE LETTERS DIFFER: one invitation for the new address, one note
    // for the account, and nothing for the address that already holds one.
    assert.deepEqual(
      service.mailer.invites.map((letter) => letter.email),
      ['new@example.org'],
    );
    assert.deepEqual(
      service.mailer.accountNotices.map((letter) => letter.email),
      ['existing@example.org'],
    );

    // THE OPERATOR'S LETTER STILL WORKS: a stranger posting the address did
    // not withdraw it. The control is the new address, which did get a row.
    const pendingRows = await database.db
      .select()
      .from(signupInvites)
      .where(eq(signupInvites.email, 'pending@example.org'));
    assert.equal(pendingRows.length, 1);
    assert.equal(pendingRows[0]?.revokedAt, null);
    assert.equal(pendingRows[0]?.dailyAiLimit, 200);
  });
});

test('the sixth request from one source in an hour is a 429, and a second source is untouched', async () => {
  await withOpenDoor(
    { openSignup: { ipThrottleConfig: SIGNUP_REQUEST_IP_THROTTLE }, trustProxy: 1 },
    async (service) => {
      const fromA = { 'x-forwarded-for': '203.0.113.7' };
      for (let attempt = 1; attempt <= 5; attempt += 1) {
        const response = await requestSignup(service, { email: `a${attempt}@example.org` }, fromA);
        assert.equal(response.status, 202, `attempt ${attempt}`);
      }
      const sixth = await requestSignup(service, { email: 'a6@example.org' }, fromA);
      assert.equal(sixth.status, 429);
      assert.ok(Number(sixth.headers.get('retry-after')) > 0, 'a 429 names when to come back');
      assert.equal(service.mailer.invites.length, 5, 'the refused request sent nothing');

      // THE CONTROL: another source on the same instance, at the same moment.
      const fromB = await requestSignup(service, { email: 'b1@example.org' }, { 'x-forwarded-for': '198.51.100.9' });
      assert.equal(fromB.status, 202);
    },
  );
});

test('one mailbox gets one letter a day, however it is spelled, and every request still answers 202', async () => {
  await withOpenDoor({}, async (service) => {
    const first = await requestSignup(service, { email: 'anna@gmail.com' });
    const again = await requestSignup(service, { email: 'anna@gmail.com' });
    const dotted = await requestSignup(service, { email: 'a.n.n.a+diet@gmail.com' });
    for (const response of [first, again, dotted]) assert.equal(response.status, 202);
    assert.equal(service.mailer.invites.length, 1);

    // THE CONTROL: a different mailbox is not held back by the first one.
    await requestSignup(service, { email: 'bert@gmail.com' });
    assert.equal(service.mailer.invites.length, 2);
  });
});

test('a throwaway domain is refused with a code, and nothing is minted or mailed', async () => {
  await withOpenDoor({}, async (service) => {
    const refused = await requestSignup(service, { email: 'anna@mailinator.com' });
    assert.equal(refused.status, 400);
    assert.deepEqual(refused.body, { error: 'email-domain-refused' });
    const subdomain = await requestSignup(service, { email: 'anna@x.mailinator.com' });
    assert.equal(subdomain.status, 400);
    assert.equal(service.mailer.invites.length, 0);
    assert.equal((await database.db.select().from(signupInvites)).length, 0);

    // THE CONTROL: an ordinary domain through the same door.
    assert.equal((await requestSignup(service, { email: 'anna@example.org' })).status, 202);
  });
});

test('a malformed address is a 400 with a code', async () => {
  await withOpenDoor({}, async (service) => {
    const response = await requestSignup(service, { email: 'not an address' });
    assert.equal(response.status, 400);
    assert.deepEqual(response.body, { error: 'email-invalid' });
  });
});

test('a failed captcha is a 400 and mints nothing; an unreachable one is a 503', async () => {
  const failing = stubCaptcha('failed');
  await withOpenDoor({ openSignup: { captcha: failing } }, async (service) => {
    const response = await requestSignup(service, { email: 'anna@example.org', captchaToken: 'the-token' });
    assert.equal(response.status, 400);
    assert.deepEqual(response.body, { error: 'captcha-failed' });
    assert.deepEqual(failing.tokens, ['the-token']);
    assert.equal(service.mailer.invites.length, 0);
    assert.equal((await database.db.select().from(signupInvites)).length, 0);
  });

  await withOpenDoor({ openSignup: { captcha: stubCaptcha('unavailable') } }, async (service) => {
    const response = await requestSignup(service, { email: 'anna@example.org', captchaToken: 'the-token' });
    assert.equal(response.status, 503);
    assert.deepEqual(response.body, { error: 'captcha-unavailable' });
    assert.equal(service.mailer.invites.length, 0);
  });
});

test('a passed captcha mints, a refused domain never reaches the captcha, and /health names the site key', async () => {
  // THE CONTROL for the refusals above: the same door with a captcha that says yes.
  const passing = stubCaptcha('passed');
  await withOpenDoor({ openSignup: { captcha: passing, captchaSiteKey: 'site-key-123' } }, async (service) => {
    const refused = await requestSignup(service, { email: 'anna@mailinator.com', captchaToken: 'one' });
    assert.equal(refused.status, 400);
    assert.deepEqual(passing.tokens, [], 'a refused domain cost no captcha call');

    const response = await requestSignup(service, { email: 'anna@example.org', captchaToken: 'two' });
    assert.equal(response.status, 202);
    assert.deepEqual(passing.tokens, ['two']);
    assert.equal(service.mailer.invites.length, 1);

    const health = await service.request<HealthBody>({ method: 'GET', path: '/health' });
    assert.deepEqual(health.body.instance.signupCaptcha, { provider: 'turnstile', siteKey: 'site-key-123' });
  });
});

test('the operator stats count what this door minted, and nothing another door did', async () => {
  await withOpenDoor({}, async (service) => {
    await requestSignup(service, { email: 'one@example.org' });
    await requestSignup(service, { email: 'two@example.org' });
    // THE CONTROL: an operator's invite is not farming.
    await service.request({
      method: 'POST',
      path: '/v1/admin/invites',
      adminToken: ADMIN_TOKEN,
      body: { email: 'operator-mint@example.org' },
    });

    const stats = await service.request<{
      stats: { signup: { openSignupInvitesToday: number; openSignupInvitesLast7Days: number } };
    }>({
      method: 'GET',
      path: '/v1/admin/stats',
      adminToken: ADMIN_TOKEN,
    });
    assert.equal(stats.status, 200);
    assert.equal(stats.body.stats.signup.openSignupInvitesToday, 2);
    assert.equal(stats.body.stats.signup.openSignupInvitesLast7Days, 2);
  });
});

test('no address reaches a log line on any branch', async () => {
  const lines: RecordedLine[] = [];
  const logger = recordingLogger(lines);
  await withOpenDoor({ logger, authLogger: logger }, async (service) => {
    await service.signupThroughInvite({ email: 'held@example.org' });
    await requestSignup(service, { email: 'fresh-person@example.org' });
    await requestSignup(service, { email: 'fresh-person@example.org' });
    await requestSignup(service, { email: 'held@example.org' });
    await requestSignup(service, { email: 'throwaway@mailinator.com' });
  });

  // A CONTROL THE SWEEP CANNOT PASS BY FINDING NOTHING: the minting branch
  // did log, so the recorder saw the lines it was meant to see.
  assert.ok(lines.some((line) => line.message === 'Sign-up request minted an invite'));
  for (const address of ['fresh-person', 'held@', 'throwaway', 'mailinator']) {
    assert.deepEqual(linesCarrying(lines, address), [], `a log line carries ${address}`);
  }
});
