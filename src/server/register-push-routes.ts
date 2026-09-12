/**
 * `/v1/push`: four routes that let a device say where to reach it and when,
 * and nothing that lets anybody say what to send.
 *
 * IT IS NOT `server/push-handler.ts`. That module is the sync BLOB push of
 * PROTOCOL.md §5.1, the compare-and-swap that writes a ciphertext, and it
 * predates this feature by a year. The two words collide and the concepts do
 * not; this one is web push.
 *
 * ORDER OF MIDDLEWARE, and every step of it is load bearing, exactly as
 * `server/register-pulse-routes.ts` argues:
 *
 *  1. `express.json()` with a SMALL limit, SCOPED TO THIS PREFIX. An unscoped
 *     parser in a router mounted at the root runs before every other router in
 *     the service, and whichever parser runs first wins, so it silently becomes
 *     the limit for all of them. That was a live defect until M192/03. The
 *     bodies here are an endpoint and two keys.
 *  2. The ACCESS LOG, which carries a path, a method, a status and a byte count
 *     and nothing else.
 *  3. The BEARER GATE. Every route below keys on the resolved account.
 *
 * THE LOG LINE NEVER CARRIES THE ACCOUNT ID, and never an endpoint.
 * `tests/unit/push-log-leak.test.ts` is the pulse's test again, for the same
 * reason ADR-0007 gives and one more: a push endpoint is a capability. Anybody
 * holding it and the instance's VAPID private key can wake that phone, and a
 * log line outlives the row it describes.
 *
 * WHAT THE SUBTREE ANSWERS WITH NO VAPID KEYS IS DECIDED IN `create-app.ts`,
 * ahead of everything, and it is the ordinary unknown-path 404. This module is
 * not mounted at all on such an instance.
 */
import express from 'express';
import type { Express, Request, RequestHandler, Response } from 'express';
import { asBoolean, asNumber, asObject, asString, type JsonObject, type JsonValue } from '../lib/json.js';
import { asyncHandler } from './async-handler.js';
import { getRequestSession } from './bearer-auth.js';
import type { Logger } from '../logger.js';
import { isInstanceLanguage, type InstanceLanguage } from '../protocol.js';
import { isTimeZone, localDayKey } from '../push/local-day.js';
import type { PushStore } from '../push/push-store.js';

/**
 * The one prefix this family owns. OUTSIDE `SYNC_API_PREFIX` on purpose: a
 * subscription is not a sync artifact, it does not participate in the CAS, and
 * putting it under `/v1/sync` would place it behind that prefix's bearer
 * middleware and make the ordering above somebody else's problem.
 */
export const PUSH_API_PREFIX = '/v1/push';

/**
 * The largest body any push route accepts.
 *
 * FOUR KILOBYTES. A push endpoint is a URL a push service minted and the
 * longest in the wild are a few hundred characters; the two keys are 88 and 24.
 * Every other limit in this service is sized for a photograph or a diary, and
 * this one is sized for what it carries.
 */
export const PUSH_MAX_REQUEST_BYTES = 4096;

/** Longer than this and a user agent is padding a column rather than naming a device. ADR-0008 states the number. */
export const PUSH_USER_AGENT_MAX = 160;

/** The last minute of a day. A `catchUpMinute` is 0 to this, and the table carries the same check. */
const LAST_MINUTE_OF_DAY = 1439;

export interface PushRouteOptions {
  store: PushStore;
  /** The application server key a browser passes to `pushManager.subscribe`. Public by definition. */
  publicKey: string;
  /** The bearer middleware, injected so this module never reaches for a singleton. */
  requireAuth: RequestHandler;
  logger: Logger;
  /** Injected, like every clock in this repo, so a test can pin the local day a registration is stamped with. */
  now: () => Date;
}

/** Every bad body is the same sentence. Telling a caller which field was wrong in detail helps nobody here. */
function sendInvalidBody(res: Response, detail: string): void {
  res.status(400).json({ error: detail });
}

/**
 * The push family's own access log: a path, a method, a status and a byte
 * count. Read off the response rather than counted here, so this middleware
 * never touches a body. See the module header on why the account id is absent.
 */
