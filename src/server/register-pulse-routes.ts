/**
 * `/v1/pulse`: four routes that let a person see that other people are here
 * today, and never that any particular person is.
 *
 * OPT IN ON THE DEVICE, AND THERE IS NO OPERATOR FLAG. Every other optional
 * surface on this service is mounted or dark by an operator's environment
 * variable, and this one is not, deliberately: the thing being opted in to is
 * somebody's own data leaving their own phone, and that decision belongs to the
 * person holding the phone. An instance nobody opted in on holds empty tables
 * and answers every field as zero, which is indistinguishable from an instance
 * where nobody ate. See `docs/adr/0007-the-pulse-is-a-named-exception.md`.
 *
 * ORDER OF MIDDLEWARE, and every step of it is load bearing:
 *
 *  1. `express.json()` with a TINY limit, SCOPED TO THIS PREFIX. An unscoped
 *     parser in a router mounted at the root runs before every other router in
 *     the service, and whichever parser runs first wins, so it silently becomes
 *     the limit for all of them. That was a live defect until M192/03 and it
 *     capped everything at 64 KB; see `server/register-routes.ts`. The bodies
 *     here are two integers, so the limit is measured in bytes.
 *  2. The BEARER GATE. Everything below keys on the resolved account, so
 *     nothing below has anything to key on before this runs.
 *  3. The handler, which runs FOUR STEPS IN ONE ORDER and the order is the
 *     design:
 *
 *       a. Decode the body. An unreadable one is a `400` and claims no key, so
 *          a client that fixes its body and retries with the same key still
 *          gets its meal counted.
 *       b. Claim the `Idempotency-Key`. A replay is the case this feature was
 *          built to survive: a queue drained twice after a flight sends the
 *          same key seconds after the original, and the protocol promises it a
 *          `200 {"duplicate": true}`. Behind the limiter that promise would be
 *          a `429`, which reads as "wait and try again" for a write that has
 *          already been made.
 *       c. Check the rate limit, and RELEASE the key when it refuses. A limit
 *          postpones a write; it must never swallow one, and a claimed key on
 *          a refused request would do exactly that to the client's retry.
 *       d. Write the delta, then record the limiter slot. Recorded last, so a
 *          request that wrote nothing never spends the account's minute.
 *
 * THE LOG LINE CARRIES A PATH, A STATUS AND A BYTE COUNT, AND NOTHING ELSE.
 * Not the account id, which every other route family here logs freely, and not
 * a value from the body. The difference is what the line would say: an AI proxy
 * line records somebody spending the operator's money, and a pulse line would
 * record that somebody ate lunch at 13:40. `tests/unit/pulse-log-leak.test.ts`
 * seeds a distinctive account id and fails if any captured line contains it.
 */
import express from 'express';
import type { Express, Request, RequestHandler, Response } from 'express';
import { asNumber, asObject, type JsonValue } from '../lib/json.js';
import { asyncHandler } from './async-handler.js';
import { getRequestSession } from './bearer-auth.js';
import { utcDayKey } from '../lib/utc-day.js';
import type { Logger } from '../logger.js';
import { isPulseIdempotencyKey, roundPulseKcal, roundPulseProtein } from '../pulse/pulse-deltas.js';
import { createPulseCache } from '../pulse/pulse-cache.js';
import {
  createPulseRateLimit,
  pulseRateLimitMessage,
  PULSE_FASTING_INTERVAL_MS,
  PULSE_MEAL_INTERVAL_MS,
  PULSE_PHOTO_INTERVAL_MS,
  type PulseRateLimit,
} from '../pulse/pulse-rate-limit.js';
import { PULSE_PRESENCE_TTL_MS } from '../pulse/pulse-retention.js';
import type { PulseStore, PulseTotals } from '../pulse/pulse-store.js';

/**
 * The one prefix this family owns. OUTSIDE `SYNC_API_PREFIX` on purpose: a
 * pulse delta is not a sync artifact, it does not participate in the CAS, and
 * putting it under `/v1/sync` would place it behind that prefix's bearer
 * middleware and make the ordering above somebody else's problem.
 */
export const PULSE_API_PREFIX = '/v1/pulse';

