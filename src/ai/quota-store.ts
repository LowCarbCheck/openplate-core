/**
 * The AI spend control: a per-account, per-UTC-day counter that is RESERVED
 * before the upstream call and released only when the provider cannot have
 * billed us.
 *
 * WHY RESERVE-BEFORE RATHER THAN COUNT-AFTER. Counting after the fact has a
 * window in which N parallel requests all read the old count and all go
 * through: the check and the increment are two statements, and a client that
 * retries on error is precisely the client that will fire them together. The
 * reservation is ONE statement whose `WHERE` is the limit, so the database
 * decides, once, per request.
 *
 * ```sql
 * INSERT INTO ai_usage_days (account_id, day, count) VALUES ($1, $2, 1)
 * ON CONFLICT (account_id, day) DO UPDATE SET count = ai_usage_days.count + 1
 * WHERE ai_usage_days.count < $3
 * RETURNING count
 * ```
 *
 * Zero rows back means the limit was already reached. The `WHERE` on the
 * `DO UPDATE` is the whole guarantee: two concurrent requests at `count = limit
 * - 1` serialise on the row lock, and exactly one of them sees a count below
 * the limit.
 *
 * THE INSERT BRANCH IS NOT GUARDED, and it does not need to be: it only fires
 * when no row exists for the day, which means a count of zero, and a caller
 * with `limit = 0` is refused by the route before it ever reaches here
 * (`403 ai-not-allowed`). A limit of zero reaching this method would insert a
 * row with `count = 1`, which is why the route's guard is load-bearing rather
 * than cosmetic.
 *
 * THE RELEASE IS FLOORED AT ZERO. `WHERE count > 0` stops a double release (a
 * retry, a future bug) from driving the counter negative, which would hand out
 * free requests rather than merely miscounting.
 *
 * THE SAME STORE OWNS THE INSTANCE-WIDE CEILING (M212 spec 02), in its own
 * section at the bottom of this file. It is the same one-statement upsert
 * against a table of one row per day, and the doc block down there says why
 * the obvious alternative, a `SUM` over `ai_usage_days`, is a statistic and
 * not a limit. It is here rather than in a second store because both halves
 * write counters this module is the only writer of.
 */
import { and, eq, gt, lt, sql } from 'drizzle-orm';
import type { Database } from '../db/client.js';
import { aiInstanceDays, aiUsageDays } from '../db/schema.js';

/**
 * The outcome of a reservation.
 *
 * `used` is the count AFTER a successful reserve, so it is what
 * `X-Quota-Used` reports; on a refusal it is the limit, because that is what
 * the caller has spent.
 */
export type ReserveResult = { ok: true; used: number; limit: number } | { ok: false; used: number; limit: number };

export interface AiQuotaStore extends AiInstanceCeilingStore {
  /**
   * Takes one unit of the account's allowance for the given UTC day, atomically.
   *
   * Callers MUST have refused a `limit` of 0 before reaching here — see the
   * module header on why the insert branch is unguarded.
   */
  reserve(input: { accountId: number; day: string; limit: number }): Promise<ReserveResult>;
  /** Gives one unit back. Floored at zero, and never throws out of the proxy's hands (see its `releaseQuietly`). */
  release(input: { accountId: number; day: string }): Promise<void>;
  /** How many requests every account together spent on the given day. An operator statistic, never a limit. */
  countRequestsOn(day: string): Promise<number>;
  /**
   * Deletes every counter row before the given UTC day, and answers how many
   * went. The retention half of this table, driven by
   * `ai/usage-retention.ts`.
   *
   * IT LIVES ON THE STORE THAT WRITES THE TABLE, on purpose. The reserve above
   * is the only thing that creates these rows, and putting the delete anywhere
   * else would leave two modules holding one table between them. It is NOT on
   * the admin metadata store, which is a read contract by construction.
   */
  purgeUsageBefore(input: { day: string }): Promise<number>;
}

