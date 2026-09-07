/**
 * `POST /v1/feedback`, a person reporting that a measurement was wrong, with
 * the photograph it came from, having agreed in plain words that it leaves
 * their device.
 *
 * MOUNTED ONLY WHEN `SYNC_FEEDBACK` IS ON, and absent means the ordinary
 * unknown-path 404 rather than a 401 or a 503. The bargain is the one
 * `create-app.ts` already makes for the admin, share, research and AI trees,
 * for the same reason: this service auto-deploys on push, so the commit that
 * adds the route is the commit that puts it in production, and an instance
 * whose operator has not opted in must be indistinguishable from one where the
 * feature was never written. A 401 would announce that a credential exists here
 * and is merely locked.
 *
 * WHAT THIS ROUTE COSTS THE OPERATOR, PLAINLY. Every other write path on this
 * service stores something nobody can read. This one stores a photograph of a
 * person's food and the figures beside it, in the clear, in the operator's own
 * database. It is the SECOND place the zero-knowledge position does not hold,
 * and it differs from the first: `ai/proxy.ts` sees a photograph and keeps
 * nothing, this KEEPS what it is given. See
 * `docs/adr/0006-a-reported-photograph-is-the-second-hole-in-the-claim.md`.
 *
 * ORDER OF MIDDLEWARE, borrowed from `ai/register-ai-route.ts` because the
 * shape of the problem is the same:
 *
 *  1. `express.json()` with a limit sized for a PHOTOGRAPH
 *     (`FEEDBACK_MAX_REQUEST_BYTES`, default 8 MB), scoped to this route only.
 *     An unscoped parser here would run before every other router in the
 *     service and quietly become the limit for all of them, which was a live
 *     defect until M192/03. See `server/share-routes.ts`.
 *  2. The BEARER GATE. The daily limit keys on the resolved account, so it has
 *     nothing to key on before this runs.
 *  3. The handler, which decides the limit inside one transaction rather than
 *     as a middleware: the count and the insert have to be the same statement
 *     sequence or a burst gets counted once. See `feedback-store.ts`.
 *
 * THE TWO-STAGE 413 is `server/register-routes.ts`'s, for its reason. The JSON
 * body limit sits ABOVE the decoded image cap because base64 inflates by 4/3,
 * so a body limit set at the image cap would reject a legal maximum-size image
 * before the handler ever saw it. Both stages answer `413 {"error": "..."}`;
 * the body-parser half goes through `server/error-middleware.ts`.
 *
 * WHAT IS STORED, EXHAUSTIVELY: the photograph, the figures, and the consent
 * record. Not the request headers, not the IP, not the user agent, not a device
 * identifier, and nothing else from the person's diary. Anything this handler
 * reads off the request and does not store is read to VALIDATE and then
 * dropped.
 */
import express from 'express';
import type { Express, Request, Response } from 'express';
import { asObject, asString, type JsonObject, type JsonValue } from '../lib/json.js';
import { asyncHandler } from '../server/async-handler.js';
import { getRequestSession } from '../server/bearer-auth.js';
import type { FeedbackImageStore } from './feedback-image-store.js';
import type { FeedbackStore } from './feedback-store.js';

/**
 * The one path this family owns. OUTSIDE `SYNC_API_PREFIX` on purpose: a report
 * is not a sync artifact, it does not participate in the CAS, and putting it
 * under `/v1/sync` would place it behind that prefix's bearer middleware and
 * make the dark-instance terminator an ordering puzzle rather than a mount.
 */
export const FEEDBACK_API_PREFIX = '/v1/feedback';

/**
 * The largest image this route stores, decoded, in bytes.
 *
 * 5 MB is a full-resolution phone JPEG with room to spare, and the app
 * downscales before it queues one. A constant rather than a knob because the
 * operator-facing knob is the BODY limit, and two limits an operator can move
 * independently is two ways to configure a route that rejects everything.
 */
export const MAX_FEEDBACK_IMAGE_BYTES = 5_000_000;

/**
 * The largest `measurements` object this route stores, as serialised JSON.
 *
 * A BOUND, NOT A SCHEMA. The server has no opinion about the shape of a
 * measurement and must not grow one, so the only thing it checks is that
 * nobody can park a diary in the field. 16 KB is orders of magnitude above one
 * entry's figures.
 */
export const MAX_MEASUREMENTS_BYTES = 16 * 1024;

