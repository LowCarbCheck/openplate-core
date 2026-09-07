/**
 * The promise that a reported photograph does not stay here, kept by the
 * service rather than by somebody remembering.
 *
 * "WE DELETE AFTER THIRTY DAYS" IS A SENTENCE IN A CONSENT DIALOG. A person
 * reads it before they hand over a photograph of their food, and a promise kept
 * by an operator running a query when they think of it is not kept. So the
 * sweep below runs inside the service, on a timer, on every instance that has
 * the feature on, and it needs no operator action and no cron entry in a
 * self-hoster's crontab.
 *
 * WHY THE SWEEP DELETES THE IMAGE BEFORE THE ROW, AND DOES NOT LEAN ON THE
 * CASCADE. `feedback_images.report_id` cascades from `feedback_reports` today,
 * so a bare `DELETE FROM feedback_reports WHERE created_at < $1` would remove
 * the bytes as well, and this file would be shorter. It would also be wrong the
 * day the bytes move: `FeedbackImageStore` exists precisely so a later S3 or
 * MinIO adapter is one file and no caller change, and an object store has no
 * foreign key to Postgres. A retention job written against the cascade would
 * then keep deleting rows and silently keep every photograph forever, with a
 * green test suite, because the row is what the test looked at. Deleting
 * through the store is the version that survives the move.
 *
 * IMAGE FIRST, ROW SECOND, and the failure modes are not symmetric. If the row
 * delete fails after the image delete succeeded, an operator is left with a row
 * that says it had an image and no bytes behind it, which is untidy and which
 * the next tick clears. The other order can leave BYTES with no row pointing at
 * them: nothing enumerates a `FeedbackImageStore` by design, so those bytes
 * would be unreachable and undeletable, which is the one outcome a retention
 * job must never produce.
 *
 * See `docs/adr/0006-a-reported-photograph-is-the-second-hole-in-the-claim.md`.
 */
import type { Logger } from '../logger.js';
import type { FeedbackAdminStore } from './feedback-admin-store.js';
import type { FeedbackImageStore } from './feedback-image-store.js';

/**
 * How long a reported estimate is kept, in days. THIS IS THE NUMBER THE CONSENT
 * WORDING STATES.
 *
 * ONE PLACE, ON PURPOSE. The client's consent dialog tells a person how long
 * their photograph is kept, and this constant decides when it is actually
 * deleted. Two copies of that number is one wrong sentence shown to somebody
 * who then hands over a photograph on the strength of it, so the client reads
 * this name (exported from the package barrel, `src/index.ts`) rather than
 * writing thirty into a locale bundle. If you change it here, the wording moves
 * with it; if you cannot change it here, it is not the retention window.
 *
 * Thirty days is long enough that a reviewer who is away for a fortnight still
 * finds the queue useful, and short enough to state in one sentence a person
 * can weigh.
 */
export const FEEDBACK_RETENTION_DAYS = 30;

/** {@link FEEDBACK_RETENTION_DAYS} in milliseconds. Derived, never a second literal. */
export const FEEDBACK_RETENTION_MS = FEEDBACK_RETENTION_DAYS * 24 * 60 * 60 * 1000;

/**
 * How often the sweep runs. Hourly, for the reason the token sweeper in
 * `main.ts` runs hourly: it is far more often than a day-scale window needs, it
 * costs one indexed read on an empty result, and it means a restarted container
 * catches up within the hour rather than at some remembered time of day.
 */
export const FEEDBACK_RETENTION_INTERVAL_MS = 60 * 60 * 1000;

/**
 * How many reports one tick deletes at most.
 *
 * A BOUND ON ONE TICK, NOT ON THE BACKLOG. An instance that has had the feature
 * on for a year and the sweep off by a bug would otherwise try to delete
 * everything in one pass, holding a connection while it did. Anything left over
 * is taken by the next tick an hour later, oldest first.
 */
export const FEEDBACK_RETENTION_BATCH_LIMIT = 200;

