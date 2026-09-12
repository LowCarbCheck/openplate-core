/**
 * Boots the REAL `registerPushRoutes` in front of the in memory push store, on
 * an ephemeral loopback port, with a clock a test can move.
 *
 * IT MOUNTS THE ROUTES RATHER THAN CALLING THE HANDLERS, for the reason
 * `pulse-harness.ts` gives: the properties these files are about are WIRING
 * properties. Which middleware runs before which decides whether an anonymous
 * caller sees a 401 or a 404, and a test that called a handler could not see it.
 *
 * THE LOGGER RECORDS, because `push-log-leak.test.ts` needs lines to inspect
 * and a silent logger there would make the absence assertion pass against a
 * route that logged everything.
 */
import express from 'express';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { PUSH_API_PREFIX, registerPushRoutes } from '../../src/server/register-push-routes.js';
import { createBearerAuthMiddleware } from '../../src/server/bearer-auth.js';
import { createErrorMiddleware } from '../../src/server/error-middleware.js';
import { hashToken } from '../../src/lib/tokens.js';
import { createAuthFixture } from './auth-context-fixture.js';
import { createFakePushStore, type FakePushStore } from './fake-push-store.js';
import { createRecordingLogger, type RecordedLine } from './pulse-harness.js';

export { PUSH_API_PREFIX };
export type { RecordedLine };

/** The application server key this harness advertises. Public by definition, and not a real one. */
export const HARNESS_PUBLIC_KEY = 'BTestOnlyApplicationServerKeyNotRealAtAll';

/** One seeded person: their account id and the bearer token their device holds. */
export interface PushPerson {
  accountId: number;
  accessToken: string;
  /** The address the account was seeded with. Distinctive, so a log sweep has something falsifiable to look for. */
  email: string;
}

export interface PushHarness {
  baseUrl: string;
  store: FakePushStore;
  /** Every line the routes logged, in order. */
  logLines: RecordedLine[];
  /** The first seeded person. Most files need exactly one. */
  anna: PushPerson;
  /** A second person, for the "somebody else's endpoint" cases. */
  bert: PushPerson;
  now(): Date;
  advance(ms: number): void;
  request(input: { person: PushPerson | null; method: string; path: string; body?: unknown }): Promise<Response>;
  close(): Promise<void>;
}

export async function startPushHarness(): Promise<PushHarness> {
  const fixture = createAuthFixture();
  const store = createFakePushStore();
  const logLines: RecordedLine[] = [];

  async function seed(email: string, token: string): Promise<PushPerson> {
    const account = await fixture.store.seedAccount({ email });
    await fixture.store.insertTokens([
      {
        accountId: account.id,
        kind: 'access',
        tokenHash: hashToken(token),
        familyId: `family-${account.id}`,
        expiresAt: new Date(fixture.now().getTime() + 60 * 60 * 1000),
      },
    ]);
    return { accountId: account.id, accessToken: token, email };
  }

  const anna = await seed('anna-never-in-a-log-line@example.org', 'anna-access-token-never-in-a-log-line');
  const bert = await seed('bert-never-in-a-log-line@example.org', 'bert-access-token-never-in-a-log-line');

  const app = express();
  registerPushRoutes(app, {
    store,
    publicKey: HARNESS_PUBLIC_KEY,
    requireAuth: createBearerAuthMiddleware(fixture.ctx),
    logger: createRecordingLogger(logLines),
    now: fixture.now,
  });
  // The terminal handler the real app mounts last, so a test can see that the
  // route answered rather than falling through to it.
  app.use(createErrorMiddleware(createRecordingLogger(logLines)));

  const server: Server = app.listen(0);
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const address = server.address();
  if (address === null) throw new Error('expected a listening server');
  // SAFETY: `listen(0)` binds a TCP port, and Node returns a string address
  // only for a Unix domain socket, which this never opens.
  const { port } = address as AddressInfo;
  const baseUrl = `http://127.0.0.1:${port}`;

  return {
    baseUrl,
    store,
    logLines,
    anna,
    bert,
    now: fixture.now,
    advance: fixture.advance,
    async request(input: {
      person: PushPerson | null;
      method: string;
      path: string;
      body?: unknown;
    }): Promise<Response> {
      const headers = new Headers({ 'content-type': 'application/json' });
      // `null` is a test deliberately calling anonymously.
      if (input.person !== null) headers.set('authorization', `Bearer ${input.person.accessToken}`);
      headers.set('user-agent', 'openplate-test/1.0');
      return fetch(`${baseUrl}${input.path}`, {
        method: input.method,
        headers,
        body: input.body === undefined ? undefined : JSON.stringify(input.body),
      });
    },
    async close(): Promise<void> {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

/** Every field `PUT /v1/push/subscriptions` requires, named, so a case states only what it is about. */
export interface RegistrationBody {
  endpoint: string;
  keys: { p256dh: string; auth: string };
  timeZone: string;
  locale: string;
  catchUpMinute: number | null;
  fastTargetEnabled: boolean;
  replaces?: string;
}

/** A complete registration, with whatever the case wanted different. */
export function registrationBody(overrides: Partial<RegistrationBody> = {}): RegistrationBody {
  return {
    endpoint: 'https://push.example.org/anna-one',
    keys: { p256dh: 'anna-p256dh', auth: 'anna-auth' },
    timeZone: 'Europe/Berlin',
    locale: 'en',
    catchUpMinute: 8 * 60,
    fastTargetEnabled: false,
    ...overrides,
  };
}
