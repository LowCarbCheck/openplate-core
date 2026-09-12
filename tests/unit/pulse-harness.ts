/**
 * Boots the REAL `registerPulseRoutes` in front of the in-memory pulse store,
 * on an ephemeral loopback port, with a clock a test can move.
 *
 * IT MOUNTS THE ROUTES RATHER THAN CALLING THE HANDLERS, for the reason
 * `ai-route-limits.test.ts` gives: the properties these files are about are
 * WIRING properties. Which middleware runs before which is the whole of the
 * idempotency behaviour, and a test that called a handler could not see it.
 *
 * THE CLOCK IS THE FIXTURE'S, threaded into the routes, so the rate limit
 * windows and the five minute cache are assertable by moving time rather than
 * by sleeping through it.
 *
 * THE LOGGER RECORDS. `pulse-log-leak.test.ts` needs a line to inspect, and a
 * silent logger there would make the absence assertion pass against a route
 * that logged everything.
 */
import express from 'express';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { registerPulseRoutes, PULSE_API_PREFIX } from '../../src/server/register-pulse-routes.js';
import { createBearerAuthMiddleware } from '../../src/server/bearer-auth.js';
import { createErrorMiddleware } from '../../src/server/error-middleware.js';
import { hashToken } from '../../src/lib/tokens.js';
import type { LogFields, Logger } from '../../src/logger.js';
import { createAuthFixture } from './auth-context-fixture.js';
import { createFakePulseStore, type FakePulseStore } from './fake-pulse-store.js';

export { PULSE_API_PREFIX };

export interface RecordedLine {
  message: string;
  fields: LogFields | undefined;
}

export function createRecordingLogger(lines: RecordedLine[]): Logger {
  return {
    debug: (message, fields) => lines.push({ message, fields }),
    info: (message, fields) => lines.push({ message, fields }),
    warn: (message, fields) => lines.push({ message, fields }),
    error: (message, fields) => lines.push({ message, fields }),
  };
}

/** One seeded person: their account id and the bearer token their device holds. */
export interface PulsePerson {
  accountId: number;
  accessToken: string;
  /** The address the account was seeded with. Distinctive, so a log sweep has something falsifiable to look for. */
  email: string;
}

export interface PulseHarness {
  baseUrl: string;
  pulse: FakePulseStore;
  /** Every line the routes logged, in order. */
  logLines: RecordedLine[];
  /** The first seeded person. Most files need exactly one. */
  anna: PulsePerson;
  /** A second person, for the contributor and presence counts. */
  bert: PulsePerson;
  now(): Date;
  advance(ms: number): void;
  post(input: { person: PulsePerson; path: string; key?: string | null; body?: unknown }): Promise<Response>;
  get(input: { person: PulsePerson; path: string }): Promise<Response>;
  close(): Promise<void>;
}

export interface StartPulseHarnessOptions {
  /** Defaults to the production five minutes. A file about the cache names its own. */
  cacheTtlMs?: number;
}

/** A uuid v4 shaped key that differs per `seed`, so a test names the key it is replaying. */
export function pulseKey(seed: number): string {
  const hex = seed.toString(16).padStart(12, '0');
  return `6f1c3a1e-9d7b-4a2f-8b31-${hex}`;
}

export async function startPulseHarness(options: StartPulseHarnessOptions = {}): Promise<PulseHarness> {
  const fixture = createAuthFixture();
  const pulse = createFakePulseStore();
  const logLines: RecordedLine[] = [];

  async function seed(email: string, token: string): Promise<PulsePerson> {
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
  registerPulseRoutes(app, {
    pulse,
    requireAuth: createBearerAuthMiddleware(fixture.ctx),
    logger: createRecordingLogger(logLines),
    now: fixture.now,
    cacheTtlMs: options.cacheTtlMs,
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
    pulse,
    logLines,
    anna,
    bert,
    now: fixture.now,
    advance: fixture.advance,
    async post(input: { person: PulsePerson; path: string; key?: string | null; body?: unknown }): Promise<Response> {
      const headers = new Headers({
        authorization: `Bearer ${input.person.accessToken}`,
        'content-type': 'application/json',
      });
      // `null` is a test deliberately sending no key; absent is a test that
      // does not care and gets a fresh one.
      const key = input.key === undefined ? pulseKey(Date.now() % 1_000_000) : input.key;
      if (key !== null) headers.set('idempotency-key', key);
      return fetch(`${baseUrl}${input.path}`, {
        method: 'POST',
        headers,
        body: JSON.stringify(input.body ?? {}),
      });
    },
    async get(input: { person: PulsePerson; path: string }): Promise<Response> {
      return fetch(`${baseUrl}${input.path}`, {
        headers: { authorization: `Bearer ${input.person.accessToken}` },
      });
    },
    async close(): Promise<void> {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
