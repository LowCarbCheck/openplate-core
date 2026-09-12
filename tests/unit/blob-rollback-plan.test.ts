/**
 * What a rollback deletes, and the five states it refuses (M224, ADR-0009).
 *
 * The refusals are the reason this is a pure function with its own test. An
 * operator runs a rollback once, in an incident, against the only copy of
 * somebody's diary, and the failure mode that matters is a restore that
 * "worked" and left an account nothing can decrypt.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { planBlobRollback, type BlobVersionSummary } from '../../src/lib/blob-rollback.js';
import { ENVELOPE_VERSION } from '../../src/protocol.js';

const CREATED = new Date('2026-09-12T10:00:00.000Z');

function summary(input: Partial<BlobVersionSummary> & { blobVersion: number }): BlobVersionSummary {
  return {
    blobVersion: input.blobVersion,
    envelopeVersion: input.envelopeVersion ?? ENVELOPE_VERSION,
    sizeBytes: input.sizeBytes ?? 5310,
    createdAt: input.createdAt ?? CREATED,
    pinnedUntil: input.pinnedUntil ?? null,
  };
}

/** The incident: four good versions, then the wipe, then a second device's copy of the wipe. */
const AFTER_A_WIPE: BlobVersionSummary[] = [
  summary({ blobVersion: 6, sizeBytes: 1588 }),
  summary({ blobVersion: 5, sizeBytes: 1588 }),
  summary({ blobVersion: 4, sizeBytes: 5310, pinnedUntil: new Date('2026-09-26T10:00:00.000Z') }),
  summary({ blobVersion: 3, sizeBytes: 5280 }),
];

test('rolling back to the pinned pre-wipe version discards exactly the versions above it', () => {
  const plan = planBlobRollback({ versions: AFTER_A_WIPE, targetVersion: 4 });
  assert.deepEqual(plan, { ok: true, targetVersion: 4, discardedVersions: [5, 6] });
});

test('an account that has never pushed is refused, not treated as an empty rollback', () => {
  assert.deepEqual(planBlobRollback({ versions: [], targetVersion: 1 }), { ok: false, reason: 'no-blob' });
});

test('a version the service no longer holds is refused by number, never by silence', () => {
  assert.deepEqual(planBlobRollback({ versions: AFTER_A_WIPE, targetVersion: 2 }), {
    ok: false,
    reason: 'unknown-version',
  });
  // Above the current one too: a rollback forwards is not a rollback.
  assert.deepEqual(planBlobRollback({ versions: AFTER_A_WIPE, targetVersion: 9 }), {
    ok: false,
    reason: 'unknown-version',
  });
});

test('rolling back to the version that is already current is refused rather than reported as a no-op', () => {
  assert.deepEqual(planBlobRollback({ versions: AFTER_A_WIPE, targetVersion: 6 }), {
    ok: false,
    reason: 'already-current',
  });
});

test('a target framed by an envelope version this build does not accept is refused', () => {
  const versions = [summary({ blobVersion: 3 }), summary({ blobVersion: 2, envelopeVersion: ENVELOPE_VERSION + 1 })];
  assert.deepEqual(planBlobRollback({ versions, targetVersion: 2 }), { ok: false, reason: 'unreadable-envelope' });
});

test('a zero-byte target is refused: restoring it would leave the account unreadable', () => {
  const versions = [summary({ blobVersion: 3 }), summary({ blobVersion: 2, sizeBytes: 0 })];
  assert.deepEqual(planBlobRollback({ versions, targetVersion: 2 }), { ok: false, reason: 'empty-ciphertext' });
});

test('a successful plan never discards nothing, so "rolled back" can never mean "did nothing"', () => {
  const plan = planBlobRollback({ versions: AFTER_A_WIPE, targetVersion: 3 });
  assert.equal(plan.ok, true);
  if (!plan.ok) return;
  assert.deepEqual(plan.discardedVersions, [4, 5, 6]);
  assert.notEqual(plan.discardedVersions.length, 0);
});
