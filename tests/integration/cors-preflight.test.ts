/**
 * The CORS preflight, judged the way a browser judges it.
 *
 * WHY THIS FILE EXISTS. `POST /v1/pulse/meal` carries an `Idempotency-Key`, and
 * `server/cors.ts` answered every preflight with an
 * `Access-Control-Allow-Headers` that did not name it. The preflight itself was
 * a clean `204`, so nothing looked wrong from the server: the browser read the
 * list, saw a header it had not been allowed to send, and NEVER SENT THE REAL
 * REQUEST. No request arrived, no access log line was written, and the app saw a
 * write that never answered. `Access-Control-Max-Age` is a day, so the refusal
 * was cached for a day too.
 *
 * AND ITS TWIN, FOUND IN THE SAME READING. The same module sent no
 * `Access-Control-Expose-Headers` at all, so the `Retry-After` every rate
 * limiter here computes was invisible to a script: `headers.get('Retry-After')`
 * answered `null` in a browser and the right number to `curl`. Two lists, two
 * browser rules, one file, and neither rule is enforced by anything this suite
 * can call directly.
 *
 * WHY THE EXISTING SUITE COULD NOT SEE IT. `pulse-today.test.ts` posts the same
 * body with the same header over real HTTP and is green, because neither `curl`
 * nor Node's `fetch` enforces CORS at all. Only a browser does. So the guard
 * here is not "the POST works", which was always true from Node; it is "a
 * browser would have been ALLOWED to send that POST", which is a statement about
 * one response header and is checkable from Node.
 *
 * FIVE CASES, and the last is the one that outlives both defects:
 *
 *   1. The preflight a browser sends before `POST /v1/pulse/meal` allows every
 *      header that request carries.
 *   2. `POST /v1/push/subscriptions` allows what that client sends, the contrast
 *      case, because the first thing asked of the pulse defect was how far it
 *      reached.
 *   3. The request the preflight permitted then answers `202`, so the allow list
 *      is not permitting something the route refuses.
 *   4. A real `429`, driven through the meal limiter, names `Retry-After` in
 *      `Access-Control-Expose-Headers`, so the number it carries is readable.
 *   5. EVERY header name any route in `src/` reads is on the allow list. A route
 *      added later that reads a new request header fails here rather than in a
 *      browser, which is the only other place it would ever fail.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { setupTestDatabase, type TestDatabase } from './db-harness.js';
import { sampleAuthHash, startService, type HttpResponse, type ServiceHarness } from './service-harness.js';

const ADMIN_TOKEN = 'integration-admin-token-0123456789abcdef';

/** What a browser would send on a pulse write: the two ordinary headers, plus the one M222 added. */
const PULSE_WRITE_HEADERS = ['authorization', 'content-type', 'idempotency-key'];

/**
 * Header names a script cannot set, so they are never on a preflight list.
 *
 * The fetch specification calls these FORBIDDEN REQUEST HEADERS: the browser
 * attaches them itself and refuses a script that tries. `User-Agent` is read by
 * `push/push-store.ts` off the subscription request, and allowing it would be a
 * promise about something no caller can ask for.
 */
const BROWSER_SET_HEADERS = new Set(['user-agent', 'host', 'origin', 'referer', 'cookie', 'content-length']);

let database: TestDatabase;
let service: ServiceHarness;

before(async () => {
  database = await setupTestDatabase();
  // ONCE, not per test: this file seeds one person and writes one meal, and the
  // rows another file left behind would collide on the address and on the key.
  await database.reset();
  service = await startService({ db: database.db, adminToken: ADMIN_TOKEN });
});

after(async () => {
  await service.close();
  await database.close();
});

/**
 * The set of header names a preflight response permits, lowercased.
 *
 * Lowercased because the header is case insensitive by RFC 9110 and the service
 * writes it in title case; a test that compared the written spelling would pin
 * the spelling rather than the permission.
 */
function allowedRequestHeaders(headers: Headers): Set<string> {
  const raw = headers.get('access-control-allow-headers') ?? '';
  return new Set(
    raw
      .split(',')
      .map((name) => name.trim().toLowerCase())
      .filter((name) => name !== ''),
  );
}

/** The preflight a browser sends before a cross-origin `POST` that carries `names`. */
async function preflight(path: string, names: string[]): Promise<Headers> {
  const response = await service.request<undefined>({
    method: 'OPTIONS',
    path,
    headers: {
      origin: 'https://app.openplate.de',
      'access-control-request-method': 'POST',
      'access-control-request-headers': names.join(','),
    },
  });
  assert.equal(response.status, 204, 'a preflight is answered 204');
  return response.headers;
}

