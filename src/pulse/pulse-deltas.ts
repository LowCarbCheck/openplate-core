/**
 * The grid a meal delta lands on, and the only arithmetic the pulse does.
 *
 * WHY THE SERVER ROUNDS WHAT IT WAS ALREADY SENT ROUNDED. The device rounds
 * before it sends, because a person should be able to read the app's source and
 * see that an exact figure never leaves their phone. This module rounds again
 * because the server must not depend on that: a client with a bug, an older
 * build, or somebody calling the route by hand would otherwise put an exact
 * 1237 into an instance wide sum, and in a day with two contributors an exact
 * figure is close to one person's dinner. The grid is the privacy property, and
 * a property that only holds when every client behaves is not one.
 *
 * THE CLAMP IS A BOUND, NOT A VALIDATION. A value outside the range is pulled
 * to the edge rather than refused, because the alternative is a route that
 * answers 400 to a person who genuinely ate a great deal, and a refusal teaches
 * a caller exactly where the edge is. A body that is not a finite number at all
 * IS refused, by the route.
 *
 * Pure and total, so the rounding is tested without a server and without a
 * database.
 */

/** Calories land on multiples of this. ADR-0007 states the number, and PROTOCOL.md §5.23 repeats it. */
export const PULSE_KCAL_STEP = 50;

/** Protein in grams lands on multiples of this. */
export const PULSE_PROTEIN_STEP = 5;

/**
 * The largest calorie figure one meal may add.
 *
 * A CEILING ON ONE DELTA, not on a day. It exists so a single caller cannot
 * move an instance wide sum by an amount no plate could account for, and 5000
 * is far above any real meal while staying a number an operator can recognise
 * in a total.
 */
export const PULSE_MAX_KCAL = 5000;

/** The same bound for protein, for the same reason. */
export const PULSE_MAX_PROTEIN = 500;

/** Rounds to the nearest step and clamps into `0 .. max`. Total: every finite input has an answer. */
function toGrid(value: number, step: number, max: number): number {
  const rounded = Math.round(value / step) * step;
  // `<= 0` rather than `< 0`, so a small negative figure returns a literal 0
  // rather than the negative zero `Math.round` produces for it. A -0 in a sum
  // is harmless and a -0 in a response body is a value a reader has to explain.
  if (rounded <= 0) return 0;
  if (rounded > max) return max;
  return rounded;
}

/** 1234 becomes 1250, 24 becomes 0, and 9999 becomes 5000. */
export function roundPulseKcal(value: number): number {
  return toGrid(value, PULSE_KCAL_STEP, PULSE_MAX_KCAL);
}

/** 33 becomes 35, and a negative figure becomes 0. */
export function roundPulseProtein(value: number): number {
  return toGrid(value, PULSE_PROTEIN_STEP, PULSE_MAX_PROTEIN);
}

/**
 * The shape of an `Idempotency-Key`, checked rather than merely bounded.
 *
 * A UUID, because the header has one job: to be the same string on a retry and
 * a different one on a new write. A client that sends `1` satisfies a length
 * bound and then collides with every other client on the instance, which would
 * turn a shared key into a silently dropped meal. Version and variant nibbles
 * are checked too, so a caller cannot pass a hand written string of the right
 * length.
 */
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function isPulseIdempotencyKey(value: string | undefined): value is string {
  return value !== undefined && UUID_PATTERN.test(value);
}
