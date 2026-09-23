/**
 * The only module that writes `legal_declarations`.
 *
 * TWO WRITES, NEVER ONE STATEMENT. `create` is the persist-first step
 * `server/legal-declarations.ts` calls before it does anything else; the row
 * exists, with `forwarded_at` and `forward_error` both `null`, the instant
 * this resolves. `recordForwardOutcome` is a SEPARATE later write that only
 * ever touches those two columns, because the forward to the biller is
 * best-effort work that must never be allowed to make the persisted row
 * disappear if it throws.
 */
import { eq, lt } from 'drizzle-orm';
import type { Database } from '../db/client.js';
import { legalDeclarations, type SelectLegalDeclaration } from '../db/schema.js';

export interface CreateLegalDeclarationInput {
  id: string;
  kind: 'kuendigung' | 'widerruf';
  name: string;
  email: string;
  contractReference: string | null;
  terminationType: 'ordentlich' | 'ausserordentlich' | null;
  reason: string | null;
  requestedDate: string | null;
  timing: 'earliest' | 'onDate' | null;
  language: 'de' | 'en';
  receivedAt: Date;
  accountId: number | null;
}

/** Either the forward succeeded (`forwardedAt` is when) or it did not (`forwardError` says why). Never both, never neither. */
export type ForwardOutcome = { ok: true; forwardedAt: Date } | { ok: false; forwardError: string };

export interface LegalDeclarationsStore {
  create(input: CreateLegalDeclarationInput): Promise<SelectLegalDeclaration>;
  recordForwardOutcome(input: { id: string; outcome: ForwardOutcome }): Promise<void>;
  /**
   * Deletes every declaration received before `before`, and answers how many
   * went. The retention half of this table (`legal/legal-declarations-retention.ts`),
   * driven by the hourly usage sweep. Idempotent: the predicate is an instant.
   */
  purgeReceivedBefore(input: { before: Date }): Promise<number>;
}

export function createDrizzleLegalDeclarationsStore(db: Database): LegalDeclarationsStore {
  return {
    async create(input: CreateLegalDeclarationInput): Promise<SelectLegalDeclaration> {
      const [row] = await db.insert(legalDeclarations).values(input).returning();
      if (row === undefined) {
        throw new Error(`insert of legal declaration ${input.id} returned no row`);
      }
      return row;
    },

    async recordForwardOutcome(input: { id: string; outcome: ForwardOutcome }): Promise<void> {
      await db
        .update(legalDeclarations)
        .set(
          input.outcome.ok
            ? { forwardedAt: input.outcome.forwardedAt, forwardError: null }
            : { forwardedAt: null, forwardError: input.outcome.forwardError },
        )
        .where(eq(legalDeclarations.id, input.id));
    },

    async purgeReceivedBefore(input: { before: Date }): Promise<number> {
      const deleted = await db
        .delete(legalDeclarations)
        .where(lt(legalDeclarations.receivedAt, input.before))
        .returning({ id: legalDeclarations.id });
      return deleted.length;
    },
  };
}