/** Longest accepted idempotency key. A bound on an unbounded client-chosen string, nothing more. */
const MAX_IDEMPOTENCY_KEY_CHARS = 128;

/** Longest accepted consent wording version. Same reason. */
const MAX_CONSENT_VERSION_CHARS = 64;

/**
 * The image types this route accepts.
 *
 * AN ALLOWLIST, because the value is stored and later served back to an
 * operator's browser by spec 06. `image/svg+xml` is absent deliberately: an SVG
 * is a document that can carry script, and a reviewer opening one would be
 * opening a page a reporter wrote.
 */
export const ALLOWED_FEEDBACK_IMAGE_TYPES: readonly string[] = ['image/jpeg', 'image/png', 'image/webp'];

export interface FeedbackRouteOptions {
  reports: FeedbackStore;
  images: FeedbackImageStore;
  /** The bearer middleware, injected so this module never reaches for a singleton. */
  requireAuth: express.RequestHandler;
  /** How many reports one account may store per UTC day (`FEEDBACK_DAILY_LIMIT`). */
  dailyLimit: number;
  /** The largest request body this route accepts, in bytes (`FEEDBACK_MAX_REQUEST_BYTES`). */
  maxRequestBytes: number;
  /** Injected, like every clock in this repo, so a test can pin the day boundary. */
  now: () => Date;
}

/** A decoded, validated submission. Nothing here is optional by accident: an absent field is a 400, never a default. */
interface FeedbackSubmission {
  idempotencyKey: string;
  measurements: JsonObject;
  consentAgreedAt: Date;
  consentWordingVersion: string;
  image: { contentType: string; bytes: Buffer } | null;
}

/** Every bad body is the same sentence. Telling a caller which field was wrong is useful; telling it in detail is not. */
function sendInvalidBody(res: Response): void {
  res.status(400).json({ error: 'invalid request body' });
}

function parseBoundedString(value: JsonValue | undefined, maxChars: number): string | null {
  const raw = asString(value);
  if (raw === null) return null;
  const trimmed = raw.trim();
  if (trimmed.length === 0 || trimmed.length > maxChars) return null;
  return trimmed;
}

/**
 * The person's own clock, taken as given.
 *
 * NOT CORRECTED AND NOT COMPARED against the server's. `consent_agreed_at` says
 * when the person agreed on the device in their hand; `created_at` beside it is
 * this service's own record of when the report arrived, and the pair is more
 * honest than either value silently overwritten by the other.
 */
