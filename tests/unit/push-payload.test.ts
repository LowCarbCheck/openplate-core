/**
 * A push carries a kind, and a collapse topic every push service will accept.
 *
 * ── THE PAYLOAD ─────────────────────────────────────────────────────────────
 * The server writes no text. That is the principle the whole feature is bounded
 * by (ADR-0008), and it is one that erodes by accident: a title is a very small
 * thing to add and it would put diary content, written by a party that cannot
 * read the diary, into a payload that crosses a third party's servers. So the
 * payload is asserted byte for byte and its key set is asserted as a whole,
 * which is what fails when somebody adds a field rather than replaces one.
 *
 * ── THE TOPICS ──────────────────────────────────────────────────────────────
 * `topicIsSendable` is ported from collie, where the constraint was measured
 * rather than inferred: Apple DECODES the collapse topic as URL-safe base64 and
 * answers `400 BadWebPushTopic` for a length that is 1 mod 4, while FCM and
 * Mozilla treat it as opaque. A topic edited for tidiness therefore breaks
 * delivery on one platform and nowhere else, and nothing surfaces it but the
 * push service's own log.
 *
 * The helper's own test is here too, both sides of it, because a predicate that
 * answered `true` for everything would bless the constants above silently.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  CATCH_UP_TOPIC,
  FAST_TARGET_TOPIC,
  PUSH_KINDS,
  PUSH_TTL_SECONDS,
  pushPayload,
  sendOptionsFor,
  topicIsSendable,
} from '../../src/push/send.js';
import { asObject, type JsonValue } from '../../src/lib/json.js';

test('the payload is one field, and that field is the kind', () => {
  assert.equal(pushPayload('catch-up'), '{"kind":"catch-up"}');
  assert.equal(pushPayload('fast-target'), '{"kind":"fast-target"}');

  for (const kind of PUSH_KINDS) {
    // SAFETY: the string came out of `JSON.stringify` one line above, so it
    // parses; the assertion widens the result to the boundary type
    // `lib/json.ts` decodes, and `asObject` is TOTAL over it.
    const decoded = asObject(JSON.parse(pushPayload(kind)) as JsonValue);
    // THE KEY SET AS A WHOLE, so an ADDED field fails rather than an assertion
    // about one absent name that somebody would have to have thought of.
    assert.deepEqual(Object.keys(decoded ?? {}), ['kind']);
  }
});

test('both topics are ones every push service accepts', () => {
  assert.ok(topicIsSendable(CATCH_UP_TOPIC), `${CATCH_UP_TOPIC} (${CATCH_UP_TOPIC.length}) must be sendable`);
  assert.ok(topicIsSendable(FAST_TARGET_TOPIC), `${FAST_TARGET_TOPIC} (${FAST_TARGET_TOPIC.length}) must be sendable`);
  assert.notEqual(CATCH_UP_TOPIC, FAST_TARGET_TOPIC, 'sharing a topic would let the two kinds overwrite each other');
});

test('the helper refuses the lengths Apple refuses, which is what makes the case above mean anything', () => {
  // 1 mod 4 is a length base64 cannot produce, and it is the measured failure:
  // collie's `collie-update` (13) was rejected by APNs for every endpoint while
  // `collie-updat` (12) and `collie-updates` (14) both worked.
  assert.equal(topicIsSendable('a'.repeat(13)), false);
  assert.equal(topicIsSendable('openplate-catchup'), false, 'the 17 character form the spec named is 1 mod 4');
  assert.equal(topicIsSendable('a'.repeat(12)), true);
  assert.equal(topicIsSendable('a'.repeat(14)), true);
  // RFC 8030's alphabet and its 32 character ceiling.
  assert.equal(topicIsSendable('openplate catchup'), false, 'a space is outside the alphabet');
  assert.equal(topicIsSendable('openplate/catchup'), false, 'and so is a slash');
  assert.equal(topicIsSendable('a'.repeat(36)), false, 'over the 32 character ceiling');
  assert.equal(topicIsSendable(''), false, 'and an empty topic is not a topic');
});

test('the two kinds carry their own topic and their own urgency', () => {
  const catchUp = sendOptionsFor('catch-up');
  const fastTarget = sendOptionsFor('fast-target');

  assert.deepEqual(catchUp, { TTL: PUSH_TTL_SECONDS, topic: CATCH_UP_TOPIC, urgency: 'normal' });
  // HIGH IS LOAD BEARING ON ANDROID: web-push defaults to normal, FCM maps that
  // to normal priority, and Android may hold the message until the next Doze
  // window. A fast reaching its target cannot wait for that; a catch-up can.
  assert.deepEqual(fastTarget, { TTL: PUSH_TTL_SECONDS, topic: FAST_TARGET_TOPIC, urgency: 'high' });
  assert.equal(PUSH_TTL_SECONDS, 21_600, 'six hours, so yesterday stays yesterday');
});

test('a fresh options object per send, so a library cannot keep a shared one', () => {
  assert.notEqual(sendOptionsFor('catch-up'), sendOptionsFor('catch-up'));
});
