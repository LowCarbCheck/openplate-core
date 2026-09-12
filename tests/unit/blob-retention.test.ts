/**
 * The two pure rules of M224: what counts as a large shrink, and what the
 * retention sweep keeps.
 *
 * WHY IT IS A UNIT TEST AND NOT A DATABASE ONE. Every boundary here is
 * arithmetic on a size, a version number and a calendar day, and the cases that
 * matter are exactly the ones a database test cannot reach cheaply: a clock
 * fourteen days on, a thousand versions in an hour, a pin that has expired.
 * `tests/integration/blob-shrink-and-rollback.test.ts` proves the same rules
 * reach real rows.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  isLargeShrink,
  preShrinkPinExpiry,
  selectPrunableBlobIds,
  type RetainedBlobVersion,
} from '../../src/lib/blob-retention.js';
import {
  BLOB_DAILY_RETENTION_DAYS,
  BLOB_PRE_SHRINK_PIN_LIMIT,
  BLOB_VERSION_RETENTION,
} from '../../src/protocol.js';

const NOW = new Date('2026-09-12T12:00:00.000Z');
const DAY_MS = 24 * 60 * 60 * 1000;

function daysBefore(days: number): Date {
  return new Date(NOW.getTime() - days * DAY_MS);
}

/** A version row. `createdAt` defaults to "now", which is where a burst of pushes lands. */
function version(input: {
  id: number;
  blobVersion: number;
  createdAt?: Date;
  pinnedUntil?: Date | null;
}): RetainedBlobVersion {
  return {
    id: input.id,
    blobVersion: input.blobVersion,
    createdAt: input.createdAt ?? NOW,
    pinnedUntil: input.pinnedUntil ?? null,
  };
}

// ---------------------------------------------------------------------------
// The shrink predicate
// ---------------------------------------------------------------------------

test('the M224 incident shape is a large shrink: 5310 bytes replaced by 1588', () => {
  assert.equal(isLargeShrink({ currentSizeBytes: 5310, nextSizeBytes: 1588 }), true);
});

test('ordinary editing is not a large shrink, whichever direction it goes', () => {
  assert.equal(isLargeShrink({ currentSizeBytes: 5310, nextSizeBytes: 5200 }), false);
  assert.equal(isLargeShrink({ currentSizeBytes: 5310, nextSizeBytes: 5400 }), false);
  // A month deleted out of two years is a few percent, and must never fire.
  assert.equal(isLargeShrink({ currentSizeBytes: 100_000, nextSizeBytes: 96_000 }), false);
});

test('the boundary is strictly below half: exactly half is not a large shrink, one byte under is', () => {
  assert.equal(isLargeShrink({ currentSizeBytes: 1000, nextSizeBytes: 500 }), false);
  assert.equal(isLargeShrink({ currentSizeBytes: 1000, nextSizeBytes: 499 }), true);
});

test('an account with no blob yet can never be shrinking: a first push is not a deletion', () => {
  assert.equal(isLargeShrink({ currentSizeBytes: 0, nextSizeBytes: 1 }), false);
});

test('a pin runs for a fortnight from the instant it was taken', () => {
  assert.equal(preShrinkPinExpiry(NOW).getTime() - NOW.getTime(), 14 * DAY_MS);
});

// ---------------------------------------------------------------------------
// The sweep
// ---------------------------------------------------------------------------

test('the recent tier keeps the newest five and prunes what is under them', () => {
  // Seven versions, all written today, so the daily tier can only hold the
  // newest one and the recent tier is doing all the work.
  const versions = [1, 2, 3, 4, 5, 6, 7].map((n) => version({ id: n, blobVersion: n }));
  const pruned = selectPrunableBlobIds({ versions, now: NOW });
  assert.deepEqual(pruned.toSorted((a, b) => a - b), [1, 2]);
  assert.equal(versions.length - pruned.length, BLOB_VERSION_RETENTION);
});

