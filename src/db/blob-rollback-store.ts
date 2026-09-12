/**
 * The operator's restore path over `sync_blobs` (M224, ADR-0009).
 *
 * ITS OWN STORE, AND THE SEPARATION IS THE POINT. `db/storage-adapter.ts` is
 * what the push and pull routes hold, and nothing on it can delete an accepted
 * write. This can, so only `server/admin-routes.ts` is ever handed one. The
 * discipline is the one `SyncShareStore` follows for the same reason.
 *
 * THE JUDGEMENT AND THE DELETE SHARE A TRANSACTION. `lib/blob-rollback.ts`
 * decides from the rows; those rows are read inside the transaction that then
 * deletes, so a push landing between the two cannot turn "roll back to 4,
 * discarding 5" into "roll back to 4, discarding 5 and the 6 that arrived
 * while you were reading".
 */
import { and, desc, eq, gt } from 'drizzle-orm';
import type { RollbackBlobResult, SyncBlobRollbackStore } from '../contract-types.js';
import { planBlobRollback, type BlobVersionSummary } from '../lib/blob-rollback.js';
import type { Database } from './client.js';
import { syncBlobs } from './schema.js';

export function createDrizzleBlobRollbackStore(db: Database): SyncBlobRollbackStore {
  return {
    async listBlobVersions(accountId: number): Promise<BlobVersionSummary[]> {
      // Four columns and never `ciphertext`: an operator is shown what a
      // version WEIGHS and when it arrived, and the bytes are the data
      // subject's (ADR-0001).
      return db
        .select({
          blobVersion: syncBlobs.blobVersion,
          envelopeVersion: syncBlobs.envelopeVersion,
          sizeBytes: syncBlobs.sizeBytes,
          createdAt: syncBlobs.createdAt,
          pinnedUntil: syncBlobs.pinnedUntil,
        })
        .from(syncBlobs)
        .where(eq(syncBlobs.accountId, accountId))
        .orderBy(desc(syncBlobs.blobVersion));
    },

    async rollbackToVersion(input): Promise<RollbackBlobResult> {
      return db.transaction(async (tx) => {
        const versions = await tx
          .select({
            blobVersion: syncBlobs.blobVersion,
            envelopeVersion: syncBlobs.envelopeVersion,
            sizeBytes: syncBlobs.sizeBytes,
            createdAt: syncBlobs.createdAt,
            pinnedUntil: syncBlobs.pinnedUntil,
          })
          .from(syncBlobs)
          .where(eq(syncBlobs.accountId, input.accountId))
          .orderBy(desc(syncBlobs.blobVersion));

        const plan = planBlobRollback({ versions, targetVersion: input.targetVersion });
        if (!plan.ok) return plan;

        await tx
          .delete(syncBlobs)
          .where(and(eq(syncBlobs.accountId, input.accountId), gt(syncBlobs.blobVersion, plan.targetVersion)));
        return { ok: true, blobVersion: plan.targetVersion, discardedVersions: plan.discardedVersions };
      });
    },
  };
}
