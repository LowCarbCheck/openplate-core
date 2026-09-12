/**
 * What a push IS on this service: a kind, a collapse topic, a TTL and an
 * urgency. Never a sentence.
 *
 * THE SERVER WRITES NO TEXT. The payload below is one field, and
 * `tests/unit/push-payload.test.ts` plus a grep in the milestone's checklist
 * both fail if a title or a body ever appears here. The device wakes, reads the
 * diary only it can read, and writes the words. See
 * `docs/adr/0008-push-is-a-scheduling-exception.md`.
 *
 * THE DELIVERY OPTIONS ARE NOT DECORATION, and every one of them was learned
 * the hard way in the collie project (`bridge/push.ts`), which this module is
 * ported from:
 *
 *  - `topic` is a COLLAPSE KEY. The push service keeps only the latest message
 *    per device per topic, so a phone that was off for a day gets one current
 *    catch-up rather than a burst of stale ones. The two kinds carry DIFFERENT
 *    topics on purpose: sharing one would make a queued catch-up and a fast
 *    target alert silently overwrite each other.
 *  - A topic must be URL-safe base64 characters, at most 32 of them, and a
 *    length base64 can actually produce. Apple DECODES the topic and answers
 *    `400 BadWebPushTopic` for a length that is 1 mod 4, while FCM and Mozilla
 *    treat it as opaque, so the defect is one platform wide and invisible
 *    everywhere else. `topicIsSendable` pins it and its test is the control.
 *  - `TTL` bounds how long the service holds an undelivered message. Six hours
 *    reaches a briefly offline phone and stops a day old catch-up from
 *    resurfacing at teatime.
 *  - `urgency` is load bearing on Android. web-push defaults to `normal`, FCM
 *    maps that to normal priority, and Android may then hold the message until
 *    the next Doze window. The catch-up can wait, so it stays normal; a fast
 *    reaching its target cannot, so it is high.
 *
 * Pure module: no clock, no store, no library. The web-push binding is
 * `push/web-push-sender.ts`, and the sender is injected everywhere else.
 */

/** The two things a push can mean here. The payload carries one of these and nothing else. */
export type PushKind = 'catch-up' | 'fast-target';

/** Every valid {@link PushKind}, for exhaustive iteration in a test. */
export const PUSH_KINDS: readonly PushKind[] = ['catch-up', 'fast-target'];

/**
 * The morning catch-up's collapse topic.
 *
 * THE TRAILING "S" IS NOT A TYPO, and it is the whole reason this constant
 * carries a comment. `openplate-catchup` is 17 characters, and 17 mod 4 is 1,
 * which is a length base64 cannot produce: Apple decodes the topic and answers
 * `400 BadWebPushTopic` for every iPhone endpoint, while FCM and Mozilla accept
 * it happily, so the bug would be invisible on every device an author is likely
 * to test with. `openplate-catchups` is 18, and 18 mod 4 is 2. The milestone
 * spec named the 17 character form and called it 16; it is wrong, and this is
 * the correction. Collie hit the identical defect with `collie-update`.
 */
export const CATCH_UP_TOPIC = 'openplate-catchups';

/** The fast target alert's own topic, deliberately not shared with the catch-up. 14 characters, 14 mod 4 is 2. */
export const FAST_TARGET_TOPIC = 'openplate-fast';

/** Six hours, in seconds. Long enough for a briefly offline phone, short enough that yesterday stays yesterday. */
export const PUSH_TTL_SECONDS = 21_600;

/** RFC 8030's urgency levels, restated so the options below need no library type. */
export type PushUrgency = 'very-low' | 'low' | 'normal' | 'high';

/** The delivery options one send carries. Structurally what `web-push` accepts, named here so no fake imports it. */
export interface PushSendOptions {
  TTL: number;
  topic: string;
  urgency: PushUrgency;
}

/**
 * The options for a kind. A FUNCTION RATHER THAN A MAP LITERAL so the return is
 * a fresh object per send: `web-push` is handed this directly, and a shared
 * mutable object is a thing a library can keep.
 */
export function sendOptionsFor(kind: PushKind): PushSendOptions {
  if (kind === 'catch-up') {
    return { TTL: PUSH_TTL_SECONDS, topic: CATCH_UP_TOPIC, urgency: 'normal' };
  }
  return { TTL: PUSH_TTL_SECONDS, topic: FAST_TARGET_TOPIC, urgency: 'high' };
}

/**
 * Whether a collapse topic is one EVERY push service will accept: RFC 8030's
 * alphabet, its 32 character ceiling, and a length base64 can produce.
 *
 * Exported for the test that guards the two constants above. A topic edited for
 * wording would otherwise break Apple delivery silently, since nothing surfaces
 * it but the push service's own log.
 */
export function topicIsSendable(topic: string): boolean {
  return /^[A-Za-z0-9_-]+$/.test(topic) && topic.length <= 32 && topic.length % 4 !== 1;
}

/** Where one device is reachable, and the two keys web push encrypts to. Never returned by a route, never logged. */
export interface PushEndpointCredential {
  endpoint: string;
  keys: { p256dh: string; auth: string };
}

/** What a delivery answers with. Nothing on the send path reads it: a FAILED delivery throws, and that is the outcome. */
export type PushDeliveryResult = { statusCode?: number } | void;

/**
 * Delivers one payload to one device.
 *
 * INJECTED EVERYWHERE, exactly as collie does it, so the prune and the cap are
 * testable without a push service and without a network.
 */
export type PushSender = (
  credential: PushEndpointCredential,
  payload: string,
  options: PushSendOptions,
) => Promise<PushDeliveryResult>;

/** The whole payload. One field. See the module header. */
export function pushPayload(kind: PushKind): string {
  return JSON.stringify({ kind });
}

/** The HTTP status a `web-push` rejection carries, or `null` when it carries none. */
export function sendErrorStatus(cause: unknown): number | null {
  if (cause === null || cause === undefined || !(cause instanceof Object) || !('statusCode' in cause)) return null;
  const status = cause.statusCode;
  // SAFETY: `statusCode` on a `WebPushError` is the upstream HTTP status. The
  // `Number` round trip decodes it without inspecting a representation, and a
  // value that is not a number lands on `NaN` and is rejected here.
  const decoded = Number(status);
  return Number.isInteger(decoded) ? decoded : null;
}

/**
 * The two statuses RFC 8030 blesses as "this subscription is gone".
 *
 * EVERYTHING ELSE IS TRANSIENT OR ABOUT THE SENDER. A 400, a 401, a 403, a 429
 * and every 5xx must never prune on sight: a VAPID key slip makes a whole push
 * service reject perfectly live devices, and a prune on that would delete every
 * subscription on the instance in one tick.
 */
export function isGoneStatus(status: number | null): boolean {
  return status === 404 || status === 410;
}

/**
 * What actually went wrong, for the log.
 *
 * `web-push` throws a `WebPushError` whose message is the constant "Received
 * unexpected response code", which is useless on its own, while the status and
 * the service's own reason (Apple's `{"reason":"BadDeviceToken"}`, FCM's text)
 * sit unread on the error. Surfacing them is what makes a transient 5xx
 * distinguishable from a permanent rejection.
 *
 * IT NAMES NO ENDPOINT AND NO ACCOUNT. The caller logs a count and this
 * sentence; see `server/register-push-routes.ts` on the same rule for the
 * routes.
 */
export function describeSendError(cause: unknown): string {
  const message = cause instanceof Error ? cause.message : 'unknown push error';
  const status = sendErrorStatus(cause);
  return status === null ? message : `${message} status=${status}`;
}