/**
 * The largest body any pulse route accepts.
 *
 * A KILOBYTE, because the largest legitimate body here is `{"kcal":1234,
 * "protein":33}`. Every other limit in this service is sized for a photograph
 * or a diary; this one is sized for what it carries, so a caller cannot park
 * anything in a route whose whole point is that it holds almost nothing.
 */
export const PULSE_MAX_REQUEST_BYTES = 1024;

/** What the routes hand back on a write that was already made. The protocol names this field. */
interface PulseDuplicateBody {
  duplicate: true;
}

export interface PulseRouteOptions {
  pulse: PulseStore;
  /** The bearer middleware, injected so this module never reaches for a singleton. */
  requireAuth: RequestHandler;
  logger: Logger;
  /** Injected, like every clock in this repo, so a test can pin the day and the cache window. */
  now: () => Date;
  /** Defaults to `PULSE_CACHE_TTL_MS`, the five minutes of `pulse/pulse-cache.ts`. A test names a shorter one. */
  cacheTtlMs?: number;
}

/** Every bad body is the same sentence. Telling a caller which field was wrong in detail helps nobody here. */
function sendInvalidBody(res: Response): void {
  res.status(400).json({ error: 'invalid request body' });
}

/**
 * The `Idempotency-Key` a write carries, or a `400` the caller already has.
 *
 * A UUID IS REQUIRED RATHER THAN ANY STRING. The header has one job, to be the
 * same on a retry and different on a new write, and a client sending `1` would
 * collide with every other client on the instance and silently lose meals.
 */
function idempotencyKeyOrRefuse(req: Request, res: Response): string | null {
  const key = req.header('idempotency-key') ?? undefined;
  if (isPulseIdempotencyKey(key)) return key;
  res.status(400).json({ error: 'idempotency key required' });
  return null;
}

/**
 * The pulse family's own access log.
 *
 * A PATH, A STATUS AND A BYTE COUNT. The byte count is read off the response
 * rather than counted here, so this middleware never touches a body. `finish`
 * rather than a wrapper around `res.json`, so a 404, a 429 and an error all get
 * one line of the same shape.
 */
function createPulseAccessLog(logger: Logger): RequestHandler {
  return function logPulseResponse(req: Request, res: Response, next): void {
    res.on('finish', () => {
      // SAFETY: `content-length` is a single numeric header on every response
      // this service writes; `String` covers the absent and repeated forms
      // without a runtime type inspection, and a non-numeric one reads as 0.
      const bytes = Number.parseInt(String(res.getHeader('content-length') ?? '0'), 10);
      logger.info('Pulse request', {
        // The ROUTE, not the original url: a query string is a place a caller
        // could put something this line has promised not to carry.
        path: req.path,
        method: req.method,
        status: res.statusCode,
        bytes: Number.isNaN(bytes) ? 0 : bytes,
      });
    });
    next();
  };
}

