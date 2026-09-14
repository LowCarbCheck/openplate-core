---
name: openplate-a-delete-is-recorded-not-inferred
description: In the openplate app, a sync tombstone is authorised by a delete journal written in the delete verb's own transaction, so any new path that removes a synced row must go through deleteEntity or the delete is never published
metadata:
  type: project
---

M225 replaced the disk-versus-memory proxy with a fact. `deletedEntities` is a
table in the SAME IndexedDB database as the diary, keyed `entityType:entityId`
by `entityKey` (defined in `local-store/schema.ts`, re-exported by
`snapshot-sync.ts` so there is one spelling). `primary-store.ts`'s private
`deleteEntity` removes the row and writes the key inside one
`store.transaction`. `stampSnapshot` mints a tombstone only for a key the
journal names; `commitState` prunes the rows whose tombstone reached the
baseline.

**Why:** disk and memory agree perfectly at zero after a prime, after the
`t`-store-emptied incident, and after a real total delete, so agreement between
two things that failed together is not evidence. The journal fails together
with the diary, which is exactly what is wanted.

**How to apply:**
- A new verb that removes a synced row must call `deleteEntity`, not `delRow`.
  A row removed directly is a delete no peer ever hears about, and no test that
  does not drive the real store will catch it. Grep `delRow` in
  `primary-store.ts` before adding a path.
- The journal is deliberately ABSENT from `LocalStoreSnapshot`, so `backup.ts`
  never exports it, `snapshot-partition.ts` never classifies it, and
  `SCHEMA_VERSION` did not move. Adding it to the snapshot would publish a list
  of what somebody deleted.
- The two merged SINGLETONS (profile, fastingSettings) have no delete verb at
  all, so they can never be tombstoned. That is correct, not an oversight.
- The compartment (`privateStore`) is NOT in the journal and must not be asked
  for: its positive evidence is `isCompartmentKnown`.