/** The instant before which a report is over age. Pure, so a test names "now" instead of waiting a month. */
export function feedbackRetentionCutoff(now: Date): Date {
  return new Date(now.getTime() - FEEDBACK_RETENTION_MS);
}

export interface FeedbackRetentionStores {
  reports: FeedbackAdminStore;
  /** The photograph goes through the store, never through the cascade. See the module header. */
  images: FeedbackImageStore;
}

/**
 * Deletes every report older than the window, image and row, and answers how
 * many went. The imperative half of this module, and the only one that touches
 * a store.
 */
export async function purgeExpiredFeedback(
  input: FeedbackRetentionStores & { before: Date; batchLimit?: number },
): Promise<{ deleted: number }> {
  const expired = await input.reports.listExpiredIds({
    before: input.before,
    limit: input.batchLimit ?? FEEDBACK_RETENTION_BATCH_LIMIT,
  });
  if (expired.length === 0) return { deleted: 0 };

  let deleted = 0;
  for (const reportId of expired) {
    await input.images.delete(reportId);
    const dropped = await input.reports.delete(reportId);
    if (dropped) deleted += 1;
  }
  return { deleted };
}

export interface FeedbackRetentionOptions extends FeedbackRetentionStores {
  logger: Logger;
  /** Injected, like every clock in this repo, so a test names the day instead of waiting for it. */
  now(): Date;
  /** Defaults to {@link FEEDBACK_RETENTION_INTERVAL_MS}. A test passes milliseconds so it does not wait an hour. */
  intervalMs?: number;
  batchLimit?: number;
}

/** The handle `main.ts` holds. One method, because there is nothing else a caller may do to a running sweep. */
export interface FeedbackRetentionSweep {
  /** Stops the timer. Idempotent, and safe to call on a sweep that has already stopped. */
  stop(): void;
  /**
   * Runs one sweep now and resolves when it is done. The timer calls exactly
   * this, so a test that awaits it is exercising the scheduled work rather than
   * a second code path beside it.
   */
  runOnce(): Promise<{ deleted: number }>;
}

/**
 * Starts the retention sweep and hands back the handle that stops it.
 *
 * IT MUST NOT KEEP A PROCESS ALIVE, and it must not keep a TEST alive either.
 * The interval is `unref`ed, so a container that has finished serving exits and
 * a test runner is never held open by a sweep nobody stopped. `stop()` on top
 * of that is what `main.ts`'s shutdown calls, and what every test calls in a
 * `finally`.
 *
 * A FAILED SWEEP IS LOGGED AND THE NEXT TICK TRIES AGAIN, exactly as the token
 * sweeper in `main.ts` does. A throw out of a timer callback would take the
 * process down, and a database that was briefly unreachable is not a reason to
 * stop serving requests; an hour later the same rows are still over age and
 * still get deleted.
 */
export function startFeedbackRetention(options: FeedbackRetentionOptions): FeedbackRetentionSweep {
  const { logger } = options;

  async function runOnce(): Promise<{ deleted: number }> {
    const result = await purgeExpiredFeedback({
      reports: options.reports,
      images: options.images,
      before: feedbackRetentionCutoff(options.now()),
      batchLimit: options.batchLimit,
    });
    // The COUNT and the window, never a report id and never an account id. This
    // line says the promise was kept; naming whose photograph was deleted would
    // put a person back into a log that outlives the thing it describes.
    if (result.deleted > 0) {
      logger.info('Deleted reported estimates past their retention window', {
        deleted: result.deleted,
        retentionDays: FEEDBACK_RETENTION_DAYS,
      });
    }
    return result;
  }

  const timer = setInterval(() => {
    void (async () => {
      try {
        await runOnce();
      } catch (cause) {
        logger.error('Feedback retention sweep failed', {
          error: cause instanceof Error ? cause.message : 'unknown error',
        });
      }
    })();
  }, options.intervalMs ?? FEEDBACK_RETENTION_INTERVAL_MS);
  // Never the reason the process, or a test runner, stays alive.
  timer.unref();

  return {
    stop(): void {
      clearInterval(timer);
    },
    runOnce,
  };
}
