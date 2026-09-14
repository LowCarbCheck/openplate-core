---
name: openplate-a-test-can-stage-a-state-production-never-reaches
description: In the openplate app, the store singleton makes a test's before() hook decide what the sync cycle sees, so an eviction test proved the function and not the boot order, and a wrong fix shipped twice with a green gate
metadata:
  type: project
---

`persist.ts` caches the primary store in a module-level promise. A test that
opens it in `before()` and then calls `indexedDB.deleteDatabase` leaves the
singleton open, so nothing re-runs `initPersistedStore` and the probe sees a
missing database. PRODUCTION NEVER SEES THAT: `initPersistedStore` calls
`primeFreshDatabaseIfNeeded` first, and on a missing database that empty save
CREATES the database and its `t` object store. The evicted device therefore
boots into "database present, every table empty".

**Why:** 0.29.1 and 0.29.2 both shipped a fix that reads as correct against the
staged state and does nothing against the real one. Eight controls were green.
The staging was wrong, not the controls.

**How to apply:**
1. A test about BOOT must be its own FILE, because node --test gives each file
   a process and the singleton is per process. `tests/integration/sync-eviction-boot-order.test.ts`
   is the worked example: it seeds the account over HTTP and the baseline through
   `vault.state.save`, never through the store, because writing one local row
   opens the singleton and destroys the condition.
2. To prove such a test bites, stash the work (`git stash push -u`, NEVER
   `git checkout <file>`), copy a HEAD-compatible variant of the test back in,
   run it, then `git stash pop`.
3. `SnapshotIntegrity` is required at every call site, so ADDING A FIELD TO IT
   makes tsc list every fixture that has to state what its device knows. That is
   the cheap way to force a re-decision across ~40 fixtures; `tests/sync-integrity-fixtures.ts`
   holds the named constants and `withRecordedDeletes`.