export function createDrizzleAiQuotaStore(db: Database): AiQuotaStore {
  return {
    // The instance-wide half, from the bottom of this file. Spread in rather
    // than re-declared, so there is exactly one implementation of each and one
    // store the proxy has to be handed.
    ...createDrizzleAiInstanceCeiling(db),

    async reserve(input: { accountId: number; day: string; limit: number }): Promise<ReserveResult> {
      const rows = await db
        .insert(aiUsageDays)
        .values({ accountId: input.accountId, day: input.day, count: 1 })
        .onConflictDoUpdate({
          target: [aiUsageDays.accountId, aiUsageDays.day],
          set: { count: sql`${aiUsageDays.count} + 1` },
          // THE LIMIT IS THE PREDICATE, which is what makes this one statement
          // rather than a read and a write with a race between them.
          where: sql`${aiUsageDays.count} < ${input.limit}`,
        })
        .returning({ count: aiUsageDays.count });

      const row = rows[0];
      // Zero rows means the `WHERE` was false: the account is at its limit, so
      // it has spent exactly `limit`.
      if (!row) return { ok: false, used: input.limit, limit: input.limit };
      return { ok: true, used: row.count, limit: input.limit };
    },

    async release(input: { accountId: number; day: string }): Promise<void> {
      await db
        .update(aiUsageDays)
        .set({ count: sql`${aiUsageDays.count} - 1` })
        // Floored at zero: a double release must miscount upward, never
        // downward, because a negative counter is free requests.
        .where(and(eq(aiUsageDays.accountId, input.accountId), eq(aiUsageDays.day, input.day), gt(aiUsageDays.count, 0)));
    },

    async countRequestsOn(day: string): Promise<number> {
      const rows = await db
        .select({ total: sql<number>`coalesce(sum(${aiUsageDays.count}), 0)::int` })
        .from(aiUsageDays)
        .where(eq(aiUsageDays.day, day));
      return rows[0]?.total ?? 0;
    },

    async purgeUsageBefore(input: { day: string }): Promise<number> {
      // `returning` a column rather than trusting a driver row count, so the
      // number the sweep logs is rows this statement actually removed. The
      // predicate is a day and not a cursor, which is what makes a second run
      // in the same hour a no-op rather than a partial repeat.
      const deleted = await db
        .delete(aiUsageDays)
        .where(lt(aiUsageDays.day, input.day))
        .returning({ accountId: aiUsageDays.accountId });
      return deleted.length;
    },
  };
}

// =============================================================================
// The instance-wide ceiling (M212 spec 02)
// =============================================================================

/**
 * The instance-wide half of `createDrizzleAiQuotaStore`, which spreads this in.
 *
 * WHY THERE IS A SECOND COUNTER AT ALL. Every other guard in this service is
 * per account: the minute limiter and the daily quota above both key on the
 * caller. Ten accounts at 200 requests a day is 2000 requests a day, and until
 * M212 nothing in the process said no. Invitations multiply accounts; they do
 * not multiply the bound, because there was no bound.
 *
 * ONE STATEMENT WHOSE `WHERE` IS THE CEILING, for exactly the reason `reserve`
 * above is one: a read followed by a write has a window in which N parallel
 * requests all see the old total, and this is the counter that stands between
 * five invitations per member and the operator's provider bill.
 *
 * ```sql
 * INSERT INTO ai_instance_days (day, count) VALUES ($1, 1)
 * ON CONFLICT (day) DO UPDATE SET count = ai_instance_days.count + 1
 * WHERE ai_instance_days.count < $2
 * RETURNING count
 * ```
 *
 * A `SUM` OVER `ai_usage_days` WAS REFUSED, and it is the arrangement a reader
 * reaches for first, because that table already holds every number this one
 * does. Two independent reasons, either of them fatal:
 *
 *  1. THE SUM IS NOT MONOTONIC. `ai_usage_days.account_id` cascades on delete
 *     (`db/schema.ts`), so erasing an account removes the days it spent and
 *     today's total FALLS. A ceiling read off it would refund the instance's
 *     spend to whoever deletes their account, which is a free request tap
 *     rather than a miscount.
 *  2. THE SUM SCANS. That table is keyed `(account_id, day)` with no index on
 *     `day` alone, and this number is wanted on every single request.
 *
 * `ai_instance_days` references nothing, so no cascade can reach it and a
 * day's total only ever goes up.
 *
 * THE INSERT BRANCH IS UNGUARDED, exactly as `reserve`'s is, and for the same
 * reason: it fires only when the day has no row, which means a total of zero.
 * A `limit` of zero reaching here would insert `count = 1`, which is why
 * `config.ts` refuses `AI_INSTANCE_DAILY_LIMIT=0` at boot rather than reading
 * it as "off".
 *
 * THE RELEASE IS FLOORED AT ZERO for the reason the per-account one is: a
 * double release must miscount upward, because a negative counter would be
 * free requests for the whole instance.
 */
