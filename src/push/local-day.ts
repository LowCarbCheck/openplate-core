/**
 * The one place this service does clock arithmetic in somebody else's zone.
 *
 * EVERY OTHER DAY BOUNDARY HERE IS UTC (`lib/utc-day.ts`), and that is right
 * for a quota: a quota needs to be predictable rather than local, and a
 * configured zone would have to be agreed with the client and re-agreed for a
 * person travelling. A morning catch-up is the opposite kind of question. "Has
 * 08:00 passed where this phone is" has exactly one correct answer and it is
 * not in UTC, so the subscription carries its own IANA zone and this module
 * reads it.
 *
 * `Intl.DateTimeFormat` RATHER THAN ARITHMETIC ON AN OFFSET. An offset is not a
 * property of a zone, it is a property of a zone at an instant: Europe/Berlin
 * is +01:00 in January and +02:00 in July, and a local day across a changeover
 * is 23 or 25 hours long. The ICU data Node ships is the only thing that knows
 * that, and `tests/unit/push-schedule-dst.test.ts` walks both Berlin
 * changeovers minute by minute rather than reasoning about them.
 *
 * Pure throughout: every function takes the instant, and none of them reads a
 * clock.
 */

/** `YYYY-MM-DD`, which is what `en-CA` formats a date as and what the columns store. */
const DAY_LOCALE = 'en-CA';

/** One local calendar day, in milliseconds, for the day COUNTING below. See `localDaysBetween`. */
const DAY_MS = 24 * 60 * 60 * 1000;

/** The fields one `Intl` read has to produce for both answers below. */
interface LocalClock {
  day: string;
  minuteOfDay: number;
}

/**
 * Reads a zone's calendar day and minute of day in ONE format pass.
 *
 * One pass rather than two, because a day and a minute read separately can
 * straddle midnight: the first call can land at 23:59:59.999 and the second at
 * 00:00:00.000 of the next day, which is a catch-up marked sent for a day it
 * was not sent on. A single `formatToParts` cannot disagree with itself.
 */
export function localClock(instant: Date, timeZone: string): LocalClock {
  const parts = new Intl.DateTimeFormat(DAY_LOCALE, {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).formatToParts(instant);

  const fields = new Map<string, string>();
  for (const part of parts) fields.set(part.type, part.value);

  const year = fields.get('year') ?? '1970';
  const month = fields.get('month') ?? '01';
  const day = fields.get('day') ?? '01';
  // `hour12: false` gives 00 to 23 on every ICU Node ships, but the 24 form has
  // existed in the wild for midnight, and it means the same minute of the same
  // day the rest of the parts already named.
  const hour = Number(fields.get('hour') ?? '0') % 24;
  const minute = Number(fields.get('minute') ?? '0');

  return { day: `${year}-${month}-${day}`, minuteOfDay: hour * 60 + minute };
}

/** The local calendar day an instant falls in, `YYYY-MM-DD`. */
export function localDayKey(instant: Date, timeZone: string): string {
  return localClock(instant, timeZone).day;
}

/** Minutes since local midnight, 0 to 1439. What a `catch_up_minute` is compared against. */
export function localMinuteOfDay(instant: Date, timeZone: string): number {
  return localClock(instant, timeZone).minuteOfDay;
}

/**
 * Whether a string is a zone this runtime knows.
 *
 * A ROUTE CHECKS THIS AT WRITE TIME, because the failure it prevents is silent:
 * an unknown zone makes `Intl.DateTimeFormat` throw inside the tick, which
 * would turn one bad registration into a sweep that never completes for
 * anybody. Refusing the write costs one 400 and keeps the tick total.
 */
export function isTimeZone(value: string): boolean {
  try {
    // The CONSTRUCTOR is the check: ICU throws a `RangeError` for a zone it does
    // not know. `resolvedOptions` is read so this is a question rather than a
    // statement with a side effect, and it answers the canonical name ICU
    // settled on, which is never empty for a zone it accepted.
    return new Intl.DateTimeFormat(DAY_LOCALE, { timeZone: value }).resolvedOptions().timeZone !== '';
  } catch {
    return false;
  }
}

/**
 * Whole calendar days from `from` to `to`, both `YYYY-MM-DD`, or `null` when
 * either is not a day key.
 *
 * BOTH KEYS ARE READ AS UTC MIDNIGHT, which is exactly right for counting
 * CALENDAR days and would be exactly wrong for counting elapsed time. The two
 * keys already came out of the same zone (they are `last_seen_day` and today
 * in that subscription's zone), so the question is "how many pages of the
 * calendar", and a changeover between them must not make the answer 6.96.
 */
export function localDaysBetween(input: { from: string; to: string }): number | null {
  const from = Date.parse(`${input.from}T00:00:00Z`);
  const to = Date.parse(`${input.to}T00:00:00Z`);
  if (Number.isNaN(from) || Number.isNaN(to)) return null;
  return Math.round((to - from) / DAY_MS);
}
