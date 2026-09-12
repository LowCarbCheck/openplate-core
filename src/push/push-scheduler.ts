/**
 * The minute tick: the only thing on this service that decides a push should
 * happen.
 *
 * MODELLED ON `pulse/pulse-retention.ts` and `ai/usage-retention.ts`, down to
 * the unrefed timer, the injected clock and the failure that is logged rather
 * than thrown out of the callback. It differs from both in its period, and the
 * period is the point: the sweeps are hourly because a row deleted at 14:59
 * instead of 14:00 is the same deletion, and a catch-up that arrives at 08:59
 * instead of 08:00 is a different notification.
 *
 * THE DECISION IS PURE AND THE SENDING IS NOT. `planPushSends` takes the rows
 * and an instant and answers what should go out; `runPushTick` sends it, prunes
 * what the push service disowned, and writes the marks. That split is what lets
 * `tests/unit/push-schedule-dst.test.ts` walk both Berlin changeovers minute by
 * minute in milliseconds, and it is the half of this feature most likely to be
 * wrong.
 *
 * THREE RULES, all of them in ADR-0008:
 *
 *  1. The catch-up goes out once per LOCAL day, when the subscription's own
 *     clock has passed its minute and it has not already gone out today there.
 *  2. A subscription whose `last_seen_day` is more than seven local days old
 *     receives no catch-up. Somebody who stopped using the app is not chased.
 *  3. At most two sends per subscription per UTC day, counted in the row. It is
 *     what bounds the damage a clock bug can do, and a clock bug is the most
 *     likely defect here.
 */
import { utcDayKey } from '../lib/utc-day.js';
import type { Logger } from '../logger.js';
import { localClock, localDaysBetween } from './local-day.js';
import type { PushSubscriptionRow, PushStore } from './push-store.js';
import {
  describeSendError,
  isGoneStatus,
  pushPayload,
  sendErrorStatus,
  sendOptionsFor,
  type PushKind,
  type PushSender,
} from './send.js';

/** At most this many pushes reach one subscription in one UTC day. ADR-0008 states the number. */
export const PUSH_DAILY_SEND_CAP = 2;

/** How many LOCAL days of silence stop the catch-up. A device seen 7 days ago still gets one; 8 does not. */
export const PUSH_LAST_SEEN_DAYS = 7;

/** A minute, because the catch-up is due at a minute. See the module header on why this is not the sweeps' hour. */
export const PUSH_TICK_INTERVAL_MS = 60 * 1000;

/** One push the tick decided on, with the two marks the store writes after it lands. */
export interface PlannedPush {
  endpoint: string;
  kind: PushKind;
  /** The subscription's own local day, which is what `last_catch_up_day` records. */
  localDay: string;
  /** The UTC day the cap counts over, and the count this send makes it. */
  sendsDay: string;
  sends: number;
}

/** One push that was due and was not sent, so the tick can log a number instead of silently dropping it. */
export interface SkippedPush {
  endpoint: string;
  kind: PushKind;
  reason: 'daily-cap';
}

export interface PushPlan {
  sends: PlannedPush[];
  skipped: SkippedPush[];
}

/** How many sends this subscription has already spent on `utcDay`. A different day is a fresh two. */
function sendsUsedOn(row: PushSubscriptionRow, utcDay: string): number {
  return row.sendsTodayDay === utcDay ? row.sendsToday : 0;
}

/** Whether the catch-up is due on this subscription's own clock right now. Pure, and the whole of rules 1 and 2. */
function catchUpIsDue(input: { row: PushSubscriptionRow; localDay: string; localMinute: number }): boolean {
  const { row } = input;
  if (row.catchUpMinute === null) return false;
  if (input.localMinute < row.catchUpMinute) return false;
  // ALREADY GONE OUT TODAY, where today is this device's today. A UTC
  // comparison here is the defect the DST test exists to catch.
  if (row.lastCatchUpDay === input.localDay) return false;

  const silentDays = localDaysBetween({ from: row.lastSeenDay, to: input.localDay });
  // An unreadable stored day is treated as silence rather than as permission:
  // the failure mode of the other choice is pushing somebody forever.
  if (silentDays === null) return false;
  return silentDays <= PUSH_LAST_SEEN_DAYS;
}

/** Whether the fast target alert is due: the instant has passed and this device asked for it. */
function fastTargetIsDue(input: { row: PushSubscriptionRow; now: Date }): boolean {
  const { row } = input;
  if (!row.fastTargetEnabled) return false;
  if (row.wakeAt === null) return false;
  return row.wakeAt.getTime() <= input.now.getTime();
}

/**
 * What should go out at this instant, given these rows. Pure: no clock, no
 * store, no library.
 */
export function planPushSends(input: { subscriptions: readonly PushSubscriptionRow[]; now: Date }): PushPlan {
  const sendsDay = utcDayKey(input.now);
  const sends: PlannedPush[] = [];
  const skipped: SkippedPush[] = [];

  for (const row of input.subscriptions) {
    const local = localClock(input.now, row.timeZone);
    let spent = sendsUsedOn(row, sendsDay);

    const due: PushKind[] = [];
    if (catchUpIsDue({ row, localDay: local.day, localMinute: local.minuteOfDay })) due.push('catch-up');
    if (fastTargetIsDue({ row, now: input.now })) due.push('fast-target');

    for (const kind of due) {
      if (spent >= PUSH_DAILY_SEND_CAP) {
        // SKIPPED, NEVER QUEUED. A postponed notification is a notification
        // that arrives at the wrong hour, which is worse than none.
        skipped.push({ endpoint: row.endpoint, kind, reason: 'daily-cap' });
        continue;
      }
      spent += 1;
      sends.push({ endpoint: row.endpoint, kind, localDay: local.day, sendsDay, sends: spent });
    }
  }

  return { sends, skipped };
}

