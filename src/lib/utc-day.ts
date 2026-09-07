/**
 * The UTC calendar day an instant falls in, as `YYYY-MM-DD`.
 *
 * ONE FUNCTION, ONE RULE, ONE PLACE. The AI quota resets at UTC midnight
 * (`accounts.daily_ai_limit` against `ai_usage_days.day`), and the client
 * renders "used today" from the same boundary. Two implementations of that
 * arithmetic would disagree for one hour a day somewhere in the world, and the
 * disagreement would look like a quota that reset twice.
 *
 * UTC RATHER THAN THE OPERATOR'S ZONE, deliberately: a zone would have to be
 * configured, agreed with the client, and re-agreed for a person travelling.
 * A quota boundary needs to be predictable, not local.
 *
 * Pure — the instant is injected, never read from the clock.
 */

/** `YYYY-MM-DD` in UTC. `toISOString` is the shortest total implementation and never depends on a locale. */
export function utcDayKey(instant: Date): string {
  return instant.toISOString().slice(0, 10);
}

/**
 * The UTC day `days` calendar days before `instant`, as `YYYY-MM-DD`.
 *
 * HERE RATHER THAN IN EITHER CALLER, because both callers are the same window
 * seen from two ends: `ai/usage-retention.ts` deletes everything before the
 * day this returns, and `admin/account-activity.ts` starts its strip at it. A
 * second implementation of the subtraction would let the day the operator can
 * see and the day the sweep keeps disagree by one, which reads as a person who
 * stopped using the app on the oldest day of the strip.
 *
 * Pure, and UTC throughout, for the reasons in the module header.
 */
export function utcDayKeyDaysBefore(instant: Date, days: number): string {
  return utcDayKey(new Date(instant.getTime() - days * 24 * 60 * 60 * 1000));
}
