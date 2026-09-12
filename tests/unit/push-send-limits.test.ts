/**
 * The two rules that keep this feature quiet: a seven day pause, and two sends
 * a day.
 *
 * BOTH ARE WRITTEN WITH THEIR CONTROL BESIDE THEM. "Eight days ago receives
 * nothing" passes against a scheduler that never sends at all, so "six days ago
 * receives the catch-up" is in the same file; "a third send is skipped" passes
 * against one that sends nothing after the first, so the two sends that DO go
 * out are asserted first.
 *
 * The boundary is stated as well as the two sides of it, because seven is the
 * number ADR-0008 names and the off by one is the likely defect.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PUSH_DAILY_SEND_CAP, PUSH_LAST_SEEN_DAYS, runPushTick } from '../../src/push/push-scheduler.js';
import { createSilentLogger } from '../../src/logger.js';
import { createFakePushStore, type FakePushStore } from './fake-push-store.js';

/** A fixed zone with no changeover anywhere near the instants below, so this file is about the rules and not the clock. */
const ZONE = 'Europe/Berlin';
/** 09:00 Berlin in winter, which is 08:00 UTC. Comfortably past the 08:00 local catch-up minute. */
const MORNING = new Date('2026-01-15T08:00:00Z');
/** The local day `MORNING` falls in. Every `lastSeenDay` below is counted back from it. */
const TODAY = '2026-01-15';
const EIGHT_AM = 8 * 60;