export function registerPulseRoutes(app: Express, options: PulseRouteOptions): void {
  const { pulse, logger, now } = options;
  const router = express.Router();

  // Scoped to the prefix. See the module header on the 64 KB regression an
  // unscoped parser caused once.
  router.use(PULSE_API_PREFIX, express.json({ limit: PULSE_MAX_REQUEST_BYTES }));
  router.use(PULSE_API_PREFIX, createPulseAccessLog(logger));
  router.use(PULSE_API_PREFIX, options.requireAuth);

  // THE INJECTED CLOCK REACHES THE LIMITERS TOO, so a test moves time rather
  // than waiting ten minutes for a heartbeat window.
  const limitClock = (): number => now().getTime();
  const limits = {
    meal: createPulseRateLimit({ intervalMs: PULSE_MEAL_INTERVAL_MS, now: limitClock }),
    photo: createPulseRateLimit({ intervalMs: PULSE_PHOTO_INTERVAL_MS, now: limitClock }),
    fasting: createPulseRateLimit({ intervalMs: PULSE_FASTING_INTERVAL_MS, now: limitClock }),
  };

  /**
   * Everything a write does after its body has been read, in the one order the
   * module header argues for.
   *
   * SHARED BY ALL THREE WRITES rather than written out three times, because the
   * order IS the correctness: three copies is three places somebody can put the
   * limiter above the claim and reintroduce a `429` on a replay.
   */
  async function completeWrite(input: {
    req: Request;
    res: Response;
    limit: PulseRateLimit;
    intervalMs: number;
    apply(accountId: number): Promise<void>;
  }): Promise<void> {
    const { req, res } = input;
    const session = getRequestSession(req);
    if (session === null) {
      // FAIL CLOSED. Reaching here means this router was mounted without the
      // bearer middleware, which is a wiring bug and not a client error.
      res.status(401).json({ error: 'authentication required' });
      return;
    }

    const key = idempotencyKeyOrRefuse(req, res);
    if (key === null) return;

    const at = now();
    if ((await pulse.claim({ key, accountId: session.accountId, now: at })) === 'duplicate') {
      const duplicate: PulseDuplicateBody = { duplicate: true };
      res.status(200).json(duplicate);
      return;
    }

    const decision = input.limit.check({ accountId: session.accountId, now: at.getTime() });
    if (!decision.allowed) {
      // THE KEY GOES BACK. A limit postpones a write; a claimed key on a
      // refused request would make the client's retry a no-op and swallow it.
      await pulse.release({ key });
      res.setHeader('Retry-After', String(decision.retryAfterSeconds));
      res.status(429).json({ error: pulseRateLimitMessage(input.intervalMs) });
      return;
    }

    await input.apply(session.accountId);
    // RECORDED LAST, so nothing that failed to write spends the account's window.
    input.limit.record({ accountId: session.accountId, now: at.getTime() });
    res.status(202).json({ accepted: true });
  }

  router.post(
    `${PULSE_API_PREFIX}/meal`,
    asyncHandler(async (req, res) => {
      // SAFETY: `express.json()` above has already parsed this body, so it is
      // JSON-shaped by construction; `asObject` re-establishes that at the type
      // level and yields `null` for anything that is not an object.
      const body = asObject(req.body as JsonValue) ?? {};
      const kcal = asNumber(body.kcal);
      const protein = asNumber(body.protein);
      if (kcal === null || protein === null) {
        // AHEAD OF THE CLAIM, so a client that fixes its body and retries with
        // the same key still gets its meal counted.
        sendInvalidBody(res);
        return;
      }

      await completeWrite({
        req,
        res,
        limit: limits.meal,
        intervalMs: PULSE_MEAL_INTERVAL_MS,
        // THE SERVER ROUNDS, whatever the device did. See
        // `pulse/pulse-deltas.ts` on why a grid that only holds when every
        // client behaves is not a grid.
        apply: (accountId) =>
          pulse.addMeal({
            day: utcDayKey(now()),
            accountId,
            kcal: roundPulseKcal(kcal),
            protein: roundPulseProtein(protein),
          }),
      });
    }),
  );

  router.post(
    `${PULSE_API_PREFIX}/photo`,
    asyncHandler(async (req, res) => {
      // NO BODY IS READ AT ALL. A photo delta is the count 1, and a route that
      // read a field here would be a route somebody could later put a figure in.
      await completeWrite({
        req,
        res,
        limit: limits.photo,
        intervalMs: PULSE_PHOTO_INTERVAL_MS,
        apply: (accountId) => pulse.addPhoto({ day: utcDayKey(now()), accountId }),
      });
    }),
  );

  router.post(
    `${PULSE_API_PREFIX}/fasting`,
    asyncHandler(async (req, res) => {
      await completeWrite({
        req,
        res,
        limit: limits.fasting,
        intervalMs: PULSE_FASTING_INTERVAL_MS,
        // AN UPSERT, so two heartbeats leave one row with the later expiry, and
        // the row is gone 30 minutes after the last one.
        apply: (accountId) =>
          pulse.markFasting({ accountId, expiresAt: new Date(now().getTime() + PULSE_PRESENCE_TTL_MS) }),
      });
    }),
  );

  const todayCache = createPulseCache<PulseTotals>({
    load: () => pulse.totals({ day: utcDayKey(now()), now: now() }),
    now: () => now().getTime(),
    ttlMs: options.cacheTtlMs,
  });

  router.get(
    `${PULSE_API_PREFIX}/today`,
    asyncHandler(async (_req, res) => {
      // ONE ENTRY FOR THE WHOLE INSTANCE, five minutes old at most, and never
      // invalidated by a write. See `pulse/pulse-cache.ts` on why.
      res.status(200).json(await todayCache.read());
    }),
  );

  app.use(router);
}