export function createDrizzleAiInstanceCeiling(db: Database): AiInstanceCeilingStore {
  return {
    async reserveInstance(input: { day: string; limit: number }): Promise<ReserveResult> {
      const rows = await db
        .insert(aiInstanceDays)
        .values({ day: input.day, count: 1 })
        .onConflictDoUpdate({
          target: aiInstanceDays.day,
          set: { count: sql`${aiInstanceDays.count} + 1` },
          // THE CEILING IS THE PREDICATE, which is what makes this one
          // statement rather than a read and a write with a race between them.
          where: sql`${aiInstanceDays.count} < ${input.limit}`,
        })
        .returning({ count: aiInstanceDays.count });

      const row = rows[0];
      // Zero rows means the `WHERE` was false: the instance is at its ceiling,
      // so it has spent exactly `limit` today.
      if (!row) return { ok: false, used: input.limit, limit: input.limit };
      return { ok: true, used: row.count, limit: input.limit };
    },

    async releaseInstance(input: { day: string }): Promise<void> {
      await db
        .update(aiInstanceDays)
        .set({ count: sql`${aiInstanceDays.count} - 1` })
        .where(and(eq(aiInstanceDays.day, input.day), gt(aiInstanceDays.count, 0)));
    },
  };
}

/**
 * The operator's TOTAL daily bound, which every account shares. `AiQuotaStore`
 * extends this, so the proxy is handed one store and one factory builds both
 * halves.
 *
 * IT IS DECLARED BELOW ITS IMPLEMENTATION because the argument this feature is
 * made of is an argument about a single SQL statement, and it belongs beside
 * that statement rather than one screen away from it. Read
 * `createDrizzleAiInstanceCeiling` above first.
 */
export interface AiInstanceCeilingStore {
  /**
   * Takes one unit of THE WHOLE INSTANCE's daily ceiling for the given UTC
   * day, atomically. Called only on an instance that configured one
   * (`AI_INSTANCE_DAILY_LIMIT`); unset means no ceiling and no statement.
   *
   * A refusal is the ceiling being reached, never an error: it is the same
   * `{ ok: false }` shape `reserve` uses, and the proxy answers it with a
   * `503` rather than a `429` because it is not the caller's fault and not the
   * caller's allowance.
   */
  reserveInstance(input: { day: string; limit: number }): Promise<ReserveResult>;
  /**
   * Gives one instance-wide unit back. Floored at zero, and never throws out of
   * the proxy's hands, see its `releaseQuietly`.
   *
   * IT IS NOT A REFUND MECHANISM FOR A DELETED ACCOUNT. The only callers are
   * the proxy's own release paths, where the request the unit was taken for
   * demonstrably cost the operator nothing (see the spend/release table in
   * `ai/proxy.ts`).
   */
  releaseInstance(input: { day: string }): Promise<void>;
}
