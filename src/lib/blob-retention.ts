/**
 * The blob safety net, as pure arithmetic (M224).
 *
 * Two rules live here, and they are the two halves of one incident. A client
 * whose local diary had been evicted by the browser compared an intact sync
 * baseline against an empty store, concluded the person had deleted every
 * entry, and pushed a tombstone for each one. The blob went from 5310 bytes to
 * 1588 in a single accepted write, and a second device then pulled that blob
 * and deleted its own rows.
 *
 *  - {@link isLargeShrink} is the REFUSAL's predicate: a push under half of
 *    what is stored must say it means it. The server cannot tell a real
 *    deletion from that one, and it does not try; it asks.
 *  - {@link selectPrunableBlobIds} is the RECOVERY: what the service keeps, so
 *    that an operator asked about it a week later still has something to roll
 *    back to. The only reason the M224 user's diary was recoverable at all is
 *    that her pre-wipe version happened to still be inside a five-version
 *    window that two devices can burn through in a minute.
 *
 * PURE, TOTAL, AND CLOCK-INJECTED. Both are decisions, and a decision that
 * reads `Date.now()` or a database cannot be tested at the boundaries where it
 * matters. The adapter (`db/storage-adapter.ts`) does the reading and the
 * deleting; nothing here touches either.
 *
 * See `docs/adr/0009-a-shrinking-blob-is-acknowledged-or-refused.md`.
 */
import {
  BLOB_DAILY_RETENTION_DAYS,
  BLOB_PRE_SHRINK_PIN_DAYS,
  BLOB_PRE_SHRINK_PIN_LIMIT,
  BLOB_SHRINK_ACK_RATIO,
  BLOB_VERSION_RETENTION,
} from '../protocol.js';
import { utcDayKey } from './utc-day.js';

const MILLISECONDS_PER_DAY = 24 * 60 * 60 * 1000;

/**
 * Whether this push would replace the stored blob with one under
 * {@link BLOB_SHRINK_ACK_RATIO} of its size.
 *
 * IT ANSWERS ONE QUESTION AND TAKES NO POSITION ON THE ACKNOWLEDGEMENT. What
 * to do about a large shrink is policy and lives in `server/push-handler.ts`,
 * in one place, because the same answer drives two different actions there: a
 * refusal when the client said nothing, and a pin when it did.
 *
 * `currentSizeBytes` is `0` for an account with no blob at all, and the answer
 * there is always `false`: there is nothing to lose yet, and a first push is
 * not a deletion.
 *
 * STRICTLY BELOW THE LINE. A push at exactly half is not a large shrink, so the
 * boundary is stated once here rather than implied by a comparison somewhere
 * else.
 */
export function isLargeShrink(input: { currentSizeBytes: number; nextSizeBytes: number }): boolean {
  if (input.currentSizeBytes <= 0) return false;
  return input.nextSizeBytes < input.currentSizeBytes * BLOB_SHRINK_ACK_RATIO;
}

/** When a pin taken now runs out. Named so the handler and the tests cannot state the fortnight twice. */
export function preShrinkPinExpiry(now: Date): Date {
  return new Date(now.getTime() + BLOB_PRE_SHRINK_PIN_DAYS * MILLISECONDS_PER_DAY);
}

/** One retained blob version, as the pruner needs to see it. No ciphertext: this decision never reads the bytes. */
export interface RetainedBlobVersion {
  id: number;
  blobVersion: number;
  createdAt: Date;
  /** Non-`null` while this version is held as the copy before an acknowledged shrink. */
  pinnedUntil: Date | null;
}

/**
 * Which rows may be deleted, given every retained version of ONE account.
 *
 * Three tiers, kept TOGETHER rather than in sequence, because a row kept by any
 * one of them is kept:
 *
 *  1. the newest {@link BLOB_VERSION_RETENTION} versions, as before M224;
 *  2. the newest version of each of the last {@link BLOB_DAILY_RETENTION_DAYS}
 *     UTC calendar days, at most one per day;
 *  3. the newest {@link BLOB_PRE_SHRINK_PIN_LIMIT} versions whose `pinnedUntil`
 *     is still in the future.
 *
 * WHY THE DAILY TIER IS PER CALENDAR DAY AND NOT PER COUNT. Two devices
 * fighting each other produce versions as fast as the network allows, and any
 * count-based tier is exhausted by that in minutes. A day is a bucket a loop
 * cannot widen, so tier 2 can never hold more than
 * {@link BLOB_DAILY_RETENTION_DAYS} rows however hard a client pushes.
 *
 * WHY THE PIN TIER IS CAPPED. A pin is taken on a client's own say-so, and an
 * uncapped promise made on somebody else's say-so is not a bound. Past the cap
 * the oldest pins become prunable again, so the whole rule keeps at most
 * `5 + 14 + 14 = 33` versions per account.
 *
 * Returns ids in no particular order; the caller deletes them in one statement.
 */
export function selectPrunableBlobIds(input: { versions: readonly RetainedBlobVersion[]; now: Date }): number[] {
  // Newest first, so "the newest N" and "the newest of each day" are both a
  // first-wins walk rather than a second sort.
  const newestFirst = input.versions.toSorted((left, right) => right.blobVersion - left.blobVersion);
  const keep = new Set<number>();

  for (const version of newestFirst.slice(0, BLOB_VERSION_RETENTION)) keep.add(version.id);

  const oldestKeptDay = utcDayKey(new Date(input.now.getTime() - BLOB_DAILY_RETENTION_DAYS * MILLISECONDS_PER_DAY));
  const daysTaken = new Set<string>();
  for (const version of newestFirst) {
    // THE HARD CAP, and it is checked first. The window spans fifteen day
    // boundaries, not fourteen, and a clock skew can put a row on a
    // sixteenth; the promise is "at most fourteen extra blobs", so the count
    // is what bounds this tier rather than the arithmetic that produced it.
    if (daysTaken.size >= BLOB_DAILY_RETENTION_DAYS) break;
    const day = utcDayKey(version.createdAt);
    // Older than the window. Not `break`: rows are ordered by version, and a
    // clock that moved backwards would otherwise end the walk early.
    if (day < oldestKeptDay) continue;
    if (daysTaken.has(day)) continue;
    daysTaken.add(day);
    keep.add(version.id);
  }

  const livePins = newestFirst.filter((version) => version.pinnedUntil !== null && version.pinnedUntil > input.now);
  for (const version of livePins.slice(0, BLOB_PRE_SHRINK_PIN_LIMIT)) keep.add(version.id);

  return newestFirst.filter((version) => !keep.has(version.id)).map((version) => version.id);
}
