/**
 * The only module that writes `feedback_reports`, and the one place the
 * idempotency guarantee and the daily limit are decided.
 *
 * ONE TRANSACTION, ONE ACCOUNT AT A TIME. The submit path has to answer three
 * questions in order (have I already stored this key, is this account over its
 * daily limit, insert) and two concurrent retries that interleave between them
 * would either store two rows or count one twice. The transaction takes a
 * Postgres ADVISORY LOCK on the account id first, so the three statements are
 * serialised per account and cost nothing to any other account. The unique
 * index on `(account_id, idempotency_key)` is the second line of defence: even
 * if this lock were removed, the database would still refuse the second row.
 *
 * A REFUSAL RETURNS RATHER THAN THROWS HERE, and that is not a contradiction of
 * `rotation-store.ts`, which insists the opposite. Its rule is that a `return`
 * from a transaction callback COMMITS what has already been written, so a
 * refusal AFTER a write must throw. Both refusals below happen BEFORE anything
 * is written, so there is nothing to roll back and a returned outcome is the
 * honest shape.
 *
 * THE COUNT IS THE TABLE, NOT A SECOND COUNTER. `ai_usage_days` exists because
 * the AI proxy's limit guards MONEY and the thing being counted (a forwarded
 * request) leaves no row behind. A report leaves a row, so counting rows is
 * exact and cannot drift from what is actually stored. A counter table beside
 * this one could disagree with it, and the disagreement would be discovered by
 * whoever was wrongly refused.
 */
import { and, count, eq, gte, sql } from 'drizzle-orm';
import type { Database } from '../db/client.js';
import { feedbackReports } from '../db/schema.js';
import type { JsonObject } from '../lib/json.js';

/**
 * The advisory-lock namespace for this feature. Postgres advisory locks share
 * ONE global space per database, so a bare account id would collide with any
 * future feature that locks on an account id too. The first argument
 * namespaces it; the value is arbitrary and only has to stay put.
 */
const FEEDBACK_LOCK_NAMESPACE = 200_005;

/** What was agreed to, and when. Travels with the report, never as a device-local flag. See the schema. */
export interface FeedbackConsent {
  agreedAt: Date;
  wordingVersion: string;
}

export interface SubmitFeedbackInput {
  accountId: number;
  idempotencyKey: string;
  measurements: JsonObject;
  consent: FeedbackConsent;
  /** Whether an image accompanies this report. Recorded even when the image write later fails. */
  hasImage: boolean;
  /** How many reports this account may store in the window below. */
  dailyLimit: number;
  /** The start of the current UTC day. Injected, like every clock in this repo, so a test does not wait for midnight. */
  since: Date;
}

/** What a caller learns about a stored report. Deliberately not the row: the measurements go in, they do not come back. */
export interface StoredFeedbackReport {
  id: number;
  accountId: number;
  hasImage: boolean;
  createdAt: Date;
}

/**
 * `stored` and `duplicate` are BOTH successes, and the difference matters only
 * to the status code the route picks. `daily-limit-reached` is the one refusal.
 */
export type SubmitFeedbackResult =
  | { status: 'stored'; report: StoredFeedbackReport }
  | { status: 'duplicate'; report: StoredFeedbackReport }
  | { status: 'daily-limit-reached'; limit: number };

export interface FeedbackStore {
  submit(input: SubmitFeedbackInput): Promise<SubmitFeedbackResult>;
  /** How many reports the account has stored since the given instant. The route reports it, the store decides it. */
  countSince(input: { accountId: number; since: Date }): Promise<number>;
}

export function createDrizzleFeedbackStore(db: Database): FeedbackStore {
  return {
    async submit(input: SubmitFeedbackInput): Promise<SubmitFeedbackResult> {
      return await db.transaction(async (tx) => {
        // Serialises this account's submissions against each other, and
        // releases when the transaction ends whichever way it ends.
        await tx.execute(sql`select pg_advisory_xact_lock(${FEEDBACK_LOCK_NAMESPACE}, ${input.accountId})`);

        const existing = await tx
          .select({
            id: feedbackReports.id,
            accountId: feedbackReports.accountId,
            hasImage: feedbackReports.hasImage,
            createdAt: feedbackReports.createdAt,
          })
          .from(feedbackReports)
          .where(
            and(
              eq(feedbackReports.accountId, input.accountId),
              eq(feedbackReports.idempotencyKey, input.idempotencyKey),
            ),
          )
          .limit(1);
        const already = existing[0];
        // A RETRY IS NOT A SECOND REPORT. The row that is already there is
        // returned unchanged: the client has no way to edit a report by
        // resending it with the same key, which is what makes the key safe to
        // put in a durable outbox on the device.
        if (already) return { status: 'duplicate', report: already };

        // Counted BEFORE the insert and INSIDE the lock, so a burst of
        // simultaneous reports cannot each read the same pre-insert count.
        const counted = await tx
          .select({ total: count() })
          .from(feedbackReports)
          .where(and(eq(feedbackReports.accountId, input.accountId), gte(feedbackReports.createdAt, input.since)));
        const total = counted[0]?.total ?? 0;
        if (total >= input.dailyLimit) return { status: 'daily-limit-reached', limit: input.dailyLimit };

        const inserted = await tx
          .insert(feedbackReports)
          .values({
            accountId: input.accountId,
            idempotencyKey: input.idempotencyKey,
            measurements: input.measurements,
            hasImage: input.hasImage,
            consentAgreedAt: input.consent.agreedAt,
            consentWordingVersion: input.consent.wordingVersion,
          })
          .returning({
            id: feedbackReports.id,
            accountId: feedbackReports.accountId,
            hasImage: feedbackReports.hasImage,
            createdAt: feedbackReports.createdAt,
          });
        const report = inserted[0];
        // An insert with no row back is a broken database, not a refusal, and
        // it must not read as one: throwing rolls the transaction back and the
        // route answers 500.
        if (!report) throw new Error('feedback report insert returned no row');
        return { status: 'stored', report };
      });
    },

    async countSince(input: { accountId: number; since: Date }): Promise<number> {
      const rows = await db
        .select({ total: count() })
        .from(feedbackReports)
        .where(and(eq(feedbackReports.accountId, input.accountId), gte(feedbackReports.createdAt, input.since)));
      return rows[0]?.total ?? 0;
    },
  };
}
