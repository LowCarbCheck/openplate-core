/**
 * The four tables of the community pulse, behind one port.
 *
 * ONE STORE RATHER THAN FOUR, because every method here writes or reads a table
 * that only this feature touches, and splitting them would leave the day sum
 * and the contributor row beside it in two modules with an invariant between
 * them. That invariant is the whole of `addMeal`: a delta increments the day
 * and claims a contributor row in the same call, or the `contributors` number
 * the client draws a floor from disagrees with the sums beside it.
 *
 * THE UPSERTS ARE ONE STATEMENT EACH, for the reason `ai/quota-store.ts` gives
 * at length: a read followed by a write has a window that a client retrying on
 * error is precisely the client to land in. There is no `WHERE` on any of them
 * because nothing here is a limit; the limits are at the edge, in the rate
 * limiter and in the idempotency claim.
 *
 * NOTHING IN THIS FILE LOGS, and nothing in it returns an account id to a
 * caller. `totals` answers counts, `claim` answers whether a key was new, and
 * the account id travels in and never out. See ADR-0007 on why the routes above
 * log a status code and a byte count only.
 */
import { count, eq, gt, lt, sql } from 'drizzle-orm';
import type { Database } from '../db/client.js';
import { pulseDayContributors, pulseDays, pulseIdempotency, pulsePresence } from '../db/schema.js';

/** Everything `GET /v1/pulse/today` reports, and everything the admin stats repeat. */
export interface PulseTotals {
  /** The UTC day these sums belong to, `YYYY-MM-DD`. */
  day: string;
  meals: number;
  photos: number;
  kcal: number;
  protein: number;
  /** Distinct accounts that sent a meal or a photo delta on this day. */
  contributors: number;
  /** Accounts with an unexpired presence row right now. */
  fastingNow: number;
}

/**
 * Whether a write may proceed.
 *
 * A VALUE RATHER THAN AN EXCEPTION, because a duplicate is not a failure: it is
 * a retry working exactly as the client was told it would, and the route
 * answers it 200. An exception here would make the ordinary case the error
 * path.
 */
export type PulseClaim = 'claimed' | 'duplicate';

/** What one prune removed, per table, so the sweep can log a number rather than a guess. */
export interface PulsePruneCounts {
  days: number;
  contributors: number;
  presence: number;
  idempotencyKeys: number;
}

export interface PulseStore {
  /**
   * Records an `Idempotency-Key` and says whether it was new.
   *
   * The key is the primary key, so this is one INSERT whose conflict IS the
   * duplicate answer. A read then write would have a window exactly where a
   * retry lands.
   */
  claim(input: { key: string; accountId: number; now: Date }): Promise<PulseClaim>;
  /**
   * Forgets a key that was claimed for a write that did not happen.
   *
   * IT EXISTS FOR THE RATE LIMITER, and for nothing else. A limit postpones a
   * write; a key left claimed on a refused request would turn the client's
   * retry into a `200 {"duplicate": true}` and swallow the meal. Deleting by
   * key alone is safe because the key was claimed microseconds earlier by this
   * same request.
   */
  release(input: { key: string }): Promise<void>;
  /** One meal: the day's counters go up, and the account joins the day's contributors. */
  addMeal(input: { day: string; accountId: number; kcal: number; protein: number }): Promise<void>;
  /** One parsed photograph. Same contributor claim, no figures. */
  addPhoto(input: { day: string; accountId: number }): Promise<void>;
  /** One heartbeat: an upsert on the account id, so two heartbeats leave one row with the later expiry. */
  markFasting(input: { accountId: number; expiresAt: Date }): Promise<void>;
  /** Today's sums, the distinct contributor count, and the number of unexpired presence rows. */
  totals(input: { day: string; now: Date }): Promise<PulseTotals>;
  /**
   * Deletes day rows and contributor rows before `beforeDay`, presence rows at
   * or past `now`, and idempotency keys created before `keysBefore`.
   *
   * IT LIVES ON THE STORE THAT WRITES THE TABLES, exactly as
   * `AiQuotaStore.purgeUsageBefore` does, so no second module holds these rows.
   * The predicates are instants and a day, never cursors, so a second run in
   * the same hour is a no-op rather than a partial repeat.
   */
  prune(input: { beforeDay: string; now: Date; keysBefore: Date }): Promise<PulsePruneCounts>;
}