/** What one tick did, so the caller can log counts and a test can assert them. */
export interface PushTickResult {
  sent: number;
  skipped: number;
  /** Subscriptions the push service disowned with a 404 or a 410, and which this tick deleted. */
  pruned: number;
  /** Deliveries that failed for any other reason, which leave the row exactly where it was. */
  failed: number;
}

export interface PushTickOptions {
  store: PushStore;
  sender: PushSender;
  logger: Logger;
  /** Injected, like every clock in this repo, so a test names the minute instead of waiting for it. */
  now(): Date;
}

/**
 * One tick: plan, send, prune, mark.
 *
 * THE MARK IS WRITTEN ONLY AFTER THE SEND RESOLVES, so a push service that was
 * unreachable for an hour does not cost somebody their catch-up: the row still
 * says it has not gone out today, and the next minute tries again. The cap is
 * the thing that stops that retry becoming a flood.
 *
 * A FAILED DELIVERY LEAVES THE ROW ALONE unless the status was 404 or 410. See
 * `push/send.ts` on why a 400 or a 403 must never prune: one VAPID slip would
 * otherwise delete every subscription on the instance in a single minute.
 */
export async function runPushTick(options: PushTickOptions): Promise<PushTickResult> {
  const now = options.now();
  const subscriptions = await options.store.listSchedulable();
  const plan = planPushSends({ subscriptions, now });

  const byEndpoint = new Map<string, PushSubscriptionRow>();
  for (const row of subscriptions) byEndpoint.set(row.endpoint, row);

  const result: PushTickResult = { sent: 0, skipped: plan.skipped.length, pruned: 0, failed: 0 };

  for (const skip of plan.skipped) {
    // DEBUG, and with no endpoint in it. An operator debugging a missing
    // notification needs to know the cap bit; nobody needs to know whose phone.
    options.logger.debug('Push skipped by the daily cap', { kind: skip.kind, reason: skip.reason });
  }

  // SEQUENTIAL, deliberately, unlike collie's broadcast. This tick is a
  // scattering of one-off sends rather than one message to everybody, the
  // volume is one instance's phones once a minute, and a serial loop keeps the
  // cap arithmetic and the prune trivially ordered.
  for (const planned of plan.sends) {
    const row = byEndpoint.get(planned.endpoint);
    if (row === undefined) continue;

    try {
      await options.sender(
        // `{ endpoint, keys }` and nothing else: the row also carries a
        // schedule, and a sender serialises what it is handed.
        { endpoint: row.endpoint, keys: { p256dh: row.p256dh, auth: row.auth } },
        pushPayload(planned.kind),
        sendOptionsFor(planned.kind),
      );
    } catch (cause) {
      const status = sendErrorStatus(cause);
      if (isGoneStatus(status)) {
        await options.store.deleteGoneEndpoint({ endpoint: row.endpoint });
        result.pruned += 1;
        options.logger.info('Deleted a push subscription the push service disowned', { status });
        continue;
      }
      result.failed += 1;
      options.logger.warn('Push delivery failed', { kind: planned.kind, error: describeSendError(cause) });
      continue;
    }

    if (planned.kind === 'catch-up') {
      await options.store.markCatchUpSent({
        endpoint: row.endpoint,
        localDay: planned.localDay,
        sendsDay: planned.sendsDay,
        sends: planned.sends,
      });
    } else {
      await options.store.markFastTargetSent({
        endpoint: row.endpoint,
        sendsDay: planned.sendsDay,
        sends: planned.sends,
      });
    }
    result.sent += 1;
  }

  return result;
}

export interface PushSchedulerOptions extends PushTickOptions {
  /** Defaults to {@link PUSH_TICK_INTERVAL_MS}. A test passes milliseconds so it does not wait a minute. */
  intervalMs?: number;
}

/** The handle `main.ts` holds. Same contract as the pulse sweep's, for the same reasons. */
export interface PushScheduler {
  /** Stops the timer. Idempotent, and safe on one that has already stopped. */
  stop(): void;
  /** Runs one tick now and resolves when it is done. The timer calls exactly this. */
  runOnce(): Promise<PushTickResult>;
}

export function startPushScheduler(options: PushSchedulerOptions): PushScheduler {
  async function runOnce(): Promise<PushTickResult> {
    return runPushTick(options);
  }

  const timer = setInterval(() => {
    void (async () => {
      try {
        await runOnce();
      } catch (cause) {
        options.logger.error('Push tick failed', {
          error: cause instanceof Error ? cause.message : 'unknown error',
        });
      }
    })();
  }, options.intervalMs ?? PUSH_TICK_INTERVAL_MS);
  // Never the reason the process, or a test runner, stays alive.
  timer.unref();

  return {
    stop(): void {
      clearInterval(timer);
    },
    runOnce,
  };
}
