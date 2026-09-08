/**
 * The bounded, zero-filled activity strip behind
 * `GET /v1/admin/accounts/:id/activity` and `GET /v1/admin/activity`, the pure
 * half, so the shape of what an operator sees is decided by a function a test
 * can call without a database or an HTTP client.
 *
 * WHY ZERO-FILL RATHER THAN RETURN THE ROWS. `ai_usage_days` holds a row only
 * for a day an account actually spent something on, so a raw list of rows makes
 * "this person used nothing on Tuesday" and "Tuesday is not in this answer"
 * identical to the reader. That is exactly the distinction the screen exists
 * for: an operator running a study asks whether somebody has stopped, and a
 * gap in a strip is the answer to that question, while a missing key is a
 * question about the API.
 *
 * WHY THE WINDOW IS THE SERVER'S AND NOT THE CALLER'S. It is capped at
 * {@link AI_USAGE_RETENTION_DAYS}, the same number `ai/usage-retention.ts`
 * prunes at, and asking for more gets that. Beyond the cap the sweep has
 * already deleted the rows, so a longer strip would be drawn entirely from the
 * zero-fill above and would show an operator a person who stopped using the app
 * in March, when what actually happened is that the counters expired. A metadata
 * window that cannot say anything true is not one a caller may widen.
 *
 * THE MANY-ACCOUNT ANSWER ZERO-FILLS THE ACCOUNTS TOO, for the same reason it
 * zero-fills the days. The people list draws one strip per row, and an account
 * that has never spent anything has no usage row at all, so an answer that
 * simply left it out would make "this person did nothing" and "this person was
 * not in the answer" identical one level up from where the argument above
 * makes them different. Every account the caller named is in the result, in
 * the order it named them.
 *
 * A CLAMP, WHERE THE PAGING PARAMETERS NEXT DOOR ARE A `400`. Those refuse an
 * out-of-range `limit` because a silently narrowed page is a caller that
 * believes it read the whole list. Here the narrowing IS the contract, the
 * window is reported back in the response, and refusing would only make a
 * caller guess the number this file already publishes.
 */
import { utcDayKey, utcDayKeyDaysBefore } from '../lib/utc-day.js';
import { AI_USAGE_RETENTION_DAYS } from '../ai/usage-retention.js';

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/** One UTC day of an account's AI spend. A count, never a log, see `db/schema.ts`. */
export interface ActivityDay {
  /** The UTC calendar day, `YYYY-MM-DD`. */
  day: string;
  /** AI requests spent that day. `0` for a day with no row, which is the point of the zero-fill. */
  count: number;
}

/** The window an answer covers, reported back so a caller never has to assume the cap. */
export interface ActivityWindow {
  /** How many days it spans, counting today. Never more than {@link AI_USAGE_RETENTION_DAYS}. */
  days: number;
  /** The oldest day in the window, inclusive. */
  fromDay: string;
  /** The newest day in the window, inclusive, which is always today in UTC. */
  toDay: string;
}

/** Narrows a requested window to what the retention window can honestly answer. See the module header. */
export function clampActivityWindowDays(days: number): number {
  return Math.min(days, AI_USAGE_RETENTION_DAYS);
}

/**
 * The window a request asks for, capped.
 *
 * `days - 1`, because the window INCLUDES today: ninety days is today and the
 * eighty-nine before it, which is the same arithmetic
 * `aiUsageRetentionCutoffDay` in `ai/usage-retention.ts` keeps rows for.
 */
export function activityWindow(input: { now: Date; days: number }): ActivityWindow {
  const days = clampActivityWindowDays(input.days);
  return { days, fromDay: utcDayKeyDaysBefore(input.now, days - 1), toDay: utcDayKey(input.now) };
}

/**
 * Every day in the window, in order, with `0` for the days that have no row.
 *
 * The loop is bounded by `window.days`, which is itself capped, so the length
 * of the answer is decided before the first iteration and cannot be driven by
 * what came back from the database.
 */
export function zeroFillActivityDays(input: {
  window: ActivityWindow;
  counted: readonly ActivityDay[];
}): ActivityDay[] {
  const counts = new Map(input.counted.map((row) => [row.day, row.count]));
  // A date-only string is UTC by specification, so this needs no timezone
  // argument and cannot shift the strip by a day in a westward zone.
  const start = Date.parse(`${input.window.fromDay}T00:00:00.000Z`);

  const strip: ActivityDay[] = [];
  for (let index = 0; index < input.window.days; index += 1) {
    const day = utcDayKey(new Date(start + index * MS_PER_DAY));
    strip.push({ day, count: counts.get(day) ?? 0 });
  }
  return strip;
}

/**
 * One flat usage row for one account on one day, as a store returns them: only
 * the pairs that HAVE a row, never a strip. See `admin/admin-store.ts`.
 */
export interface AccountActivityCount extends ActivityDay {
  accountId: number;
}

/** One account's strip, zero filled across the whole window. */
export interface AccountActivityStrip {
  accountId: number;
  days: ActivityDay[];
}

/**
 * A strip per account, in the order the accounts were named, each one zero
 * filled across the same window.
 *
 * THE ORDER IS THE CALLER'S, NOT THE DATABASE'S. The caller is paging the
 * accounts list, and the point of this function is that strip `n` belongs to
 * row `n` of that page. Sorting here, or letting the row order decide, would
 * hand a screen a strip to draw beside the wrong person.
 *
 * A ROW FOR AN UNNAMED ACCOUNT IS DROPPED, and a row outside the window is
 * dropped by {@link zeroFillActivityDays}, which walks the window rather than
 * the rows. So the size of the answer is decided by the two capped inputs
 * before the first row is read.
 */
export function zeroFillActivityStrips(input: {
  window: ActivityWindow;
  accountIds: readonly number[];
  counted: readonly AccountActivityCount[];
}): AccountActivityStrip[] {
  const perAccount = new Map<number, ActivityDay[]>();
  for (const row of input.counted) {
    const existing = perAccount.get(row.accountId) ?? [];
    existing.push({ day: row.day, count: row.count });
    perAccount.set(row.accountId, existing);
  }

  return input.accountIds.map((accountId) => ({
    accountId,
    days: zeroFillActivityDays({ window: input.window, counted: perAccount.get(accountId) ?? [] }),
  }));
}
