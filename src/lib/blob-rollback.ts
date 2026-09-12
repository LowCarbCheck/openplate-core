/**
 * The rollback decision, as pure arithmetic (M224).
 *
 * ── WHY A RESTORE IS A ROLLBACK AND NOT A RE-UPLOAD ─────────────────────────
 *
 * The envelope binds `{accountId, blobVersion, payloadSchemaVersion}` into the
 * AAD (`PROTOCOL.md` §3.2). Re-inserting an old ciphertext as a NEW version
 * therefore produces bytes whose AAD names a version they were not sealed
 * under, and no client can ever decrypt them: the restore would look like it
 * worked and would have destroyed the last readable copy. So the only correct
 * restore is to DELETE the later rows, leaving the good version as the maximum
 * it already claims to be.
 *
 * ── WHAT IT REFUSES ─────────────────────────────────────────────────────────
 *
 * This service cannot read a blob and so cannot promise one decrypts. What it
 * CAN refuse is every state it can see is broken: no blob at all, a version
 * that is not there, a target that is already current, an envelope framing this
 * build does not accept, and a zero-byte row. An operator running this against
 * somebody's only copy gets a refusal rather than an empty account.
 *
 * PURE AND TOTAL. The store (`db/blob-rollback-store.ts`) runs it inside the
 * transaction that then does the delete, so the rows it judged and the rows it
 * deletes are the same rows.
 */
import { ENVELOPE_VERSION } from '../protocol.js';

/** One retained version, as an operator and this decision both need to see it. Never the ciphertext. */
export interface BlobVersionSummary {
  blobVersion: number;
  envelopeVersion: number;
  sizeBytes: number;
  createdAt: Date;
  /** Non-`null` while this version is held as the copy before an acknowledged shrink. */
  pinnedUntil: Date | null;
}

/** Why a rollback was refused. Codes, turned into sentences once, at the route. */
export type RollbackRefusal =
  /** The account has never pushed a blob, so there is nothing to roll back. */
  | 'no-blob'
  /** No retained version carries that number. It may have been pruned. */
  | 'unknown-version'
  /** That version is already the current one. Nothing to delete, and nothing to do. */
  | 'already-current'
  /** The target was framed by an envelope version this build does not accept; no client could read it. */
  | 'unreadable-envelope'
  /** The target row holds no bytes. Restoring it would make the account's current version undecryptable. */
  | 'empty-ciphertext';

export type RollbackPlan =
  | { ok: true; targetVersion: number; discardedVersions: number[] }
  | { ok: false; reason: RollbackRefusal };

/**
 * What rolling `versions` back to `targetVersion` would delete, or why it may
 * not happen.
 *
 * `discardedVersions` is every version strictly above the target, which is by
 * construction non-empty: `already-current` is refused above, so a plan that
 * deleted nothing cannot be returned as success. An operator reading "rolled
 * back, 0 versions removed" would have no way to tell it from a no-op.
 */
export function planBlobRollback(input: {
  versions: readonly BlobVersionSummary[];
  targetVersion: number;
}): RollbackPlan {
  if (input.versions.length === 0) return { ok: false, reason: 'no-blob' };

  const target = input.versions.find((version) => version.blobVersion === input.targetVersion);
  if (target === undefined) return { ok: false, reason: 'unknown-version' };

  const currentVersion = Math.max(...input.versions.map((version) => version.blobVersion));
  if (target.blobVersion === currentVersion) return { ok: false, reason: 'already-current' };

  // The two "would this leave the account unreadable" checks. Both are about
  // the TARGET, because after the delete the target is what every client pulls.
  if (target.envelopeVersion !== ENVELOPE_VERSION) return { ok: false, reason: 'unreadable-envelope' };
  if (target.sizeBytes <= 0) return { ok: false, reason: 'empty-ciphertext' };

  const discardedVersions = input.versions
    .filter((version) => version.blobVersion > target.blobVersion)
    .map((version) => version.blobVersion)
    .toSorted((left, right) => left - right);
  return { ok: true, targetVersion: target.blobVersion, discardedVersions };
}