test('the preflight for a pulse write allows the Idempotency-Key that write carries', async () => {
  const allowed = allowedRequestHeaders(await preflight('/v1/pulse/meal', PULSE_WRITE_HEADERS));

  // THE BROWSER'S RULE, stated once: every header the request will carry must
  // appear, or the request is never sent.
  const refused = PULSE_WRITE_HEADERS.filter((name) => !allowed.has(name));
  assert.deepEqual(refused, [], `a browser would refuse to send these headers: ${refused.join(', ')}`);
});

test('a push subscription preflight allows what that client sends', async () => {
  // The contrast case, and it is here because it was the first thing checked
  // when the pulse defect was found. `app/lib/push.ts` sends `Authorization`
  // and `Content-Type` and nothing else, so this subtree was never blocked.
  const allowed = allowedRequestHeaders(await preflight('/v1/push/subscriptions', ['authorization', 'content-type']));
  assert.ok(allowed.has('authorization'));
  assert.ok(allowed.has('content-type'));
});

test('the write a browser was allowed to send is the write the route accepts', async () => {
  const session = await service.signupThroughInvite({ email: 'cors@example.org', authHash: sampleAuthHash(23) });

  const response = await service.request<{ accepted: boolean }>({
    method: 'POST',
    path: '/v1/pulse/meal',
    accessToken: session.tokens.accessToken,
    headers: { 'idempotency-key': '2f9d0b41-6c3a-4e57-9f10-000000000001' },
    body: { kcal: 1250, protein: 35 },
  });

  assert.equal(response.status, 202);
  assert.deepEqual(response.body, { accepted: true });
});

test('a 429 lets a cross-origin script read the Retry-After it carries', async () => {
  const session = await service.signupThroughInvite({ email: 'retry@example.org', authHash: sampleAuthHash(29) });
  const accessToken = session.tokens.accessToken;

  const meal = async (key: string): Promise<HttpResponse<unknown>> =>
    service.request<unknown>({
      method: 'POST',
      path: '/v1/pulse/meal',
      accessToken,
      headers: { 'idempotency-key': key },
      body: { kcal: 1250, protein: 35 },
    });

  // A REAL REFUSAL, not a fixture. The meal limiter is one write a minute and
  // the harness clock does not move on its own, so the second write is the 429
  // this test is about, with the Retry-After the route computed.
  assert.equal((await meal('2f9d0b41-6c3a-4e57-9f10-000000000002')).status, 202);
  const refused = await meal('2f9d0b41-6c3a-4e57-9f10-000000000003');
  assert.equal(refused.status, 429);
  assert.ok(Number(refused.headers.get('retry-after')) > 0, 'the route sent a Retry-After to read');

  // THE BROWSER'S OTHER RULE. A script is handed the seven safelisted response
  // headers and nothing else, so a header the answer carries is still invisible
  // until it is named here. `Retry-After` is not one of the seven.
  const exposed = new Set(
    (refused.headers.get('access-control-expose-headers') ?? '')
      .split(',')
      .map((name) => name.trim().toLowerCase())
      .filter((name) => name !== ''),
  );
  assert.ok(exposed.has('retry-after'), 'a cross-origin script cannot read Retry-After off this answer');
});

/** Every `.ts` file under a directory, recursively. */
async function sourceFiles(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const found: string[] = [];
  for (const entry of entries) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      found.push(...(await sourceFiles(path)));
      continue;
    }
    if (entry.name.endsWith('.ts')) found.push(path);
  }
  return found;
}

test('every request header any route reads is on the allow list', async () => {
  const files = await sourceFiles(new URL('../../src', import.meta.url).pathname);
  const read = new Set<string>();
  for (const file of files) {
    const source = await readFile(file, 'utf8');
    // `req.header('x')` and `req.get('x')` are the two forms Express offers,
    // and both are read in this repo. The literal is the header name.
    for (const match of source.matchAll(/\breq\.(?:header|get)\(\s*'([^']+)'/g)) {
      const name = match[1];
      if (name === undefined) continue;
      const lowered = name.toLowerCase();
      if (!BROWSER_SET_HEADERS.has(lowered)) read.add(lowered);
    }
  }

  // A control the sweep cannot pass by finding nothing: the pulse write's
  // header is in `src/`, so an empty set means the regex stopped matching.
  assert.ok(read.has('idempotency-key'), 'the sweep found no `req.header` call it was written to find');

  const allowed = allowedRequestHeaders(await preflight('/v1/pulse/meal', PULSE_WRITE_HEADERS));
  // `Authorization` is read through the bearer middleware rather than a literal,
  // so it is asserted separately above and not expected in the swept set.
  const missing = [...read].filter((name) => !allowed.has(name)).toSorted();
  assert.deepEqual(missing, [], `these headers are read by a route and refused by CORS: ${missing.join(', ')}`);
});