/** A local day `days` before {@link TODAY}, as `YYYY-MM-DD`. */
function daysAgo(days: number): string {
  return new Date(Date.parse(`${TODAY}T00:00:00Z`) - days * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

/** Runs one tick over the given store and answers how many deliveries the sender was asked for. */
async function tickAndCount(store: FakePushStore, now: Date): Promise<number> {
  let calls = 0;
  await runPushTick({
    store,
    sender: async () => {
      calls += 1;
    },
    logger: createSilentLogger(),
    now: () => now,
  });
  return calls;
}

/** One subscription that wants a catch-up at 08:00 local and was last seen `lastSeenDay`. */
function seedSeenOn(lastSeenDay: string): FakePushStore {
  const store = createFakePushStore();
  store.seed({
    endpoint: `https://push.example.org/${lastSeenDay}`,
    accountId: 1,
    timeZone: ZONE,
    catchUpMinute: EIGHT_AM,
    lastSeenDay,
  });
  return store;
}

test('a device last seen six days ago still gets its catch-up', async () => {
  // THE CONTROL FOR THE ABSENCE BELOW. Without it, a scheduler that sent to
  // nobody would satisfy the eight day case perfectly.
  assert.equal(await tickAndCount(seedSeenOn(daysAgo(6)), MORNING), 1);
});

test('a device last seen eight days ago gets nothing', async () => {
  assert.equal(await tickAndCount(seedSeenOn(daysAgo(8)), MORNING), 0);
});

test('the boundary is seven days inclusive, and eight is outside it', async () => {
  // The number ADR-0008 names, asserted from both sides so an off by one here
  // fails rather than shifting the promise by a day.
  assert.equal(PUSH_LAST_SEEN_DAYS, 7);
  assert.equal(await tickAndCount(seedSeenOn(daysAgo(7)), MORNING), 1, 'seven days is still within the window');
  assert.equal(await tickAndCount(seedSeenOn(daysAgo(8)), MORNING), 0, 'eight days is outside it');
});

test('a third send in one UTC day is skipped, and the row is not touched', async () => {
  const store = createFakePushStore();
  const endpoint = 'https://push.example.org/busy';
  // Two sends already spent today, a catch-up due, and a wake instant passed:
  // both kinds want to go out and neither may.
  store.seed({
    endpoint,
    accountId: 1,
    timeZone: ZONE,
    catchUpMinute: EIGHT_AM,
    fastTargetEnabled: true,
    wakeAt: new Date('2026-01-15T07:00:00Z'),
    lastSeenDay: TODAY,
    sendsTodayDay: '2026-01-15',
    sendsToday: PUSH_DAILY_SEND_CAP,
  });

  let calls = 0;
  const result = await runPushTick({
    store,
    sender: async () => {
      calls += 1;
    },
    logger: createSilentLogger(),
    now: () => MORNING,
  });

  assert.equal(calls, 0, 'nothing may go out once the cap is spent');
  assert.equal(result.skipped, 2, 'both kinds were due and both were skipped');
  const row = store.rows.get(endpoint);
  // A SKIPPED SEND IS NOT A SENT ONE. `wake_at` still stands, so the alert
  // arrives tomorrow rather than being silently consumed by a cap.
  assert.notEqual(row?.wakeAt, null);
  assert.equal(row?.lastCatchUpDay, null);
  assert.equal(row?.sendsToday, PUSH_DAILY_SEND_CAP);
});

test('the two sends under the cap DO go out, which is what makes the skip above mean something', async () => {
  const store = createFakePushStore();
  const endpoint = 'https://push.example.org/pair';
  store.seed({
    endpoint,
    accountId: 1,
    timeZone: ZONE,
    catchUpMinute: EIGHT_AM,
    fastTargetEnabled: true,
    wakeAt: new Date('2026-01-15T07:00:00Z'),
    lastSeenDay: TODAY,
  });

  const kinds: string[] = [];
  const result = await runPushTick({
    store,
    sender: async (_credential, payload) => {
      kinds.push(payload);
    },
    logger: createSilentLogger(),
    now: () => MORNING,
  });

  assert.deepEqual(kinds, ['{"kind":"catch-up"}', '{"kind":"fast-target"}']);
  assert.equal(result.sent, 2);
  assert.equal(result.skipped, 0);
  const row = store.rows.get(endpoint);
  assert.equal(row?.sendsToday, 2, 'the cap counter reached exactly the cap');
  assert.equal(row?.lastCatchUpDay, TODAY);
  // CLEARED, so the alert cannot fire a second time on the next minute.
  assert.equal(row?.wakeAt, null);
});

test('a new UTC day gives the subscription its two sends back', async () => {
  const store = createFakePushStore();
  store.seed({
    endpoint: 'https://push.example.org/yesterday',
    accountId: 1,
    timeZone: ZONE,
    catchUpMinute: EIGHT_AM,
    lastSeenDay: TODAY,
    // Spent yesterday, which must not count against today.
    sendsTodayDay: daysAgo(1),
    sendsToday: PUSH_DAILY_SEND_CAP,
  });

  assert.equal(await tickAndCount(store, MORNING), 1);
});

test('the fast target alert waits for its instant and rides its own topic', async () => {
  const store = createFakePushStore();
  const endpoint = 'https://push.example.org/fasting';
  store.seed({
    endpoint,
    accountId: 1,
    timeZone: ZONE,
    fastTargetEnabled: true,
    wakeAt: new Date('2026-01-15T12:00:00Z'),
    lastSeenDay: TODAY,
  });

  // Four hours early: due is due, and an alert that fired here would be an
  // alert about a fast that is still running.
  assert.equal(await tickAndCount(store, MORNING), 0);

  const topics: string[] = [];
  const urgencies: string[] = [];
  await runPushTick({
    store,
    sender: async (_credential, _payload, options) => {
      topics.push(options.topic);
      urgencies.push(options.urgency);
    },
    logger: createSilentLogger(),
    now: () => new Date('2026-01-15T12:00:00Z'),
  });

  assert.deepEqual(topics, ['openplate-fast'], 'its own collapse topic, never the catch-up slot');
  assert.deepEqual(urgencies, ['high'], 'high, because Android may otherwise hold a normal message until Doze');
  assert.equal(store.rows.get(endpoint)?.wakeAt, null);
});

test('a device that never asked for the fast target is not woken by a stale wake instant', async () => {
  // The control for the toggle: `wake_at` alone must not be enough.
  const store = createFakePushStore();
  store.seed({
    endpoint: 'https://push.example.org/opted-out',
    accountId: 1,
    timeZone: ZONE,
    fastTargetEnabled: false,
    wakeAt: new Date('2026-01-15T07:00:00Z'),
    lastSeenDay: TODAY,
  });

  assert.equal(await tickAndCount(store, MORNING), 0);
});