test('the daily tier keeps one version per calendar day, and it is the newest of that day', () => {
  const versions = [
    // Today, five pushes, which exhausts the recent tier on its own. Without
    // them the tier would hold every row below and prove nothing.
    ...[26, 27, 28, 29, 30].map((n) => version({ id: n, blobVersion: n })),
    // Three days back, two pushes. Only the newer one survives.
    version({ id: 21, blobVersion: 21, createdAt: new Date(daysBefore(3).getTime() + 3600_000) }),
    version({ id: 20, blobVersion: 20, createdAt: daysBefore(3) }),
  ];
  const pruned = selectPrunableBlobIds({ versions, now: NOW });
  assert.deepEqual(pruned, [20], 'the older of the two versions written that day is prunable');
});

test('a version older than the daily window is pruned once the recent tier no longer covers it', () => {
  const versions = [
    ...[10, 11, 12, 13, 14].map((n) => version({ id: n, blobVersion: n })),
    version({ id: 1, blobVersion: 1, createdAt: daysBefore(BLOB_DAILY_RETENTION_DAYS + 3) }),
  ];
  assert.deepEqual(selectPrunableBlobIds({ versions, now: NOW }), [1]);
});

test('a live pin survives a sweep the recent and daily tiers would both have pruned it in', () => {
  // Ten versions, all written today, so only the newest five and the newest of
  // the day are kept. Version 2 is neither — the pin is the only thing holding it.
  const versions = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map((n) =>
    version({ id: n, blobVersion: n, pinnedUntil: n === 2 ? preShrinkPinExpiry(NOW) : null }),
  );
  const pruned = selectPrunableBlobIds({ versions, now: NOW });
  assert.equal(pruned.includes(2), false, 'the pinned pre-shrink version must survive');
  assert.deepEqual(pruned.toSorted((a, b) => a - b), [1, 3, 4, 5]);
});

test('an EXPIRED pin holds nothing: the fortnight is a window, not a permanent exemption', () => {
  const versions = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map((n) =>
    version({ id: n, blobVersion: n, pinnedUntil: n === 2 ? daysBefore(1) : null }),
  );
  assert.equal(selectPrunableBlobIds({ versions, now: NOW }).includes(2), true);
});

test('pins are capped: past the limit the oldest of them become prunable again', () => {
  // Twenty pinned versions, every one live. Only the newest fourteen may be
  // held by the pin tier; the rest fall back to the other two tiers, which
  // cover the newest five.
  const versions = Array.from({ length: 20 }, (_unused, index) =>
    version({ id: index + 1, blobVersion: index + 1, pinnedUntil: preShrinkPinExpiry(NOW) }),
  );
  const pruned = selectPrunableBlobIds({ versions, now: NOW });
  assert.equal(pruned.length, 20 - BLOB_PRE_SHRINK_PIN_LIMIT, 'six of the twenty are past the pin cap');
  assert.deepEqual(pruned.toSorted((a, b) => a - b), [1, 2, 3, 4, 5, 6]);
});

test('a push loop cannot reach past the daily tier: a thousand versions in one hour keep five', () => {
  const versions = Array.from({ length: 1000 }, (_unused, index) =>
    version({ id: index + 1, blobVersion: index + 1, createdAt: new Date(NOW.getTime() - index * 1000) }),
  );
  const kept = 1000 - selectPrunableBlobIds({ versions, now: NOW }).length;
  // Five from the recent tier, one from today's daily slot, and that slot is
  // inside the five. One day of fighting devices costs one day of history.
  assert.equal(kept, BLOB_VERSION_RETENTION);
});

test('the worst case is bounded by the three caps together, whatever the input', () => {
  // One version per hour for sixty days, every one of them pinned: the most
  // hostile shape the rule can be handed.
  const versions = Array.from({ length: 60 * 24 }, (_unused, index) =>
    version({
      id: index + 1,
      blobVersion: index + 1,
      createdAt: new Date(NOW.getTime() - index * 3600_000),
      pinnedUntil: preShrinkPinExpiry(NOW),
    }),
  );
  const kept = versions.length - selectPrunableBlobIds({ versions, now: NOW }).length;
  assert.ok(
    kept <= BLOB_VERSION_RETENTION + BLOB_DAILY_RETENTION_DAYS + BLOB_PRE_SHRINK_PIN_LIMIT,
    `kept ${kept}, which is over the 33-version bound ADR-0009 commits to`,
  );
});
