/**
 * The pulse tables stop growing, on their own, on every instance.
 *
 * MODELLED ON `ai/usage-retention.ts`, down to the unrefed hourly timer, the
 * failure that is logged rather than thrown out of the callback, and the sweep
 * that runs on every instance rather than behind a feature flag. The pulse has
 * no operator flag at all: the opt in is on the device, so an instance whose
 * people all turned it off still has to expire the rows from when one of them
 * had it on.
 *
 * FOUR PREDICATES, THREE WINDOWS, all of them stated in ADR-0007 and in
 * PROTOCOL.md §5.23:
 *
 *  - Day sums and the contributor rows beside them go at 30 days. The
 *    contributor row is the only account attributable thing the feature stores,
 *    and the only question it answers is "how many distinct people contributed
 *    that day", which nobody asks about a month ago.
 *  - Presence rows go once they are past their expiry, which is 30 minutes
 *    after the last heartbeat. The reader already ignores an expired row, so
 *    this sweep frees space rather than changing an answer.
 *  - Idempotency keys go at 24 hours, which is the window the protocol promises
 *    a replay is safe in.
 *
 * IDEMPOTENT BY CONSTRUCTION, exactly as the AI sweep is: every predicate is an
 * instant or a day and none of them is a cursor, so a second run in the same
 * hour matches nothing and reports zero.
 */
import type { Logger } from '../logger.js';
import { utcDayKeyDaysBefore } from '../lib/utc-day.js';
import type { PulsePruneCounts, PulseStore } from './pulse-store.js';

/**
 * How many UTC days of pulse sums are kept, counting today.
 *
 * THE ONE DEFINITION. The sweep below deletes on it, ADR-0007 states it, and
 * PROTOCOL.md §5.23 repeats it. Nothing reads a pulse day older than today, so
 * unlike the AI window this number bounds storage rather than a screen.
 */
export const PULSE_RETENTION_DAYS = 30;

/** How long a presence row outlives the heartbeat that wrote it. ADR-0007 states the number. */
export const PULSE_PRESENCE_TTL_MS = 30 * 60 * 1000;

/** How long an `Idempotency-Key` is remembered, which is the window a replay is promised to be safe in. */
export const PULSE_IDEMPOTENCY_TTL_MS = 24 * 60 * 60 * 1000;

/** Hourly, for the reason the AI sweep and the token sweeper are hourly: cheap, and a restart catches up within the hour. */
export const PULSE_RETENTION_INTERVAL_MS = 60 * 60 * 1000;

/**
 * The oldest UTC day that is kept. Everything strictly before it goes.
 *
 * `DAYS - 1`, because the window INCLUDES today: thirty days of sums is today
 * and the twenty-nine before it. Pure, so a test names "now" instead of waiting
 * a month.
 */
export function pulseRetentionCutoffDay(now: Date): string {
  return utcDayKeyDaysBefore(now, PULSE_RETENTION_DAYS - 1);
}

/** The instant an idempotency key stops being remembered. Pure, for the same reason. */
export function pulseIdempotencyCutoff(now: Date): Date {
  return new Date(now.getTime() - PULSE_IDEMPOTENCY_TTL_MS);
}

/** One sweep, as a pure composition of the two cutoffs above and the store's own delete. */
export async function prunePulse(input: { pulse: PulseStore; now: Date }): Promise<PulsePruneCounts> {
  return input.pulse.prune({
    beforeDay: pulseRetentionCutoffDay(input.now),
    now: input.now,
    keysBefore: pulseIdempotencyCutoff(input.now),
  });
}

export interface PulseRetentionOptions {
  pulse: PulseStore;
  logger: Logger;
  /** Injected, like every clock in this repo, so a test names the day instead of waiting for it. */
  now(): Date;
  /** Defaults to {@link PULSE_RETENTION_INTERVAL_MS}. A test passes milliseconds so it does not wait an hour. */
  intervalMs?: number;
}

/** The handle `main.ts` holds. Same shape as the AI sweep's, for the same reasons. */
export interface PulseRetentionSweep {
  /** Stops the timer. Idempotent, and safe on a sweep that has already stopped. */
  stop(): void;
  /**
   * Runs one sweep now and resolves when it is done. The timer calls exactly
   * this, so a test that awaits it exercises the scheduled work rather than a
   * second code path beside it.
   */
  runOnce(): Promise<PulsePruneCounts>;
}

export function startPulseRetention(options: PulseRetentionOptions): PulseRetentionSweep {
  const { logger } = options;

  async function runOnce(): Promise<PulsePruneCounts> {
    const removed = await prunePulse({ pulse: options.pulse, now: options.now() });
    // COUNTS AND THE WINDOW, never an account id and never a day. A pulse row
    // says somebody was here, and a log line outlives the row it describes.
    if (removed.days + removed.contributors + removed.presence + removed.idempotencyKeys > 0) {
      logger.info('Deleted community pulse rows past their retention window', {
        days: removed.days,
        contributors: removed.contributors,
        presence: removed.presence,
        idempotencyKeys: removed.idempotencyKeys,
        retentionDays: PULSE_RETENTION_DAYS,
      });
    }
    return removed;
  }

  const timer = setInterval(() => {
    void (async () => {
      try {
        await runOnce();
      } catch (cause) {
        logger.error('Community pulse retention sweep failed', {
          error: cause instanceof Error ? cause.message : 'unknown error',
        });
      }
    })();
  }, options.intervalMs ?? PULSE_RETENTION_INTERVAL_MS);
  // Never the reason the process, or a test runner, stays alive.
  timer.unref();

  return {
    stop(): void {
      clearInterval(timer);
    },
    runOnce,
  };
}