export function createDrizzlePulseStore(db: Database): PulseStore {
  /**
   * The account joins the day's contributors, or was already there.
   *
   * Shared by both delta paths rather than written twice: a day sum that moved
   * without a contributor row would put the client's floor of three on a
   * different number from the sums it guards.
   */
  async function claimContributor(input: { day: string; accountId: number }): Promise<void> {
    await db
      .insert(pulseDayContributors)
      .values({ day: input.day, accountId: input.accountId })
      .onConflictDoNothing({ target: [pulseDayContributors.day, pulseDayContributors.accountId] });
  }

  return {
    async claim(input: { key: string; accountId: number; now: Date }): Promise<PulseClaim> {
      const rows = await db
        .insert(pulseIdempotency)
        .values({ key: input.key, accountId: input.accountId, createdAt: input.now })
        .onConflictDoNothing({ target: pulseIdempotency.key })
        .returning({ key: pulseIdempotency.key });
      // Zero rows means the key was already here, whoever sent it first. The
      // account is deliberately NOT part of the predicate: a uuid collision
      // across two accounts is not a case worth a second index, and the
      // consequence of one is a dropped delta rather than a leak.
      return rows.length === 0 ? 'duplicate' : 'claimed';
    },

    async release(input: { key: string }): Promise<void> {
      await db.delete(pulseIdempotency).where(eq(pulseIdempotency.key, input.key));
    },

    async addMeal(input: { day: string; accountId: number; kcal: number; protein: number }): Promise<void> {
      await db
        .insert(pulseDays)
        .values({ day: input.day, meals: 1, photos: 0, kcal: input.kcal, protein: input.protein })
        .onConflictDoUpdate({
          target: pulseDays.day,
          set: {
            meals: sql`${pulseDays.meals} + 1`,
            kcal: sql`${pulseDays.kcal} + ${input.kcal}`,
            protein: sql`${pulseDays.protein} + ${input.protein}`,
          },
        });
      await claimContributor({ day: input.day, accountId: input.accountId });
    },

    async addPhoto(input: { day: string; accountId: number }): Promise<void> {
      await db
        .insert(pulseDays)
        .values({ day: input.day, meals: 0, photos: 1, kcal: 0, protein: 0 })
        .onConflictDoUpdate({ target: pulseDays.day, set: { photos: sql`${pulseDays.photos} + 1` } });
      await claimContributor({ day: input.day, accountId: input.accountId });
    },

    async markFasting(input: { accountId: number; expiresAt: Date }): Promise<void> {
      await db
        .insert(pulsePresence)
        .values({ accountId: input.accountId, expiresAt: input.expiresAt })
        // OVERWRITTEN, NEVER APPENDED. This is what keeps the table from
        // becoming a record of when somebody fasted.
        .onConflictDoUpdate({ target: pulsePresence.accountId, set: { expiresAt: input.expiresAt } });
    },

    async totals(input: { day: string; now: Date }): Promise<PulseTotals> {
      const [day] = await db.select().from(pulseDays).where(eq(pulseDays.day, input.day));
      const [contributors] = await db
        .select({ total: count() })
        .from(pulseDayContributors)
        .where(eq(pulseDayContributors.day, input.day));
      // STRICTLY AFTER, so a row whose expiry is exactly now has already
      // stopped counting. The prune deletes it later; the reader never waits
      // for the prune.
      const [fasting] = await db
        .select({ total: count() })
        .from(pulsePresence)
        .where(gt(pulsePresence.expiresAt, input.now));

      return {
        day: input.day,
        meals: day?.meals ?? 0,
        photos: day?.photos ?? 0,
        kcal: day?.kcal ?? 0,
        protein: day?.protein ?? 0,
        contributors: contributors?.total ?? 0,
        fastingNow: fasting?.total ?? 0,
      };
    },

    async prune(input: { beforeDay: string; now: Date; keysBefore: Date }): Promise<PulsePruneCounts> {
      // CONTRIBUTORS FIRST, so a crash between the two statements leaves rows
      // whose day row is still here rather than orphans nothing reads.
      const contributors = await db
        .delete(pulseDayContributors)
        .where(lt(pulseDayContributors.day, input.beforeDay))
        .returning({ accountId: pulseDayContributors.accountId });
      const days = await db
        .delete(pulseDays)
        .where(lt(pulseDays.day, input.beforeDay))
        .returning({ day: pulseDays.day });
      const presence = await db
        .delete(pulsePresence)
        .where(lt(pulsePresence.expiresAt, input.now))
        .returning({ accountId: pulsePresence.accountId });
      const keys = await db
        .delete(pulseIdempotency)
        .where(lt(pulseIdempotency.createdAt, input.keysBefore))
        .returning({ key: pulseIdempotency.key });

      return {
        days: days.length,
        contributors: contributors.length,
        presence: presence.length,
        idempotencyKeys: keys.length,
      };
    },
  };
}
