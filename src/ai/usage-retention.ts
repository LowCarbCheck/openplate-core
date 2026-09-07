/**
 * `ai_usage_days` stops growing forever.
 *
 * THE TABLE HAS NEVER FORGOTTEN ANYTHING. `db/schema.ts` said "nothing prunes
 * them yet" from the day the table was added, so every instance holds one row
 * per account per active day for the life of the deployment. A counter with no
 * end date is a day-by-day trace of when a person opened a health app, which is
 * not what a quota needs and not what the row was collected for.
 *
 * NINETY DAYS, decided by the operator on 2026-09-07. Long enough to see
 * whether a study participant is actually using the app across a normal
 * enrolment, and short enough that the instance is not keeping that trace
 * forever.
 *
 * ONE NUMBER, TWO USES. This is also the window `GET /v1/admin/accounts/:id/
 * activity` can show (`admin/account-activity.ts`), and the two are the same
 * binding on purpose: a window longer than the retention would draw an operator
 * a strip of zeroes for days whose rows the sweep had deleted, and read as a
 * person who stopped rather than as a row that expired.
 *
 * MODELLED ON `feedback/feedback-retention.ts`, down to the unrefed hourly
 * timer and the failure that is logged rather than thrown out of the callback.
 * What differs is that this sweep runs on EVERY instance, not only on one with
 * a feature flag set: an instance that had an upstream key last year and none
 * today still holds the rows from when it did, and a sweep wired behind the AI
 * surface would leave exactly those in place forever.
 */
import type { AiQuotaStore } from './quota-store.js';
import type { Logger } from '../logger.js';
import { utcDayKeyDaysBefore } from '../lib/utc-day.js';

/**
 * How many UTC days of AI usage counters are kept, counting today.
 *
 * THE ONE DEFINITION. `admin/account-activity.ts` caps its window at this, the
 * sweep below deletes on it, and `PROTOCOL.md` §5.20 states it. Two literals
 * that agree today are a drift waiting to happen, and the shape of the drift is
 * an operator reading a deleted row as an absence of activity.
 */
export const AI_USAGE_RETENTION_DAYS = 90;

/**
 * How often the sweep runs. Hourly, for the reason the token sweeper in
 * `main.ts` and the feedback sweep both run hourly: far more often than a
 * day-scale window needs, one indexed DELETE that usually matches nothing, and
 * a restarted container catches up within the hour rather than at some
 * remembered time of day.
 */
export const AI_USAGE_RETENTION_INTERVAL_MS = 60 * 60 * 1000;

/**
 * The oldest UTC day that is kept. Everything strictly before it goes.
 *
 * `DAYS - 1`, because the window INCLUDES today: ninety days of counters is
 * today and the eighty-nine before it. Pure, so a test names "now" instead of
 * waiting a quarter of a year.
 */
export function aiUsageRetentionCutoffDay(now: Date): string {
  return utcDayKeyDaysBefore(now, AI_USAGE_RETENTION_DAYS - 1);
}

/**
 * Deletes every usage row before the given day and answers how many went.
 *
 * IDEMPOTENT BY CONSTRUCTION. The predicate is a day, not a cursor and not a
 * batch marker, so a second run in the same hour matches nothing and reports
 * zero. There is no partial state a repeat could corrupt.
 */
export async function purgeExpiredAiUsage(input: {
  quota: AiQuotaStore;
  before: string;
}): Promise<{ deleted: number }> {
  return { deleted: await input.quota.purgeUsageBefore({ day: input.before }) };
}

export interface AiUsageRetentionOptions {
  quota: AiQuotaStore;
  logger: Logger;
  /** Injected, like every clock in this repo, so a test names the day instead of waiting for it. */
  now(): Date;
  /** Defaults to {@link AI_USAGE_RETENTION_INTERVAL_MS}. A test passes milliseconds so it does not wait an hour. */
  intervalMs?: number;
}

/** The handle `main.ts` holds. Same shape as the feedback sweep's, for the same reasons. */
export interface AiUsageRetentionSweep {
  /** Stops the timer. Idempotent, and safe on a sweep that has already stopped. */
  stop(): void;
  /**
   * Runs one sweep now and resolves when it is done. The timer calls exactly
   * this, so a test that awaits it exercises the scheduled work rather than a
   * second code path beside it.
   */
  runOnce(): Promise<{ deleted: number }>;
}

/**
 * Starts the retention sweep and hands back the handle that stops it.
 *
 * The interval is `unref`ed, so neither a container that has finished serving
 * nor a test runner is held open by a sweep nobody stopped, and a failed tick
 * is logged and retried an hour later rather than taking the process down: a
 * database that was briefly unreachable is not a reason to stop serving
 * requests, and the same rows are still over age on the next tick.
 */
export function startAiUsageRetention(options: AiUsageRetentionOptions): AiUsageRetentionSweep {
  const { logger } = options;

  async function runOnce(): Promise<{ deleted: number }> {
    const result = await purgeExpiredAiUsage({
      quota: options.quota,
      before: aiUsageRetentionCutoffDay(options.now()),
    });
    // The COUNT and the window, never an account id and never a day. This line
    // says the limit was kept; naming whose counter expired would put a person
    // back into a log that outlives the row it describes.
    if (result.deleted > 0) {
      logger.info('Deleted AI usage counters past their retention window', {
        deleted: result.deleted,
        retentionDays: AI_USAGE_RETENTION_DAYS,
      });
    }
    return result;
  }

  const timer = setInterval(() => {
    void (async () => {
      try {
        await runOnce();
      } catch (cause) {
        logger.error('AI usage retention sweep failed', {
          error: cause instanceof Error ? cause.message : 'unknown error',
        });
      }
    })();
  }, options.intervalMs ?? AI_USAGE_RETENTION_INTERVAL_MS);
  // Never the reason the process, or a test runner, stays alive.
  timer.unref();

  return {
    stop(): void {
      clearInterval(timer);
    },
    runOnce,
  };
}
