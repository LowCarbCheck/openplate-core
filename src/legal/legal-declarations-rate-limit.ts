/**
 * A per-IP sliding-window burst limit on `POST /v1/legal/declarations`.
 *
 * KEYED ON THE IP, NOT AN ACCOUNT, because the route is deliberately
 * unauthenticated: both statutes require the button to work for a person who
 * has never logged in. `ai/rate-limit.ts` keys on the resolved account for
 * exactly the opposite reason; this module is that one's shape, with the
 * identity swapped for the one thing an anonymous caller has.
 *
 * SLIDING WINDOW, NOT FIXED WINDOWS, for the reason `ai/rate-limit.ts` gives:
 * a fixed window lets a caller spend two windows' worth of budget either side
 * of the boundary. Keeping timestamps and counting only the ones inside the
 * trailing window costs a short array per IP and has no such seam.
 *
 * IN-MEMORY AND SINGLE-PROCESS, deliberately, exactly as `ai/rate-limit.ts`
 * and `lib/throttle.ts` both are: one container, no Redis in a self-hoster's
 * compose file. The state resets on restart, which is the same real and
 * documented limitation every other in-memory limiter here carries.
 */
import type { NextFunction, Request, RequestHandler, Response } from 'express';

const WINDOW_MS = 60_000;

/** Amortised across requests rather than a `setInterval`, for the reason `ai/rate-limit.ts` gives: no handle to keep alive, no clock to inject twice. */
const SWEEP_INTERVAL_MS = WINDOW_MS;

export interface CreateLegalDeclarationsRateLimitOptions {
  /** Requests allowed per IP in any trailing 60-second window. */
  perMinute: number;
  /** Injectable clock so tests do not sleep. Defaults to `Date.now`. */
  now?: () => number;
}

/** Drops timestamps that have fallen out of the trailing window. Mutates in place — this is the hot path. */
function pruneExpired(timestamps: number[], windowStartMs: number): void {
  let firstLive = 0;
  while (firstLive < timestamps.length && (timestamps[firstLive] ?? 0) <= windowStartMs) {
    firstLive += 1;
  }
  if (firstLive > 0) timestamps.splice(0, firstLive);
}

/** Seconds until the oldest in-window request ages out. Floored at 1, so a `Retry-After: 0` never invites an immediate retry that is guaranteed to fail again. */
function secondsUntilSlotFrees(input: { oldestMs: number; currentMs: number }): number {
  return Math.max(1, Math.ceil((input.oldestMs + WINDOW_MS - input.currentMs) / 1000));
}

/**
 * `req.ip` is `undefined` only when Express cannot determine it at all; the
 * literal fallback keeps every such request in ONE bucket rather than
 * silently exempting them from the limit. Same rule `register-auth-routes.ts`
 * applies to its own throttle.
 */
function clientIp(req: Request): string {
  return req.ip ?? 'unknown';
}

export function createLegalDeclarationsRateLimit(options: CreateLegalDeclarationsRateLimitOptions): RequestHandler {
  const limit = options.perMinute;
  const now = options.now ?? ((): number => Date.now());
  /** IP -> timestamps of its in-window requests, oldest first. */
  const windows = new Map<string, number[]>();
  let lastSweepMs = now();

  /** Bounded memory: the map's size tracks ACTIVE IPs rather than every IP that has ever called, exactly as `ai/rate-limit.ts` argues. */
  function sweep(currentMs: number): void {
    if (currentMs - lastSweepMs < SWEEP_INTERVAL_MS) return;
    lastSweepMs = currentMs;
    const windowStartMs = currentMs - WINDOW_MS;
    for (const [key, timestamps] of windows) {
      pruneExpired(timestamps, windowStartMs);
      if (timestamps.length === 0) windows.delete(key);
    }
  }

  return function enforceLegalDeclarationsRateLimit(req: Request, res: Response, next: NextFunction): void {
    const ip = clientIp(req);
    const currentMs = now();
    sweep(currentMs);

    const windowStartMs = currentMs - WINDOW_MS;
    const timestamps = windows.get(ip) ?? [];
    pruneExpired(timestamps, windowStartMs);

    if (timestamps.length >= limit) {
      const oldestMs = timestamps[0] ?? currentMs;
      windows.set(ip, timestamps);
      const retryAfterSeconds = secondsUntilSlotFrees({ oldestMs, currentMs });
      res.setHeader('Retry-After', String(retryAfterSeconds));
      res.status(429).json({ error: 'declaration-rate-limited' });
      return;
    }

    timestamps.push(currentMs);
    windows.set(ip, timestamps);
    next();
  };
}
