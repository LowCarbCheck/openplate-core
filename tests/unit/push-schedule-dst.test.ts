/**
 * The catch-up goes out exactly once per LOCAL day, across both Europe/Berlin
 * changeovers.
 *
 * WHY A MINUTE BY MINUTE WALK RATHER THAN A FEW NAMED INSTANTS. The defect this
 * file exists to catch is a UTC modulo standing in for a local clock, and that
 * defect is invisible at any single instant: it gives the right answer on every
 * ordinary day and the wrong one twice a year. Walking every minute of a four
 * day window around each changeover is the only assertion that can fail for the
 * real reason.
 *
 * THE SPRING CASE IS THE CONTROL. On the last Sunday in March, Europe/Berlin
 * skips 02:00 to 03:00 and the local day is 23 hours long; a scheduler that
 * counted 24 hour periods drifts an hour later every changeover and eventually
 * sends twice on one day or skips one entirely. The autumn day is 25 hours and
 * breaks the same scheme the other way, and both are here because a fix for one
 * is not a fix for the other.
 *
 * IT RUNS THE REAL TICK against the in memory store and a fake sender, so the
 * mark one minute writes is the mark the next minute reads. A test that called
 * `planPushSends` alone would never see a mark and would report a send every
 * minute after 08:00.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runPushTick } from '../../src/push/push-scheduler.js';
import { localClock, localDayKey } from '../../src/push/local-day.js';
import { createSilentLogger } from '../../src/logger.js';
import { createFakePushStore } from './fake-push-store.js';

const BERLIN = 'Europe/Berlin';
/** 08:00 local, the hour the whole feature is about. */
const EIGHT_AM = 8 * 60;
const MINUTE_MS = 60 * 1000;
const ENDPOINT = 'https://push.example.org/berlin';

/** One delivery, with the instant the tick made it, so an assertion can name the local day it belongs to. */
interface WalkedPush {
  at: Date;
  payload: string;
  topic: string;
  urgency: string;
}

interface WalkResult {
  sent: WalkedPush[];
  /** Every local day the walk touched at or after the catch-up minute, which is the set that should each get one. */
  dueDays: string[];
}

/** Walks `minutes` ticks from `from`, one minute apart, and reports what went out. */
async function walk(input: { from: Date; minutes: number }): Promise<WalkResult> {
  const store = createFakePushStore();
  const sent: WalkedPush[] = [];
  const dueDays = new Set<string>();

  // Seeded as seen on the first local day of the window, and kept seen below,
  // so the seven day pause is never what this file measures.
  // `push-send-limits.test.ts` owns that rule.
  store.seed({
    endpoint: ENDPOINT,
    accountId: 1,
    timeZone: BERLIN,
    catchUpMinute: EIGHT_AM,
    lastSeenDay: localDayKey(input.from, BERLIN),
  });

  for (let minute = 0; minute < input.minutes; minute += 1) {
    const at = new Date(input.from.getTime() + minute * MINUTE_MS);
    const local = localClock(at, BERLIN);
    if (local.minuteOfDay >= EIGHT_AM) dueDays.add(local.day);

    await runPushTick({
      store,
      sender: async (_credential, payload, options) => {
        sent.push({ at, payload, topic: options.topic, urgency: options.urgency });
      },
      logger: createSilentLogger(),
      now: () => at,
    });

    // The device keeps being seen, exactly as a person opening the app keeps it
    // seen. Without this the seven day rule would end the walk quietly.
    const row = store.rows.get(ENDPOINT);
    if (row !== undefined) store.rows.set(ENDPOINT, { ...row, lastSeenDay: local.day });
  }

  return { sent, dueDays: [...dueDays].toSorted() };
}

/** The local day each send belongs to, sorted, so it can be compared with the days that were due. */
function sentDays(sent: readonly WalkedPush[]): string[] {
  return sent.map((push) => localDayKey(push.at, BERLIN)).toSorted();
}

/**
 * Every send landed on the subscription's own 08:00, to the minute.
 *
 * THE DAY COUNT ALONE IS NOT ENOUGH, and this is the assertion that makes the
 * file falsifiable. A scheduler that read the clock in UTC instead of in Berlin
 * still sends once per local day: it just sends at 09:00 or 10:00 local
 * depending on the season, which a set of days cannot see. A scheduler that
 * counts 24 hour periods drifts by an hour at each changeover, which a set of
 * days cannot see either. The minute sees both.
 */
function assertEveryPushLandedAtTheLocalMinute(sent: readonly WalkedPush[], minute: number): void {
  const offBy = sent
    .map((push) => ({ day: localDayKey(push.at, BERLIN), at: localClock(push.at, BERLIN).minuteOfDay }))
    .filter((landed) => landed.at !== minute);
  assert.deepEqual(offBy, [], 'every catch-up must land on the local minute it was scheduled for');
}

test('the spring changeover: one catch-up per local day across the 23 hour day', async () => {
  // Four days from 2026-03-27T00:00Z, which contains the last Sunday in March.
  // Berlin goes +01:00 to +02:00 at 02:00 local on the 29th.
  const from = new Date('2026-03-27T00:00:00Z');
  const { sent, dueDays } = await walk({ from, minutes: 4 * 24 * 60 });

  assert.ok(dueDays.includes('2026-03-29'), 'the window must actually contain the changeover');
  assert.deepEqual(sentDays(sent), dueDays, 'exactly one catch-up on every local day that reached 08:00');
  assertEveryPushLandedAtTheLocalMinute(sent, EIGHT_AM);
});

test('the autumn changeover: one catch-up per local day across the 25 hour day', async () => {
  // Four days from 2026-10-23T00:00Z, containing the last Sunday in October.
  // Berlin goes +02:00 to +01:00 at 03:00 local on the 25th, so that local day
  // is 25 hours long and a 24 hour scheme sends twice on it.
  const from = new Date('2026-10-23T00:00:00Z');
  const { sent, dueDays } = await walk({ from, minutes: 4 * 24 * 60 });

  assert.ok(dueDays.includes('2026-10-25'), 'the window must actually contain the changeover');
  assert.deepEqual(sentDays(sent), dueDays, 'exactly one catch-up on every local day that reached 08:00');
  assertEveryPushLandedAtTheLocalMinute(sent, EIGHT_AM);
});

test('every send carries a kind and nothing else, on the catch-up topic at normal urgency', async () => {
  const { sent } = await walk({ from: new Date('2026-03-27T00:00:00Z'), minutes: 2 * 24 * 60 });

  assert.ok(sent.length > 0, 'the walk must have sent something for these assertions to mean anything');
  for (const push of sent) {
    assert.equal(push.payload, '{"kind":"catch-up"}');
    assert.equal(push.topic, 'openplate-catchups');
    assert.equal(push.urgency, 'normal');
  }
});

test('the control: a subscription with no catch-up minute is never sent to', async () => {
  // Without this, a tick that sent on every minute regardless of the schedule
  // would still have to produce one per day above to pass, and a tick that
  // ignored `catchUpMinute` entirely would not be caught at all.
  const store = createFakePushStore();
  store.seed({ endpoint: 'https://push.example.org/quiet', accountId: 1, timeZone: BERLIN, lastSeenDay: '2026-03-27' });

  let calls = 0;
  const result = await runPushTick({
    store,
    sender: async () => {
      calls += 1;
    },
    logger: createSilentLogger(),
    now: () => new Date('2026-03-27T09:00:00Z'),
  });

  assert.equal(calls, 0, 'a device that asked for nothing receives nothing');
  assert.equal(result.sent, 0);
});
