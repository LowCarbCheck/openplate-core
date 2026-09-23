/**
 * How long a statutory declaration is kept (the owner's decision, 2026-09-23).
 *
 * THE RULE, IN ONE SENTENCE: a row is deleted at the end of the third calendar
 * year after the year it was received, in Europe/Berlin time. Received
 * 2026-09-21, it is kept through 2029-12-31 and deleted from 2030-01-01 00:00
 * in Berlin. That is the privacy policy's sentence, word for word, and the
 * three years are the ordinary German limitation period for a claim about the
 * contract the declaration ended.
 *
 * AN ACCOUNT DELETION DOES NOT SHORTEN IT. The row's `account_id` is set to
 * `NULL` when the account goes, and the row stays until this rule removes it:
 * the declaration is evidence of what a person declared, not account data.
 *
 * PURE. The sweep that applies it is the hourly usage sweep
 * (`ai/usage-retention.ts`), which runs on every instance.
 */

/** Calendar years kept after the year of receipt. */
export const LEGAL_DECLARATION_RETENTION_YEARS = 3;

/** The time zone the calendar year is counted in: the seller's. */
const RETENTION_TIME_ZONE = 'Europe/Berlin';

const MS_PER_HOUR = 60 * 60 * 1000;

/** The calendar year `instant` falls in, in Berlin. */
function berlinYear(instant: Date): number {
  const year = new Intl.DateTimeFormat('en', { timeZone: RETENTION_TIME_ZONE, year: 'numeric' }).format(instant);
  return Number(year);
}

/**
 * The first instant of `year` in Berlin. January is always standard time
 * there (UTC+1, no summer time), so midnight on 1 January is 23:00 UTC on
 * 31 December of the year before.
 */
function startOfBerlinYear(year: number): Date {
  return new Date(Date.UTC(year, 0, 1) - MS_PER_HOUR);
}

/**
 * Every declaration received strictly BEFORE this instant is past its period
 * at `now`. A row received in Berlin year Y is deleted from the start of year
 * Y + 4, so at `now` in year N the rows to delete are those of years up to
 * N - 4, which is "received before the start of year N - 3".
 */
export function legalDeclarationsCutoff(now: Date): Date {
  return startOfBerlinYear(berlinYear(now) - LEGAL_DECLARATION_RETENTION_YEARS);
}
