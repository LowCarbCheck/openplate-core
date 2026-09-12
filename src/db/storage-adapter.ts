/**
 * Drizzle-backed `SyncStorageAdapter` — the only module that reads or writes
 * `sync_blobs` / `sync_key_records`.
 *
 * PORTED VERBATIM IN SUBSTANCE from the openplate app's
 * `app/models/sync-storage.server.ts` (M128 spec 02). The concurrency
 * discipline below is security-reviewed and was carried across unchanged; the
 * only differences are the injected `Database` (instead of a module-level
 * singleton) and the account foreign key now pointing at this service's own
 * `accounts` table.
 *
 * CAS concurrency is enforced by a UNIQUE constraint, not by row locking.
 * Every blob write computes `newVersion = currentVersion + 1` and attempts an
 * INSERT of that exact `(accountId, newVersion)` pair. Two concurrent uploads
 * racing the same `baseVersion` can both pass the initial read, but only ONE
 * insert can possibly succeed — the loser hits a Postgres unique violation
 * (23505, caught by `lib/storage-conflict.ts`) and is translated into the
 * same `{ ok: false, currentVersion }` a plain version mismatch would return.
 * This stays correct under READ COMMITTED (Postgres's default) and is simpler
 * than `SELECT ... FOR UPDATE`, with an identical caller-facing contract.
 *
 * The same discipline extends to key records: `expectedUpdatedAt` plays the
 * role `baseVersion` plays for blobs, gated by
 * `sync_key_records_account_kind_idx` — first-time create is an INSERT whose
 * unique violation means conflict; a rotation is an UPDATE gated on an exact
 * `updatedAt` match, where zero rows matched means conflict. A key-record
 * write is never a blind upsert.
 */
import { and, desc, eq, inArray } from 'drizzle-orm';
import type {
  PutBlobResult,
  PutKeyRecordResult,
  SyncBlobMeta,
  SyncBlobRecord,
  SyncKeyRecord,
  SyncStorageAdapter,
} from '../contract-types.js';
import type { SyncKeyRecordKind } from '../protocol.js';
import { selectPrunableBlobIds } from '../lib/blob-retention.js';
import { isUniqueViolation } from '../lib/storage-conflict.js';
import type { Database } from './client.js';
import { syncBlobs, syncKeyRecords } from './schema.js';

type SyncKeyRecordRow = typeof syncKeyRecords.$inferSelect;

function mapKeyRecordRow(row: SyncKeyRecordRow): SyncKeyRecord {
  return {
    accountId: row.accountId,
    kind: row.kind,
    kdfDescriptor: row.kdfDescriptor ?? null,
    wrappedDek: row.wrappedDek,
    updatedAt: row.updatedAt,
  };
}

/**
 * @param clock Injected, like every other clock in this repo, because the
 * retention sweep's daily tier and its pin expiry both key on it and a test
 * that cannot move the clock cannot reach either boundary. The default is the
 * real one.
 */
