/**
 * Drizzle implementation of `InstanceSettingsStore`: one row, read and
 * upserted.
 *
 * THE ID IS A LITERAL `1` IN BOTH STATEMENTS, and the check constraint in
 * `db/schema.ts` says the same thing. That is what makes the upsert below an
 * upsert rather than an insert that sometimes duplicates: the conflict target
 * is the primary key, and there is only ever one value it can hold.
 *
 * NOTHING HERE IS ON A REQUEST PATH THAT MATTERS. The read runs at boot and
 * on a 60 second timer, the write runs when an administrator changes the
 * setting. `/health` serves a process-local copy and never calls either, see
 * `instance/instance-settings.ts`.
 */
import { eq } from 'drizzle-orm';
import type { InstanceSettingsRecord, InstanceSettingsStore } from '../instance/instance-settings.js';
import type { NutrientReferenceBasis } from '../protocol.js';
import type { Database } from './client.js';
import { instanceSettings } from './schema.js';

/** The primary key of the one row, named once so the two statements below cannot disagree. */
const SETTINGS_ROW_ID = 1;

export function createDrizzleInstanceSettingsStore(db: Database): InstanceSettingsStore {
  return {
    async read(): Promise<InstanceSettingsRecord | null> {
      const [row] = await db
        .select({
          nutrientReferenceBasis: instanceSettings.nutrientReferenceBasis,
          updatedAt: instanceSettings.updatedAt,
        })
        .from(instanceSettings)
        .where(eq(instanceSettings.id, SETTINGS_ROW_ID))
        .limit(1);

      // An instance nobody has changed anything on has no row, which is not an
      // error: the caller falls back to the environment default.
      return row ?? null;
    },

    async write(input: { nutrientReferenceBasis: NutrientReferenceBasis; now: Date }): Promise<InstanceSettingsRecord> {
      const [row] = await db
        .insert(instanceSettings)
        .values({
          id: SETTINGS_ROW_ID,
          nutrientReferenceBasis: input.nutrientReferenceBasis,
          updatedAt: input.now,
        })
        .onConflictDoUpdate({
          target: instanceSettings.id,
          set: { nutrientReferenceBasis: input.nutrientReferenceBasis, updatedAt: input.now },
        })
        .returning({
          nutrientReferenceBasis: instanceSettings.nutrientReferenceBasis,
          updatedAt: instanceSettings.updatedAt,
        });

      // `RETURNING` on an upsert always yields the row it wrote; an absence
      // here would mean the statement did nothing, which is a bug rather than
      // a state to carry on from.
      if (row === undefined) throw new Error('instance_settings write returned no row');
      return row;
    },
  };
}
