/**
 * The READ and DELETE side of `feedback_reports`, for the operator surface and
 * for the retention sweep.
 *
 * A SECOND STORE RATHER THAN FOUR MORE METHODS ON `feedback-store.ts`, for the
 * reason `admin/admin-store.ts` is not `accounts/account-store.ts`: the submit
 * path is a person acting on their own row and the surface below is an
 * operator acting on somebody else's. Keeping them apart means the module a
 * reviewer opens to answer "what can an operator see" is one file with four
 * methods in it, and a field added to the write path does not silently become
 * readable.
 *
 * NO IMAGE BYTES PASS THROUGH HERE, EVER. Not in the list, not in the detail
 * read, not in the delete. `FeedbackImageStore` is the only thing that touches
 * `feedback_images`, so the day those bytes move to an object store this file
 * does not change. A `bytes` column joined into the list below would make every
 * page of the console a download of every photograph on it.
 *
 * `list` DELIBERATELY OMITS `measurements`. The list is the queue an operator
 * scans; the figures belong to the one report they opened. It costs a second
 * request and it means a screenshot of the queue carries nothing from anybody's
 * diary.
 */
import { count, desc, eq, lt } from 'drizzle-orm';
import type { Database } from '../db/client.js';
import { feedbackReports } from '../db/schema.js';
import type { JsonObject } from '../lib/json.js';

/** One row in the operator's queue. Everything an operator needs to decide whether to open it, and nothing else. */
export interface FeedbackReportSummary {
  id: number;
  accountId: number;
  hasImage: boolean;
  /** WHICH wording was agreed to, by version. The text itself lives in the client's locale bundles. */
  consentWordingVersion: string;
  createdAt: Date;
}

/** One opened report: the summary, plus the figures being disputed and when the person agreed. */
export interface FeedbackReportDetail extends FeedbackReportSummary {
  measurements: JsonObject;
  consentAgreedAt: Date;
}

export interface FeedbackAdminStore {
  /** One page of reports, NEWEST FIRST, with the total so a console can page. Never any image bytes. */
  list(input: { limit: number; offset: number }): Promise<{ reports: FeedbackReportSummary[]; total: number }>;
  /** One report with its figures and its consent record, or `null`. `null` is an answer, never an error. */
  get(reportId: number): Promise<FeedbackReportDetail | null>;
  /**
   * The ids of reports created before `before`, oldest first, at most `limit`
   * of them. IDS RATHER THAN A BULK DELETE, because the retention sweep has to
   * delete each report's IMAGE through `FeedbackImageStore` before it drops the
   * row: a `DELETE ... WHERE created_at < $1` would lean on the `feedback_images`
   * cascade, and that cascade only exists while the bytes happen to live in
   * Postgres. See `feedback-retention.ts`.
   */
  listExpiredIds(input: { before: Date; limit: number }): Promise<number[]>;
  /** Drops the row. `false` means there was no such report, which a caller may read as "already gone". */
  delete(reportId: number): Promise<boolean>;
}

export function createDrizzleFeedbackAdminStore(db: Database): FeedbackAdminStore {
  return {
    async list(input: { limit: number; offset: number }): Promise<{
      reports: FeedbackReportSummary[];
      total: number;
    }> {
      const rows = await db
        .select({
          id: feedbackReports.id,
          accountId: feedbackReports.accountId,
          hasImage: feedbackReports.hasImage,
          consentWordingVersion: feedbackReports.consentWordingVersion,
          createdAt: feedbackReports.createdAt,
        })
        .from(feedbackReports)
        // Newest first, and the id breaks the tie: `created_at` defaults to
        // `now()`, and two reports written inside one transaction can share a
        // timestamp to the microsecond. Without the second key their order
        // across two pages is whatever Postgres feels like, which shows an
        // operator the same row twice and hides another.
        .orderBy(desc(feedbackReports.createdAt), desc(feedbackReports.id))
        .limit(input.limit)
        .offset(input.offset);

      const counted = await db.select({ total: count() }).from(feedbackReports);
      return { reports: rows, total: counted[0]?.total ?? 0 };
    },

    async get(reportId: number): Promise<FeedbackReportDetail | null> {
      const rows = await db
        .select({
          id: feedbackReports.id,
          accountId: feedbackReports.accountId,
          hasImage: feedbackReports.hasImage,
          measurements: feedbackReports.measurements,
          consentAgreedAt: feedbackReports.consentAgreedAt,
          consentWordingVersion: feedbackReports.consentWordingVersion,
          createdAt: feedbackReports.createdAt,
        })
        .from(feedbackReports)
        .where(eq(feedbackReports.id, reportId))
        .limit(1);
      return rows[0] ?? null;
    },

    async listExpiredIds(input: { before: Date; limit: number }): Promise<number[]> {
      const rows = await db
        .select({ id: feedbackReports.id })
        .from(feedbackReports)
        .where(lt(feedbackReports.createdAt, input.before))
        // Oldest first, so a sweep that hits its batch limit takes the reports
        // that have been here longest and the next tick takes the rest.
        .orderBy(feedbackReports.createdAt)
        .limit(input.limit);
      return rows.map((row) => row.id);
    },

    async delete(reportId: number): Promise<boolean> {
      const deleted = await db
        .delete(feedbackReports)
        .where(eq(feedbackReports.id, reportId))
        .returning({ id: feedbackReports.id });
      return deleted.length > 0;
    },
  };
}