export function createDrizzleStorageAdapter(db: Database, clock: () => Date = () => new Date()): SyncStorageAdapter {
  async function readCurrentBlobVersion(accountId: number): Promise<number> {
    const [row] = await db
      .select({ blobVersion: syncBlobs.blobVersion })
      .from(syncBlobs)
      .where(eq(syncBlobs.accountId, accountId))
      .orderBy(desc(syncBlobs.blobVersion))
      .limit(1);
    return row?.blobVersion ?? 0;
  }

  /**
   * Deletes every blob version for `accountId` that none of the three
   * retention tiers keeps (M224).
   *
   * THE TIERS ARE NOT DECIDED HERE. `lib/blob-retention.ts` takes the rows and
   * a clock and answers with ids, so the rule that decides whether somebody's
   * last good copy survives is pure and is tested at its boundaries rather
   * than through a database. This function reads, calls, and deletes.
   *
   * The read projects four columns and never `ciphertext`: the sweep runs on
   * every accepted write, and selecting the bytes would put every retained
   * version of a 2 MiB blob in memory to decide which ones to drop.
   */
  async function pruneOldBlobVersions(accountId: number, now: Date): Promise<void> {
    const rows = await db
      .select({
        id: syncBlobs.id,
        blobVersion: syncBlobs.blobVersion,
        createdAt: syncBlobs.createdAt,
        pinnedUntil: syncBlobs.pinnedUntil,
      })
      .from(syncBlobs)
      .where(eq(syncBlobs.accountId, accountId))
      .orderBy(desc(syncBlobs.blobVersion));
    const staleIds = selectPrunableBlobIds({ versions: rows, now });
    if (staleIds.length === 0) return;
    await db.delete(syncBlobs).where(inArray(syncBlobs.id, staleIds));
  }

  /** The current `updatedAt` for `(accountId, kind)`, or `null` when no record exists — reported back to a losing CAS write. */
  async function readCurrentKeyRecordUpdatedAt(accountId: number, kind: SyncKeyRecordKind): Promise<Date | null> {
    const [row] = await db
      .select({ updatedAt: syncKeyRecords.updatedAt })
      .from(syncKeyRecords)
      .where(and(eq(syncKeyRecords.accountId, accountId), eq(syncKeyRecords.kind, kind)));
    return row?.updatedAt ?? null;
  }

  return {
    async getBlobMeta(accountId: number): Promise<SyncBlobMeta | null> {
      const [row] = await db
        .select({ blobVersion: syncBlobs.blobVersion, sizeBytes: syncBlobs.sizeBytes })
        .from(syncBlobs)
        .where(eq(syncBlobs.accountId, accountId))
        .orderBy(desc(syncBlobs.blobVersion))
        .limit(1);
      return row ?? null;
    },

    async getBlob(accountId: number): Promise<SyncBlobRecord | null> {
      const [row] = await db
        .select()
        .from(syncBlobs)
        .where(eq(syncBlobs.accountId, accountId))
        .orderBy(desc(syncBlobs.blobVersion))
        .limit(1);
      if (!row) return null;
      return {
        accountId: row.accountId,
        blobVersion: row.blobVersion,
        envelopeVersion: row.envelopeVersion,
        ciphertext: row.ciphertext,
        createdAt: row.createdAt,
      };
    },

    async putBlobIfVersionMatches(input): Promise<PutBlobResult> {
      const currentVersion = await readCurrentBlobVersion(input.accountId);
      if (currentVersion !== input.baseVersion) {
        return { ok: false, currentVersion };
      }

      const newVersion = currentVersion + 1;
      try {
        await db.insert(syncBlobs).values({
          accountId: input.accountId,
          blobVersion: newVersion,
          envelopeVersion: input.envelopeVersion,
          ciphertext: Buffer.from(input.ciphertext),
          sizeBytes: input.ciphertext.byteLength,
        });
      } catch (error) {
        if (!isUniqueViolation(error)) throw error;
        // Lost the race to a concurrent upload — re-read and report the REAL
        // current version, same contract as a plain version mismatch.
        return { ok: false, currentVersion: await readCurrentBlobVersion(input.accountId) };
      }

      // THE PIN, BETWEEN THE WIN AND THE SWEEP (M224). After the insert, so a
      // write that lost its CAS race never pins anything; before the prune, so
      // the pin is visible to the sweep it exists to survive.
      const pinPreviousUntil = input.pinPreviousUntil ?? null;
      if (pinPreviousUntil !== null && input.baseVersion > 0) {
        await db
          .update(syncBlobs)
          .set({ pinnedUntil: pinPreviousUntil })
          .where(and(eq(syncBlobs.accountId, input.accountId), eq(syncBlobs.blobVersion, input.baseVersion)));
      }

      await pruneOldBlobVersions(input.accountId, clock());
      return { ok: true, newVersion };
    },

    async listKeyRecords(accountId: number): Promise<SyncKeyRecord[]> {
      const rows = await db.select().from(syncKeyRecords).where(eq(syncKeyRecords.accountId, accountId));
      return rows.map(mapKeyRecordRow);
    },

    async putKeyRecord(input): Promise<PutKeyRecordResult> {
      if (input.expectedUpdatedAt === null) {
        try {
          const [row] = await db
            .insert(syncKeyRecords)
            .values({
              accountId: input.accountId,
              kind: input.kind,
              kdfDescriptor: input.kdfDescriptor ?? null,
              wrappedDek: Buffer.from(input.wrappedDek),
            })
            .returning();
          if (!row) throw new Error('Failed to insert sync key record');
          return { ok: true, record: mapKeyRecordRow(row) };
        } catch (error) {
          if (!isUniqueViolation(error)) throw error;
          return { ok: false, currentUpdatedAt: await readCurrentKeyRecordUpdatedAt(input.accountId, input.kind) };
        }
      }

      const [row] = await db
        .update(syncKeyRecords)
        .set({
          kdfDescriptor: input.kdfDescriptor ?? null,
          wrappedDek: Buffer.from(input.wrappedDek),
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(syncKeyRecords.accountId, input.accountId),
            eq(syncKeyRecords.kind, input.kind),
            eq(syncKeyRecords.updatedAt, input.expectedUpdatedAt),
          ),
        )
        .returning();
      if (!row) {
        return { ok: false, currentUpdatedAt: await readCurrentKeyRecordUpdatedAt(input.accountId, input.kind) };
      }
      return { ok: true, record: mapKeyRecordRow(row) };
    },

    async deleteKeyRecord(input): Promise<void> {
      await db
        .delete(syncKeyRecords)
        .where(and(eq(syncKeyRecords.accountId, input.accountId), eq(syncKeyRecords.kind, input.kind)));
    },
  };
}
