---
name: openplate-sync-tombstones-an-empty-store
description: In the openplate app, nothing stops a sync cycle reading an empty local store and pushing a tombstone for every entity in the baseline, which deletes the account's diary on the server and on every other device
metadata:
  type: project
---

`stampSnapshot` in `app/lib/sync/snapshot-sync.ts` emits a tombstone for every
key that is in the persisted baseline and absent from the current snapshot. It
has NO floor, no ratio guard and no "this is too many" refusal. The baseline
lives in `localStorage` and is read synchronously, so it is always complete;
the diary lives in IndexedDB and can come back empty. One cycle then pushes an
empty diary plus a tombstone per entity.

**Why:** this is how account 2 lost a whole diary in production on 2026-09-12
(blob v22 5310 B -> v23 1588 B in one push). The 0.28.0 -> 0.29.0 schema 20 ->
21 transition is NOT the cause, a real cross-version fixture runs that cycle
clean and pushes nothing. The empty store is.

**How to apply:** three consequences, all reproduced:
1. the wipe SPREADS. A second device that still holds the real diary pulls the
   tombstones, `applyMergedSnapshot`'s delete loops run, and its rows go too.
   Freeze or stop syncing the account before touching anything else.
2. it is RECOVERABLE. Restoring a JSON backup on the wiped device resurrects
   every row (`floor = max(previous, buried)` in `stampSnapshot`) and re-pushes
   them with the tombstones cleared.
3. `persist.ts`'s `loadAndVerifyOrThrow` only refuses the TRANSITION (disk had
   rows, memory empty). Once the disk is genuinely empty it is silent, and
   nothing downstream of it protects sync.

The reproduction harness and the v0.28.0 fixture generator are parked in
`/tmp/openplate-diagnosis/`. Related:
[[openplate-erase-must-take-the-sync-baseline]] in the auto-memory, which is
the same tombstone mechanism reached by a different door.
