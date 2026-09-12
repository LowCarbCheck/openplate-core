/**
 * Push-blob handler core (design spec D3/D4) — CAS write. Separated from the
 * Express glue (`register-routes.ts`) so it's unit-testable against a fake
 * `SyncStorageAdapter`, with no HTTP server involved.
 *
 * ── THE SHRINK GUARD (M224) ─────────────────────────────────────────────────
 *
 * This handler gained the one judgement this service makes about a payload it
 * cannot read: a push whose ciphertext is under half of what is stored is
 * REFUSED unless the client says it means it. A person lost her whole diary to
 * a client that compared an intact sync baseline against an IndexedDB the
 * browser had evicted, concluded every entry was deleted, and pushed a
 * tombstone for each one. A client fix protects nobody who has not updated, and
 * an installed progressive web app cannot be made to update.
 *
 * The guard reads `size_bytes`, which this service already stores and already
 * reports for quotas, so it discloses nothing new. What it costs is written
 * down in `docs/adr/0009-a-shrinking-blob-is-acknowledged-or-refused.md`: a
 * legitimate large deletion from an old client is refused until that client is
 * updated, and the person sees a sync error instead. An error beats a loss.
 */
import type { SyncStorageAdapter } from '../contract-types.js';
import { isLargeShrink, preShrinkPinExpiry } from '../lib/blob-retention.js';

export interface PushBlobInput {
  accountId: number;
  baseVersion: number;
  envelopeVersion: number;
  ciphertext: Uint8Array;
  /**
   * Whether the client takes responsibility for a large deletion, see
   * `PushBlobRequest.shrinkAcknowledged`. Required HERE and optional on the
   * wire: the route turns an absent field into `false` once, so no branch below
   * can treat "did not say" as anything other than "no".
   */
  shrinkAcknowledged: boolean;
  /** Injected, like every clock in this repo. Only read when a pin is taken. */
  now: Date;
}

export type PushBlobResult =
  | { status: 'accepted'; newVersion: number }
  | { status: 'conflict'; currentVersion: number }
  | { status: 'invalid'; reason: string }
  /** A large shrink nobody acknowledged. Nothing was written, and the stored version is untouched. */
  | { status: 'shrink-refused'; currentSizeBytes: number; nextSizeBytes: number };

/** Validates the request shape, then attempts the CAS write. Never throws — every failure is a typed result. */
export async function handlePushBlob(input: PushBlobInput, storage: SyncStorageAdapter): Promise<PushBlobResult> {
  if (!Number.isInteger(input.baseVersion) || input.baseVersion < 0) {
    return { status: 'invalid', reason: 'baseVersion must be a non-negative integer' };
  }
  if (!Number.isInteger(input.envelopeVersion) || input.envelopeVersion < 1) {
    return { status: 'invalid', reason: 'envelopeVersion must be a positive integer' };
  }
  if (input.ciphertext.byteLength === 0) {
    return { status: 'invalid', reason: 'ciphertext must not be empty' };
  }

  // Two lengths and a version, never the stored bytes, see `SyncBlobMeta`.
  const stored = await storage.getBlobMeta(input.accountId);
  const currentSizeBytes = stored?.sizeBytes ?? 0;
  const nextSizeBytes = input.ciphertext.byteLength;

  // THE CAS COMES FIRST, AND THE ORDER IS A DECISION.
  //
  // A push off a stale `baseVersion` writes nothing whichever way this goes, so
  // nothing is lost by letting the conflict win. What IS lost by refusing it as
  // a shrink is the truth: the client is behind, and PROTOCOL.md §5.1 obliges
  // it to pull, merge and retry. After that merge it is usually not shrinking
  // at all, and telling it to update the app instead would send every ordinary
  // two-device race down the wrong road.
  //
  // So the guard only speaks when the CAS would have won. The adapter below
  // remains the one atomic check; this is a read of the same fact, and it can
  // only be wrong in the direction of asking the guard about a push that then
  // loses its race, which is refused anyway.
  const casWouldWin = (stored?.blobVersion ?? 0) === input.baseVersion;
  const largeShrink = casWouldWin && isLargeShrink({ currentSizeBytes, nextSizeBytes });

  if (largeShrink && !input.shrinkAcknowledged) {
    return { status: 'shrink-refused', currentSizeBytes, nextSizeBytes };
  }

  const result = await storage.putBlobIfVersionMatches({
    accountId: input.accountId,
    baseVersion: input.baseVersion,
    envelopeVersion: input.envelopeVersion,
    ciphertext: input.ciphertext,
    // PINNED ONLY WHEN THE SHRINK WAS BIG ENOUGH TO HAVE BEEN REFUSED. A client
    // that sets the flag on every push therefore pins nothing extra, and the
    // rows held are exactly the ones a person may have to be given back.
    pinPreviousUntil: largeShrink ? preShrinkPinExpiry(input.now) : null,
  });

  return result.ok
    ? { status: 'accepted', newVersion: result.newVersion }
    : { status: 'conflict', currentVersion: result.currentVersion };
}