function createPushAccessLog(logger: Logger): RequestHandler {
  return function logPushResponse(req: Request, res: Response, next): void {
    res.on('finish', () => {
      // SAFETY: `content-length` is a single numeric header on every response
      // this service writes; `String` covers the absent and repeated forms
      // without a runtime type inspection, and a non-numeric one reads as 0.
      const bytes = Number.parseInt(String(res.getHeader('content-length') ?? '0'), 10);
      logger.info('Push request', {
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

/** The parsed body of a route, or the sentence that refuses it. */
type Decoded<T> = { ok: true; value: T } | { ok: false; error: string };

/** A registration, decoded. Everything here is required: a device that omits a field is a client bug, not a default. */
interface Registration {
  endpoint: string;
  p256dh: string;
  auth: string;
  /** The endpoint this device last held, or `null` when it names no predecessor. */
  replaces: string | null;
  timeZone: string;
  locale: InstanceLanguage;
  catchUpMinute: number | null;
  fastTargetEnabled: boolean;
}

/** A minute of the local day, `null` for "no catch-up", or a refusal. Shared by both write routes. */
function decodeCatchUpMinute(value: JsonValue | undefined): Decoded<number | null> {
  if (value === null) return { ok: true, value: null };
  const minute = asNumber(value);
  if (minute === null || !Number.isInteger(minute) || minute < 0 || minute > LAST_MINUTE_OF_DAY) {
    return { ok: false, error: 'catchUpMinute must be a whole minute of the day, 0 to 1439, or null' };
  }
  return { ok: true, value: minute };
}

/** An IANA zone this runtime knows, or a refusal. Checked HERE so the tick can never meet one it cannot read. */
function decodeTimeZone(value: JsonValue | undefined): Decoded<string> {
  const zone = asString(value);
  if (zone === null || !isTimeZone(zone)) {
    return { ok: false, error: 'timeZone must be an IANA time zone name, for example Europe/Berlin' };
  }
  return { ok: true, value: zone };
}

function decodeLocale(value: JsonValue | undefined): Decoded<InstanceLanguage> {
  if (!isInstanceLanguage(value)) return { ok: false, error: 'locale must be "en" or "de"' };
  return { ok: true, value };
}

function decodeRegistration(body: JsonObject): Decoded<Registration> {
  const endpoint = asString(body.endpoint);
  if (endpoint === null || endpoint.length === 0) return { ok: false, error: 'endpoint is required' };

  const keys = asObject(body.keys);
  const p256dh = keys === null ? null : asString(keys.p256dh);
  const auth = keys === null ? null : asString(keys.auth);
  if (p256dh === null || auth === null || p256dh.length === 0 || auth.length === 0) {
    return { ok: false, error: 'keys.p256dh and keys.auth are required' };
  }

  const timeZone = decodeTimeZone(body.timeZone);
  if (!timeZone.ok) return timeZone;
  const locale = decodeLocale(body.locale);
  if (!locale.ok) return locale;
  const catchUpMinute = decodeCatchUpMinute(body.catchUpMinute);
  if (!catchUpMinute.ok) return catchUpMinute;

  const fastTargetEnabled = asBoolean(body.fastTargetEnabled);
  if (fastTargetEnabled === null) return { ok: false, error: 'fastTargetEnabled must be true or false' };

  return {
    ok: true,
    value: {
      endpoint,
      p256dh,
      auth,
      replaces: asString(body.replaces),
      timeZone: timeZone.value,
      locale: locale.value,
      catchUpMinute: catchUpMinute.value,
      fastTargetEnabled,
    },
  };
}

/** The `User-Agent` of the registering request, trimmed and capped, or `null` when it sent none. */
function userAgentOf(req: Request): string | null {
  const raw = req.header('user-agent')?.trim() ?? '';
  return raw === '' ? null : raw.slice(0, PUSH_USER_AGENT_MAX);
}

/**
 * The resolved account, or a `401` the caller already has.
 *
 * FAIL CLOSED. Reaching the `null` branch means this router was mounted without
 * the bearer middleware, which is a wiring bug and not a client error.
 */
function accountIdOrRefuse(req: Request, res: Response): number | null {
  const session = getRequestSession(req);
  if (session !== null) return session.accountId;
  res.status(401).json({ error: 'authentication required' });
  return null;
}

export function registerPushRoutes(app: Express, options: PushRouteOptions): void {
  const { store, logger, now } = options;
  const router = express.Router();

  // Scoped to the prefix. See the module header on the 64 KB regression an
  // unscoped parser caused once.
  router.use(PUSH_API_PREFIX, express.json({ limit: PUSH_MAX_REQUEST_BYTES }));
  router.use(PUSH_API_PREFIX, createPushAccessLog(logger));
  router.use(PUSH_API_PREFIX, options.requireAuth);

  router.get(
    `${PUSH_API_PREFIX}/config`,
    asyncHandler(async (_req, res) => {
      // THE PUBLIC KEY AND NOTHING ELSE. It is the application server key a
      // browser needs before it can subscribe at all, it is public by
      // definition, and the subject and the private key have no business
      // leaving the process.
      res.status(200).json({ publicKey: options.publicKey });
    }),
  );

  router.put(
    `${PUSH_API_PREFIX}/subscriptions`,
    asyncHandler(async (req, res) => {
      const accountId = accountIdOrRefuse(req, res);
      if (accountId === null) return;

      // SAFETY: `express.json()` above has already parsed this body, so it is
      // JSON-shaped by construction; `asObject` re-establishes that at the type
      // level and yields `null` for anything that is not an object.
      const body = asObject(req.body as JsonValue) ?? {};
      const decoded = decodeRegistration(body);
      if (!decoded.ok) {
        sendInvalidBody(res, decoded.error);
        return;
      }
      const registration = decoded.value;

      // THE PREDECESSOR GOES FIRST, and only when it is a DIFFERENT endpoint: a
      // device re-registering the endpoint it already holds is naming itself,
      // not an ancestor. The account is in the store's predicate, so naming
      // somebody else's endpoint deletes nothing.
      if (registration.replaces !== null && registration.replaces !== registration.endpoint) {
        await store.deleteSupersededEndpoint({ accountId, endpoint: registration.replaces });
      }

      const outcome = await store.upsert({
        accountId,
        endpoint: registration.endpoint,
        p256dh: registration.p256dh,
        auth: registration.auth,
        userAgent: userAgentOf(req),
        timeZone: registration.timeZone,
        locale: registration.locale,
        catchUpMinute: registration.catchUpMinute,
        fastTargetEnabled: registration.fastTargetEnabled,
        // THE LOCAL DAY, in the zone the device just declared. The seven day
        // pause counts local days, so stamping this one in UTC would make the
        // window off by one for half the world.
        lastSeenDay: localDayKey(now(), registration.timeZone),
        createdAt: now(),
      });

      res.status(outcome === 'created' ? 201 : 200).json({ subscribed: true });
    }),
  );

  router.patch(
    `${PUSH_API_PREFIX}/subscriptions`,
    asyncHandler(async (req, res) => {
      const accountId = accountIdOrRefuse(req, res);
      if (accountId === null) return;

      // SAFETY: as above, the body has already been parsed by `express.json()`.
      const body = asObject(req.body as JsonValue) ?? {};
      const endpoint = asString(body.endpoint);
      if (endpoint === null || endpoint.length === 0) {
        sendInvalidBody(res, 'endpoint is required');
        return;
      }

      // READ FIRST, because the zone decides which local day `lastSeenDay` is
      // stamped with, and a patch that changes the zone must be stamped in the
      // NEW one. A row that is not this account's is a 404 before anything is
      // written.
      const existing = await store.findOwn({ accountId, endpoint });
      if (existing === null) {
        res.status(404).json({ error: 'no such subscription' });
        return;
      }

      const patch = {
        accountId,
        endpoint,
        timeZone: existing.timeZone,
        locale: existing.locale,
        catchUpMinute: existing.catchUpMinute,
        fastTargetEnabled: existing.fastTargetEnabled,
        wakeAt: existing.wakeAt,
        lastSeenDay: existing.lastSeenDay,
      };

      if (body.timeZone !== undefined) {
        const timeZone = decodeTimeZone(body.timeZone);
        if (!timeZone.ok) {
          sendInvalidBody(res, timeZone.error);
          return;
        }
        patch.timeZone = timeZone.value;
      }

      if (body.locale !== undefined) {
        const locale = decodeLocale(body.locale);
        if (!locale.ok) {
          sendInvalidBody(res, locale.error);
          return;
        }
        patch.locale = locale.value;
      }

      if (body.catchUpMinute !== undefined) {
        const minute = decodeCatchUpMinute(body.catchUpMinute);
        if (!minute.ok) {
          sendInvalidBody(res, minute.error);
          return;
        }
        patch.catchUpMinute = minute.value;
      }

      if (body.fastTargetEnabled !== undefined) {
        const enabled = asBoolean(body.fastTargetEnabled);
        if (enabled === null) {
          sendInvalidBody(res, 'fastTargetEnabled must be true or false');
          return;
        }
        patch.fastTargetEnabled = enabled;
      }

      if (body.wakeAt !== undefined) {
        // `null` CLEARS IT, which is how a fast that was stopped early stops
        // being a notification. An absent field leaves it exactly as it was.
        if (body.wakeAt === null) {
          patch.wakeAt = null;
        } else {
          const raw = asString(body.wakeAt);
          const parsed = raw === null ? Number.NaN : Date.parse(raw);
          if (Number.isNaN(parsed)) {
            sendInvalidBody(res, 'wakeAt must be an ISO 8601 instant or null');
            return;
          }
          patch.wakeAt = new Date(parsed);
        }
      }

      // Stamped in whatever zone the row ends up in, see the read above.
      patch.lastSeenDay = localDayKey(now(), patch.timeZone);

      const updated = await store.patch(patch);
      if (updated === null) {
        // Lost a race with a delete or a prune between the read and the write.
        res.status(404).json({ error: 'no such subscription' });
        return;
      }
      res.status(200).json({ updated: true });
    }),
  );

  router.delete(
    `${PUSH_API_PREFIX}/subscriptions`,
    asyncHandler(async (req, res) => {
      const accountId = accountIdOrRefuse(req, res);
      if (accountId === null) return;

      // SAFETY: as above, the body has already been parsed by `express.json()`.
      const body = asObject(req.body as JsonValue) ?? {};
      const endpoint = asString(body.endpoint);
      if (endpoint === null || endpoint.length === 0) {
        sendInvalidBody(res, 'endpoint is required');
        return;
      }

      // IDEMPOTENT: a device unsubscribing twice, or unsubscribing an endpoint
      // the tick already pruned, gets the same answer. The alternative is a 404
      // that tells a caller whether a row they do not own exists.
      await store.deleteOwnEndpoint({ accountId, endpoint });
      res.status(200).json({ unsubscribed: true });
    }),
  );

  app.use(router);
}
