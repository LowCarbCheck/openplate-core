/**
 * Where a reported photograph is kept, behind an interface with three methods.
 *
 * WHY AN INTERFACE FOR ONE IMPLEMENTATION. The shipped store is Postgres, and
 * that is a deliberate choice rather than a stopgap: an object store would mean
 * a new vendor, a new secret, a new transfer question for a German
 * health-adjacent product, and a fake bucket in a local gate that has no cloud
 * CI. But the day an instance holds more photographs than a Postgres wants to
 * carry, the move has to be cheap. It is: `put`, `get` and `delete` are the
 * whole surface, so a later S3 or MinIO adapter is ONE new file implementing
 * this interface and NO caller change. There is deliberately no `list`, no
 * `stat` and no URL: a caller that could enumerate images would be a second way
 * to reach them, and spec 06's admin surface reaches them by report id or not
 * at all.
 *
 * DO NOT ADD AN OBJECT-STORAGE DEPENDENCY TO THIS PACKAGE to satisfy this
 * interface. A new adapter file is the change; an object-storage SDK in
 * `package.json` is a different decision, and it belongs in an ADR first. The
 * spec's own gate greps `src/` and `package.json` for a vendor client, so the
 * name of one is deliberately absent from this file as well as from the
 * dependency list. See the ADR's prohibition 2.
 *
 * `put` IS AN UPSERT, ON PURPOSE. A report is written first and its image
 * second (`register-feedback-route.ts`), so a crash between the two leaves a
 * row that says it has an image and no bytes behind it. The client's retry
 * carries the same idempotency key, finds the existing report, and puts the
 * image again. That repair only works if a second put over the same report id
 * succeeds rather than conflicting.
 *
 * See `docs/adr/0006-a-reported-photograph-is-the-second-hole-in-the-claim.md`.
 */
import { eq } from 'drizzle-orm';
import type { Database } from '../db/client.js';
import { feedbackImages } from '../db/schema.js';

/** What a stored image is, on the way in and on the way out. Bytes plus the type needed to serve them honestly. */
export interface FeedbackImage {
  contentType: string;
  bytes: Buffer;
}

export interface FeedbackImageStore {
  /** Writes (or replaces) the image for a report. See the module header on why replacing must not conflict. */
  put(input: { reportId: number } & FeedbackImage): Promise<void>;
  /** The image for a report, or `null` when there is none. `null` is an answer, never an error. */
  get(reportId: number): Promise<FeedbackImage | null>;
  /** Removes the image and leaves the report. Deleting an image that is not there is a no-op, not a failure. */
  delete(reportId: number): Promise<void>;
}

/**
 * The shipped implementation: Postgres `bytea`, in the database this service
 * already runs and already backs up.
 */
export function createDrizzleFeedbackImageStore(db: Database): FeedbackImageStore {
  return {
    async put(input: { reportId: number } & FeedbackImage): Promise<void> {
      await db
        .insert(feedbackImages)
        .values({ reportId: input.reportId, contentType: input.contentType, bytes: input.bytes })
        .onConflictDoUpdate({
          target: feedbackImages.reportId,
          set: { contentType: input.contentType, bytes: input.bytes },
        });
    },

    async get(reportId: number): Promise<FeedbackImage | null> {
      const rows = await db
        .select({ contentType: feedbackImages.contentType, bytes: feedbackImages.bytes })
        .from(feedbackImages)
        .where(eq(feedbackImages.reportId, reportId))
        .limit(1);
      const row = rows[0];
      if (!row) return null;
      return { contentType: row.contentType, bytes: row.bytes };
    },

    async delete(reportId: number): Promise<void> {
      await db.delete(feedbackImages).where(eq(feedbackImages.reportId, reportId));
    },
  };
}
