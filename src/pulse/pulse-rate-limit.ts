/**
 * A per account, per route interval limit for the pulse writes.
 *
 * WHY NOT `ai/rate-limit.ts`. That limiter is a sliding window of N requests
 * per sixty seconds, and its window is a module constant. The pulse needs three
 * different windows, one of them ten minutes, and it needs exactly one request
 * per window rather than N. Widening the AI limiter to take both would make the
 * thing that guards the operator's provider bill configurable by a feature that
 * guards a counter, so this is its own small module and borrows the argument
 * rather than the code.
 *
 * ONE WRITE PER WINDOW, WHICH IS THE HONEST SHAPE OF THE THING. A person eats a
 * meal every few hours and takes a photograph of it once. A caller sending more
 * than one a minute is a loop, and a loop is what the counter has to be
 * protected from: an inflated instance wide number is worse than none, because
 * the reader cannot tell.
 *
 * KEYED ON THE RESOLVED ACCOUNT, which is why it is consulted inside the
 * handler rather than mounted in front of it. Keying on an IP would put a
 * household behind one NAT into one bucket and let an unauthenticated caller
 * spend a real account's allowance.
 *
 * IN MEMORY AND SINGLE PROCESS, deliberately, for the reason `lib/throttle.ts`
 * gives: one container, no Redis in a self-hoster's compose file. The durable
 * guard, the one a restart cannot clear, is the idempotency key.
 */

/** A meal delta: one per minute per account. */
export const PULSE_MEAL_INTERVAL_MS = 60_000;

/** A photo delta: one per minute per account. */
export const PULSE_PHOTO_INTERVAL_MS = 60_000;

/** A fasting heartbeat: one per ten minutes per account, which is well inside the 30 minute presence window. */
export const PULSE_FASTING_INTERVAL_MS = 10 * 60_000;

/**
 * How often the whole map is swept for accounts that have gone quiet.
 * Amortised across calls rather than run on a timer, exactly as
 * `ai/rate-limit.ts` does it: a `setInterval` would keep a handle alive, need
 * unref-ing, and make the module untestable without a real clock.
 */
const SWEEP_INTERVAL_MS = PULSE_FASTING_INTERVAL_MS;

export interface CreatePulseRateLimitOptions {
  /** The shortest gap allowed between two accepted writes on this route, per account. */
  intervalMs: number;
  /** Injectable clock so tests do not sleep. Defaults to `Date.now`. */
  now?: () => number;
}

/** Allowed, or refused with the seconds a caller should wait. A value rather than a throw: a refusal is an answer. */
export type PulseRateDecision = { allowed: true } | { allowed: false; retryAfterSeconds: number };

/**
 * CHECK AND RECORD ARE SEPARATE, and that is the whole reason this is an object
 * rather than a middleware.
 *
 * The route has to answer a replayed `Idempotency-Key` with a `200
 * {"duplicate": true}` BEFORE it considers the limit, or a client retrying a
 * write it already made would be told to wait instead of being told it was
 * already done. So the check happens inside the handler, after the claim, and
 * the slot is recorded only once a delta has actually been written. A
 * middleware cannot express that order, and one that recorded on every request
 * would spend a person's minute on a request that wrote nothing.
 */
export interface PulseRateLimit {
  /** Whether this account may write now. Records nothing. */
  check(input: { accountId: number; now: number }): PulseRateDecision;
  /** Marks the write as made, which starts the account's next window. */
  record(input: { accountId: number; now: number }): void;
}

/** Seconds until the next write is allowed. Floored at 1: a `Retry-After: 0` invites a retry guaranteed to fail. */
function secondsUntilAllowed(input: { lastMs: number; currentMs: number; intervalMs: number }): number {
  return Math.max(1, Math.ceil((input.lastMs + input.intervalMs - input.currentMs) / 1000));
}

export function createPulseRateLimit(options: CreatePulseRateLimitOptions): PulseRateLimit {
  const { intervalMs } = options;
  const nowMs = options.now ?? ((): number => Date.now());
  /** account id -> the instant of its last accepted write on this route. */
  const lastWriteMs = new Map<number, number>();
  let lastSweepMs = nowMs();

  /**
   * Bounded memory. Without this, one entry per account that ever wrote
   * survives for the life of the process: small per entry, unbounded in
   * aggregate, and invisible in testing because a test has three accounts.
   */
  function sweep(currentMs: number): void {
    if (currentMs - lastSweepMs < SWEEP_INTERVAL_MS) return;
    lastSweepMs = currentMs;
    for (const [accountId, at] of lastWriteMs) {
      if (currentMs - at >= intervalMs) lastWriteMs.delete(accountId);
    }
  }

  return {
    check(input: { accountId: number; now: number }): PulseRateDecision {
      sweep(input.now);
      const lastMs = lastWriteMs.get(input.accountId);
      if (lastMs === undefined || input.now - lastMs >= intervalMs) return { allowed: true };
      return {
        allowed: false,
        retryAfterSeconds: secondsUntilAllowed({ lastMs, currentMs: input.now, intervalMs }),
      };
    },

    record(input: { accountId: number; now: number }): void {
      lastWriteMs.set(input.accountId, input.now);
    },
  };
}

/** The sentence a refusal carries. Names no identifier: a body must not echo a value back to whoever holds the token. */
export function pulseRateLimitMessage(intervalMs: number): string {
  return `rate limit reached: one write every ${Math.round(intervalMs / 1000)} seconds for this account`;
}
