/**
 * One cache entry for the whole instance, five minutes old at most.
 *
 * INVALIDATED BY TIME AND NEVER BY A WRITE, and that is a decision rather than
 * an omission. A cache that a write cleared would be cleared by almost every
 * write, because the entry is shared by every reader on the instance, and the
 * feature would then do a full read per meal on top of the write. What the
 * reader loses is that their own meal is not in the number for a few minutes.
 * What they are being shown is that other people are here today, which is not
 * an acknowledgement of what they just did, so the staleness costs the feature
 * nothing it was for. PROTOCOL.md §5.23 states it rather than hiding it.
 *
 * ONE ENTRY, NOT A MAP. The answer is instance wide, so there is nothing to key
 * on, and a map keyed by day would keep yesterday's answer alive past midnight
 * for no reader.
 *
 * IN PROCESS AND SINGLE CONTAINER, exactly as `lib/throttle.ts` and
 * `ai/rate-limit.ts` argue for: a second replica would simply have its own
 * entry and its own five minutes, which is a staleness the feature already
 * accepts.
 *
 * THE CLOCK IS INJECTED, so a test asserts the window instead of sleeping
 * through it, and a SINGLE IN-FLIGHT LOAD is shared: ten readers arriving on a
 * cold entry together must not become ten identical queries.
 */

/** Five minutes. The counsel's answer to "this is a lot of server work for the number of users". */
export const PULSE_CACHE_TTL_MS = 5 * 60 * 1000;

export interface PulseCacheOptions<T> {
  /** What to call when the entry is cold or stale. */
  load(): Promise<T>;
  /** Injected, like every clock in this repo. */
  now(): number;
  /** Defaults to {@link PULSE_CACHE_TTL_MS}. */
  ttlMs?: number;
}

export interface PulseCache<T> {
  /** The cached value, loading it first when the entry is cold or older than the window. */
  read(): Promise<T>;
}

export function createPulseCache<T>(options: PulseCacheOptions<T>): PulseCache<T> {
  const ttlMs = options.ttlMs ?? PULSE_CACHE_TTL_MS;
  let value: { at: number; body: T } | null = null;
  let inFlight: Promise<T> | null = null;

  return {
    async read(): Promise<T> {
      const currentMs = options.now();
      if (value !== null && currentMs - value.at < ttlMs) return value.body;
      // A load already running is the load this caller wants: sharing it is
      // what keeps a cold entry from becoming one query per reader.
      if (inFlight !== null) return inFlight;

      const pending = options.load();
      inFlight = pending;
      try {
        const body = await pending;
        value = { at: currentMs, body };
        return body;
      } finally {
        // Cleared on failure too, so a database that was briefly unreachable
        // does not pin a rejected promise for every later reader.
        inFlight = null;
      }
    },
  };
}
