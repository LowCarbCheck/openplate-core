/**
 * The scan trial, as data and pure rules (M253).
 *
 * WHAT IT IS. An account may carry a number of free AI scans with no end date
 * (`accounts.trial_scans`), and the AI proxy counts one scan per AI action the
 * person started (`ai/proxy.ts`, `ai/quota-store.ts`). After the last one the
 * proxy answers `403 trial-scans-spent`, and a paid date lifts the gate.
 *
 * WHY A COUNT AND NOT A DATE. The owner decided on 2026-09-23 that ten scans
 * replace the three day trial: a window punishes the person who signs up on a
 * Friday and scans on Monday, and ten scans measure use rather than the
 * calendar.
 *
 * NOTHING HERE READS A CLOCK, A DATABASE OR AN ENVIRONMENT.
 */
import type { TrialScansView } from '../protocol.js';

/**
 * What an instance hands a new account through the trial doors: `TRIAL_SCANS`
 * free scans with no end date, at `TRIAL_DAILY_AI_LIMIT` requests a day. Both
 * or neither, see `config.ts`.
 */
export interface TrialPolicy {
  scans: number;
  dailyAiLimit: number;
}

/** The largest `TRIAL_SCANS`, and the largest `trialScans` an operator may set on one account. */
export const MAX_TRIAL_SCANS = 100;

/** How long one intake id may ride on the scan it claimed. See {@link INTAKE_MAX_REQUESTS}. */
export const INTAKE_REUSE_WINDOW_MS = 30 * 60 * 1000;

/**
 * How many upstream requests one intake id may make on one scan: the first
 * try plus the app's two retries (one without `response_format`, one after a
 * stale bearer). A fourth request on the same id is a new person action, or a
 * client that reuses ids, and it costs a new scan.
 */
export const INTAKE_MAX_REQUESTS = 3;

/** How long an intake row is kept at all. The hourly usage sweep deletes older ones. */
export const INTAKE_RETENTION_MS = 24 * 60 * 60 * 1000;

/**
 * The shape of an `X-Intake-Id`: 16 to 64 characters of URL-safe base64 or
 * hex, so a UUID without its dashes fits and a UUID with them fits too.
 */
export const INTAKE_ID_PATTERN = /^[A-Za-z0-9_-]{16,64}$/;

/** The response header that carries what is left after this request. */
export const TRIAL_SCANS_LEFT_HEADER = 'X-Trial-Scans-Left';

/** The refusal after the last scan. A third code, beside `ai-not-allowed` and `allowance-expired`, see PROTOCOL.md §5.19. */
export const TRIAL_SCANS_SPENT = 'trial-scans-spent';

/** The refusal for a malformed `X-Intake-Id`, before any row is written. */
export const INTAKE_ID_INVALID = 'intake-id-invalid';

/**
 * The account view's `trialScans`, or `null` for an account with no scan
 * trial. `left` is never negative, so an operator lowering `granted` below
 * what was used reads as none left, which is the honest answer.
 */
export function trialScansView(input: { granted: number | null; used: number }): TrialScansView | null {
  if (input.granted === null) return null;
  return { granted: input.granted, left: Math.max(0, input.granted - input.used) };
}

/**
 * Whether the scan gate applies to this account right now.
 *
 * A DATE LIFTS IT. An allowance date in the future is a paid or granted
 * window, and the proxy's earlier step already refused a date in the past, so
 * "no date" is the only standing in which the count decides. An account with
 * no trial is a standing grant, exactly as before M253.
 */
export function isScanGated(input: { trialScans: number | null; allowanceExpiresAt: Date | null }): boolean {
  return input.allowanceExpiresAt === null && input.trialScans !== null;
}

/**
 * Whether this account is a scan trial nobody has paid for yet (M253/11).
 *
 * THE SAME DATE RULE AS {@link isScanGated}, READ FOR A DIFFERENT QUESTION.
 * The biller extends `allowanceExpiresAt` on payment and never touches
 * `trialScans`, so a paying account may still carry its trial. What tells the
 * two apart is the date: one in the future is a paid or granted window. The
 * proxy never needs the past-date case, because it refused that request one
 * step earlier; this rule does, and a date that has passed is no plan.
 *
 * AN ACCOUNT WITH NO SCAN TRIAL IS NEVER AN UNPAID TRIAL. An operator's
 * standing grant and every account from before M253 read `false` here, which
 * is what keeps them unaffected.
 */
export function isUnpaidTrial(input: {
  trialScans: number | null;
  allowanceExpiresAt: Date | null;
  now: Date;
}): boolean {
  if (input.trialScans === null) return false;
  if (input.allowanceExpiresAt === null) return true;
  return input.allowanceExpiresAt.getTime() <= input.now.getTime();
}