function parseConsentInstant(value: JsonValue | undefined): Date | null {
  const raw = asString(value);
  if (raw === null) return null;
  const parsed = new Date(raw);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

/** The measurements object, bounded by SIZE alone. See {@link MAX_MEASUREMENTS_BYTES} on why there is no schema. */
function parseMeasurements(value: JsonValue | undefined): JsonObject | null {
  const measurements = asObject(value);
  if (measurements === null) return null;
  if (Buffer.byteLength(JSON.stringify(measurements), 'utf8') > MAX_MEASUREMENTS_BYTES) return null;
  return measurements;
}

/** `{ ok: false }` is a malformed image; `{ ok: true, image: null }` is a report that legitimately has none. */
type ParsedImage =
  { ok: true; image: { contentType: string; bytes: Buffer } | null } | { ok: false; tooLarge: boolean };

/**
 * The photograph, or the absence of one.
 *
 * AN ABSENT IMAGE IS NOT AN ERROR, and that is a requirement rather than a
 * kindness: the app's photo cache evicts by age and by count, so the image can
 * be gone before the person presses the button, and the figures alone are still
 * worth a reviewer's time. `null` and an absent key both mean "no image".
 */
function parseImage(value: JsonValue | undefined): ParsedImage {
  if (value === undefined || value === null) return { ok: true, image: null };

  const image = asObject(value);
  if (image === null) return { ok: false, tooLarge: false };

  const contentType = asString(image.contentType);
  const data = asString(image.data);
  if (contentType === null || data === null) return { ok: false, tooLarge: false };
  if (!ALLOWED_FEEDBACK_IMAGE_TYPES.includes(contentType)) return { ok: false, tooLarge: false };

  const bytes = Buffer.from(data, 'base64');
  // Base64 that decodes to nothing is a client bug, and storing zero bytes
  // under a report that claims an image would mislead every later reader.
  if (bytes.byteLength === 0) return { ok: false, tooLarge: false };
  if (bytes.byteLength > MAX_FEEDBACK_IMAGE_BYTES) return { ok: false, tooLarge: true };
  return { ok: true, image: { contentType, bytes } };
}

/** The start of the UTC day the given instant falls in. The daily limit's window, and the AI quota's boundary. */
function startOfUtcDay(instant: Date): Date {
  return new Date(Date.UTC(instant.getUTCFullYear(), instant.getUTCMonth(), instant.getUTCDate()));
}

/** Decodes the whole body, or answers the caller and returns `null`. One place, so no field escapes validation. */
function decodeSubmission(req: Request, res: Response): FeedbackSubmission | null {
  // SAFETY: `express.json()` on the route above has already parsed this body,
  // so it is JSON-shaped by construction; `asObject` re-establishes that at the
  // type level and yields `null` for anything that is not an object.
  const body = asObject(req.body as JsonValue) ?? {};

  const idempotencyKey = parseBoundedString(body.idempotencyKey, MAX_IDEMPOTENCY_KEY_CHARS);
  const measurements = parseMeasurements(body.measurements);
  const consent = asObject(body.consent);
  const consentAgreedAt = consent === null ? null : parseConsentInstant(consent.agreedAt);
  const consentWordingVersion =
    consent === null ? null : parseBoundedString(consent.wordingVersion, MAX_CONSENT_VERSION_CHARS);

  if (idempotencyKey === null || measurements === null || consentAgreedAt === null || consentWordingVersion === null) {
    sendInvalidBody(res);
    return null;
  }

  const parsedImage = parseImage(body.image);
  if (!parsedImage.ok) {
    // The oversize case is a 413 rather than a 400 so it matches what
    // body-parser answers one layer up, and so the person's client can tell
    // "your photo is too big" from "your report is malformed".
    if (parsedImage.tooLarge) {
      res.status(413).json({ error: 'request body exceeds the maximum accepted size' });
      return null;
    }
    sendInvalidBody(res);
    return null;
  }

  return {
    idempotencyKey,
    measurements,
    consentAgreedAt,
    consentWordingVersion,
    image: parsedImage.image,
  };
}

export function registerFeedbackRoute(app: Express, options: FeedbackRouteOptions): void {
  const router = express.Router();

  router.post(
    FEEDBACK_API_PREFIX,
    express.json({ limit: options.maxRequestBytes }),
    options.requireAuth,
    asyncHandler(async (req, res) => {
      const session = getRequestSession(req);
      if (session === null) {
        // FAIL CLOSED. Reaching here means this handler was mounted without the
        // bearer middleware, which is a wiring bug and not a client error.
        res.status(401).json({ error: 'authentication required' });
        return;
      }

      const submission = decodeSubmission(req, res);
      if (submission === null) return;

      const now = options.now();
      const result = await options.reports.submit({
        accountId: session.accountId,
        idempotencyKey: submission.idempotencyKey,
        measurements: submission.measurements,
        consent: { agreedAt: submission.consentAgreedAt, wordingVersion: submission.consentWordingVersion },
        hasImage: submission.image !== null,
        dailyLimit: options.dailyLimit,
        since: startOfUtcDay(now),
      });

      if (result.status === 'daily-limit-reached') {
        // Names no identifier, exactly as the AI limiter does not: putting an
        // account id in a response body echoes a value back to whoever holds
        // the token.
        res.status(429).json({ error: `daily limit reached: ${result.limit} reports per day for this account` });
        return;
      }

      // THE IMAGE IS WRITTEN AFTER THE REPORT, AND AGAIN ON A DUPLICATE. A
      // crash between the two leaves a report that says it has an image with no
      // bytes behind it; the client's retry carries the same idempotency key,
      // lands on the `duplicate` branch, and puts the image again. That repair
      // is why `put` is an upsert.
      if (submission.image !== null) {
        await options.images.put({
          reportId: result.report.id,
          contentType: submission.image.contentType,
          bytes: submission.image.bytes,
        });
      }

      // 201 for a report that was stored now, 200 for one that was already
      // here. Both are successes, and a client that retried must not read the
      // second answer as a failure.
      res.status(result.status === 'stored' ? 201 : 200).json({
        reportId: result.report.id,
        hasImage: result.report.hasImage,
        createdAt: result.report.createdAt.toISOString(),
      });
    }),
  );

  app.use(router);
}
