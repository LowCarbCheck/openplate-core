/**
 * The document and the code agree (M253): the `/health` example of
 * PROTOCOL.md §5.6 and the `AccountView` example of §5.15 name exactly the
 * fields the running service sends, at the same depth.
 *
 * WHY AGAINST THE REAL SERVICE. A unit test can check that the example
 * parses; only the service can say whether an alternative client written from
 * that example would decode what it actually receives. The service here runs
 * the configuration the examples describe: open sign-up with a captcha, a
 * scan trial, and AI.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { setupTestDatabase, type TestDatabase } from './db-harness.js';
import { startService, type ServiceHarness } from './service-harness.js';
import { keyPaths, protocolExample } from '../unit/protocol-examples.js';
import type { JsonValue } from '../../src/lib/json.js';
import type { CaptchaVerdict } from '../../src/accounts/captcha.js';

let database: TestDatabase;
let service: ServiceHarness;

before(async () => {
  database = await setupTestDatabase();
  await database.reset();
  service = await startService({
    db: database.db,
    trial: { scans: 10, dailyAiLimit: 50 },
    trialAddressPepper: 'a-trial-address-pepper-that-is-long-enough-0123',
    openSignup: {
      captcha: { verify: async (): Promise<CaptchaVerdict> => 'passed' },
      captchaSiteKey: 'site-key',
    },
    ai: { baseUrl: 'http://127.0.0.1:9', apiKey: 'sk-unused', advertisedModel: 'a-model' },
  });
});

after(async () => {
  await service.close();
  await database.close();
});

test('the §5.6 example names exactly what /health sends', async () => {
  const health = await service.request<JsonValue>({ method: 'GET', path: '/health' });
  assert.deepEqual(keyPaths(protocolExample('### 5.6')), keyPaths(health.body));
});

test('the §5.15 example names exactly what GET /v1/auth/account sends', async () => {
  const session = await service.signupThroughInvite({ email: 'example@example.org', trialScans: 10, dailyAiLimit: 50 });
  const account = await service.request<{ account: JsonValue }>({
    method: 'GET',
    path: '/v1/auth/account',
    accessToken: session.tokens.accessToken,
  });
  assert.deepEqual(keyPaths(protocolExample('### 5.15')), keyPaths(account.body.account));
});
