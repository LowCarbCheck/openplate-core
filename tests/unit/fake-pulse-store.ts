/**
 * The four pulse tables, in memory.
 *
 * IT IS NOT A SECOND IMPLEMENTATION OF POSTGRES'S RULES, and the distinction
 * matters here more than for the other fakes in this directory: the one
 * statement upserts and the conflict that makes an idempotency claim atomic
 * belong to the database, and `tests/integration/pulse-today.test.ts` proves
 * them against a real one. What this holds is the arithmetic the ROUTES depend
 * on, so a unit test can post a meal and read the sum back without a database
 * and without reimplementing a race it cannot have.
 *
 * EVERY WRITE IS RECORDED, in order, so a test can assert what the route passed
 * down rather than only what came back. That is what catches a handler that
 * forwarded a client's exact 1237 instead of the rounded 1250.
 */
import type { PulseClaim, PulsePruneCounts, PulseStore, PulseTotals } from '../../src/pulse/pulse-store.js';

export interface RecordedMeal {
  day: string;
  accountId: number;
  kcal: number;
  protein: number;
}

export interface FakePulseStore extends PulseStore {
  /** Every meal delta the route handed down, already rounded by the handler. */
  meals: RecordedMeal[];
  /** Every photo delta, as the day and account it was claimed for. */
  photos: { day: string; accountId: number }[];
  /** The live presence rows, account id to expiry, so a test can count them without a query. */
  presence: Map<number, Date>;
  /** Every idempotency key claimed, in order. */
  claimedKeys: string[];
}

export function createFakePulseStore(): FakePulseStore {
  const meals: RecordedMeal[] = [];
  const photos: { day: string; accountId: number }[] = [];
  const presence = new Map<number, Date>();
  const claimedKeys: string[] = [];
  const keys = new Map<string, Date>();

  function contributorsOn(day: string): number {
    const accountIds = new Set<number>();
    for (const meal of meals) {
      if (meal.day === day) accountIds.add(meal.accountId);
    }
    for (const photo of photos) {
      if (photo.day === day) accountIds.add(photo.accountId);
    }
    return accountIds.size;
  }

  return {
    meals,
    photos,
    presence,
    claimedKeys,

    async claim(input: { key: string; accountId: number; now: Date }): Promise<PulseClaim> {
      if (keys.has(input.key)) return 'duplicate';
      keys.set(input.key, input.now);
      claimedKeys.push(input.key);
      return 'claimed';
    },

    async release(input: { key: string }): Promise<void> {
      keys.delete(input.key);
      const at = claimedKeys.indexOf(input.key);
      if (at >= 0) claimedKeys.splice(at, 1);
    },

    async addMeal(input: RecordedMeal): Promise<void> {
      meals.push(input);
    },

    async addPhoto(input: { day: string; accountId: number }): Promise<void> {
      photos.push(input);
    },

    async markFasting(input: { accountId: number; expiresAt: Date }): Promise<void> {
      // AN UPSERT, which is the one behaviour of this table a route test cares
      // about: two heartbeats leave one row with the later expiry.
      presence.set(input.accountId, input.expiresAt);
    },

    async totals(input: { day: string; now: Date }): Promise<PulseTotals> {
      const dayMeals = meals.filter((meal) => meal.day === input.day);
      let fastingNow = 0;
      for (const expiresAt of presence.values()) {
        if (expiresAt.getTime() > input.now.getTime()) fastingNow += 1;
      }
      return {
        day: input.day,
        meals: dayMeals.length,
        photos: photos.filter((photo) => photo.day === input.day).length,
        kcal: dayMeals.reduce((total, meal) => total + meal.kcal, 0),
        protein: dayMeals.reduce((total, meal) => total + meal.protein, 0),
        contributors: contributorsOn(input.day),
        fastingNow,
      };
    },

    async prune(input: { beforeDay: string; now: Date; keysBefore: Date }): Promise<PulsePruneCounts> {
      const days = new Set(meals.filter((row) => row.day < input.beforeDay).map((row) => row.day));
      for (const photo of photos) {
        if (photo.day < input.beforeDay) days.add(photo.day);
      }

      const staleContributors = new Set<string>();
      for (const stale of meals.filter((row) => row.day < input.beforeDay)) {
        staleContributors.add(`${stale.day}:${stale.accountId}`);
      }
      for (const stale of photos.filter((row) => row.day < input.beforeDay)) {
        staleContributors.add(`${stale.day}:${stale.accountId}`);
      }

      const keptMeals = meals.filter((row) => row.day >= input.beforeDay);
      meals.splice(0, meals.length, ...keptMeals);
      const keptPhotos = photos.filter((row) => row.day >= input.beforeDay);
      photos.splice(0, photos.length, ...keptPhotos);

      let expiredPresence = 0;
      for (const [accountId, expiresAt] of presence) {
        if (expiresAt.getTime() < input.now.getTime()) {
          presence.delete(accountId);
          expiredPresence += 1;
        }
      }

      let expiredKeys = 0;
      for (const [key, at] of keys) {
        if (at.getTime() < input.keysBefore.getTime()) {
          keys.delete(key);
          expiredKeys += 1;
        }
      }

      return {
        days: days.size,
        contributors: staleContributors.size,
        presence: expiredPresence,
        idempotencyKeys: expiredKeys,
      };
    },
  };
}
