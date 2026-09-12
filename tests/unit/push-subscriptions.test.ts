/**
 * A subscription row leaves this service in exactly three ways, and this file
 * is about two of them.
 *
 * ── THE PUSH SERVICE DISOWNED IT ────────────────────────────────────────────
 * A 404 or a 410 is RFC 8030's way of saying "this subscription is gone", and
 * the tick deletes the row. A 500 IS THE CONTROL, and it is not a formality: a
 * scheme that pruned on any failure would delete every subscription on the
 * instance the first time a VAPID key was pasted wrong, because a sender error
 * looks exactly like a device error from here.
 *
 * ── THE DEVICE SUPERSEDED IT ────────────────────────────────────────────────
 * A service worker re-registration mints a brand new endpoint without
 * `unsubscribe()`ing the old one, so the push service keeps answering 201 for a
 * row nothing will ever read. The send-time prune cannot see that, which is why
 * the device names its predecessor with `replaces`. The account is in the
 * predicate, and ANOTHER ACCOUNT'S ROW IS THE CONTROL: without it, a route that
 * deleted by endpoint alone would let any signed in caller unhook anybody
 * else's phone by naming their endpoint.
 *
 * The third way is the person's own `DELETE`, which lives with the other route
 * cases in `tests/integration/push-routes.test.ts` against a real database.
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { runPushTick } from '../../src/push/push-scheduler.js';
import { createSilentLogger } from '../../src/logger.js';
import { createFakePushStore, FakeWebPushError } from './fake-push-store.js';
import { registrationBody, startPushHarness, type PushHarness } from './push-harness.js';

const ZONE = 'Europe/Berlin';
const MORNING = new Date('2026-01-15T08:00:00Z');
const EIGHT_AM = 8 * 60;

/** One subscription with a catch-up due right now, whose send will fail with `status`. */
async function tickAgainstStatus(status: number): Promise<{ rows: number; pruned: number; failed: number }> {
  const store = createFakePushStore();
  store.seed({
    endpoint: 'https://push.example.org/doomed',
    accountId: 1,
    timeZone: ZONE,
    catchUpMinute: EIGHT_AM,
    lastSeenDay: '2026-01-15',
  });

  const result = await runPushTick({
    store,
    sender: async () => {
      throw new FakeWebPushError(status);
    },
    logger: createSilentLogger(),
    now: () => MORNING,
  });

  return { rows: store.rows.size, pruned: result.pruned, failed: result.failed };
}

test('a 410 deletes the row', async () => {
  const outcome = await tickAgainstStatus(410);
  assert.equal(outcome.rows, 0);
  assert.equal(outcome.pruned, 1);
  assert.equal(outcome.failed, 0);
});

test('a 404 deletes the row too', async () => {
  const outcome = await tickAgainstStatus(404);
  assert.equal(outcome.rows, 0);
  assert.equal(outcome.pruned, 1);
});

test('a 500 leaves the row exactly where it was', async () => {
  // THE CONTROL. See the module header: this is the case that stops one bad
  // credential emptying the table.
  const outcome = await tickAgainstStatus(500);
  assert.equal(outcome.rows, 1, 'a transient failure is not a dead device');
  assert.equal(outcome.pruned, 0);
  assert.equal(outcome.failed, 1);
});

test('nor does a 403, which is about the sender rather than about the device', async () => {
  const outcome = await tickAgainstStatus(403);
  assert.equal(outcome.rows, 1);
  assert.equal(outcome.pruned, 0);
});

test('a failed send does not mark the catch-up as done, so the next minute tries again', async () => {
  const store = createFakePushStore();
  const endpoint = 'https://push.example.org/retry';
  store.seed({ endpoint, accountId: 1, timeZone: ZONE, catchUpMinute: EIGHT_AM, lastSeenDay: '2026-01-15' });

  await runPushTick({
    store,
    sender: async () => {
      throw new FakeWebPushError(503);
    },
    logger: createSilentLogger(),
    now: () => MORNING,
  });

  const row = store.rows.get(endpoint);
  assert.equal(row?.lastCatchUpDay, null, 'nothing went out, so nothing is recorded as having gone out');
  assert.equal(row?.sendsToday, 0, 'and the cap is not spent on a delivery that never landed');
});

let harness: PushHarness;
after(async () => {
  await harness.close();
});

test('replaces removes this account own predecessor and leaves another account row alone', async () => {
  harness = await startPushHarness();

  // Anna's old phone, Bert's phone, and Anna about to re-register.
  const annaOld = 'https://push.example.org/anna-old';
  const bertOnly = 'https://push.example.org/bert-only';
  harness.store.seed({ endpoint: annaOld, accountId: harness.anna.accountId, timeZone: ZONE, lastSeenDay: '2026-01-15' });
  harness.store.seed({
    endpoint: bertOnly,
    accountId: harness.bert.accountId,
    timeZone: ZONE,
    lastSeenDay: '2026-01-15',
  });

  const created = await harness.request({
    person: harness.anna,
    method: 'PUT',
    path: '/v1/push/subscriptions',
    body: registrationBody({ endpoint: 'https://push.example.org/anna-new', replaces: annaOld }),
  });

  assert.equal(created.status, 201);
  assert.equal(harness.store.rows.has(annaOld), false, 'the predecessor went');
  assert.equal(harness.store.rows.has('https://push.example.org/anna-new'), true);
  assert.equal(harness.store.rows.has(bertOnly), true, 'and nobody else was touched');
});

test('naming somebody else endpoint as a predecessor deletes nothing', async () => {
  // THE CONTROL FOR THE CASE ABOVE, and the one that matters: a `replaces` that
  // ignored the account would make this route a way to unhook any phone on the
  // instance whose endpoint you could guess or read from a log.
  const bertOnly = 'https://push.example.org/bert-only';
  assert.equal(harness.store.rows.has(bertOnly), true, 'the fixture must still have it for this to mean anything');

  const created = await harness.request({
    person: harness.anna,
    method: 'PUT',
    path: '/v1/push/subscriptions',
    body: registrationBody({ endpoint: 'https://push.example.org/anna-third', replaces: bertOnly }),
  });

  assert.equal(created.status, 201);
  assert.equal(harness.store.rows.has(bertOnly), true, "another account's row survives being named");
});

test('re-registering the endpoint a device already holds answers 200 and keeps the row', async () => {
  const endpoint = 'https://push.example.org/anna-new';
  // A device naming ITSELF as its predecessor is naming itself, not an
  // ancestor, and deleting the row it is about to write would be a bug that
  // only showed up as a subscription that silently vanished.
  const again = await harness.request({
    person: harness.anna,
    method: 'PUT',
    path: '/v1/push/subscriptions',
    body: registrationBody({ endpoint, replaces: endpoint }),
  });

  assert.equal(again.status, 200, 'a refresh is 200, a first registration is 201');
  assert.equal(harness.store.rows.has(endpoint), true);
});

test('the sending keys never come back out of a route', async () => {
  // A subscription is a capability: anybody holding the endpoint and the
  // instance's VAPID private key can wake that phone.
  const response = await harness.request({
    person: harness.anna,
    method: 'PUT',
    path: '/v1/push/subscriptions',
    body: registrationBody({ endpoint: 'https://push.example.org/anna-keys' }),
  });
  const text = await response.text();

  assert.ok(!text.includes('anna-p256dh'), 'no route may echo the device public key');
  assert.ok(!text.includes('anna-auth'), 'nor its auth secret');
  assert.ok(!text.includes('https://push.example.org/anna-keys'), 'nor the endpoint it was given');
});
