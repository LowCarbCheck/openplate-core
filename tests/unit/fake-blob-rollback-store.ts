/**
 * In-memory `SyncBlobRollbackStore` for the admin-route tests (M224).
 *
 * It runs the REAL planner (`lib/blob-rollback.ts`) over seeded rows, so the
 * refusals a route test observes are the refusals the service makes rather than
 * a second implementation of the same list agreeing with itself.
 */
import type { RollbackBlobResult, SyncBlobRollbackStore } from '../../src/contract-types.js';
import { planBlobRollback, type BlobVersionSummary } from '../../src/lib/blob-rollback.js';

export interface FakeBlobRollbackStore extends SyncBlobRollbackStore {
  /** Replaces every retained version of one account. Newest first is not required; the store sorts. */
  seedVersions(accountId: number, versions: BlobVersionSummary[]): void;
}

export function createFakeBlobRollbackStore(): FakeBlobRollbackStore {
  const versionsByAccount = new Map<number, BlobVersionSummary[]>();

  function read(accountId: number): BlobVersionSummary[] {
    return (versionsByAccount.get(accountId) ?? []).toSorted((left, right) => right.blobVersion - left.blobVersion);
  }

  return {
    seedVersions(accountId: number, versions: BlobVersionSummary[]): void {
      versionsByAccount.set(accountId, versions);
    },

    async listBlobVersions(accountId: number): Promise<BlobVersionSummary[]> {
      return read(accountId);
    },

    async rollbackToVersion(input): Promise<RollbackBlobResult> {
      const plan = planBlobRollback({ versions: read(input.accountId), targetVersion: input.targetVersion });
      if (!plan.ok) return plan;
      versionsByAccount.set(
        input.accountId,
        read(input.accountId).filter((version) => version.blobVersion <= plan.targetVersion),
      );
      return { ok: true, blobVersion: plan.targetVersion, discardedVersions: plan.discardedVersions };
    },
  };
}
