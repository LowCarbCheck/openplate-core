---
name: openplate-app-e2e-and-build-traps
description: In the openplate app repo, Playwright's runner cannot import a JSON module, prettier already fails on two tracked files, and BUILD.version can be absent from releases.json
metadata:
  type: project
---

Three traps in `~/projects/openplate-workspace/openplate` (the app) that only
appear after the code compiles.

1. **A lib a Playwright spec imports must not import JSON.**
   `tests/e2e/*.spec.ts` is loaded by Playwright's own ESM loader, which has no
   JSON-module loader: a bare `import x from './x.json'` anywhere in the import
   graph fails the whole run with
   `needs an import attribute of "type: json"`, and Playwright then reports
   "No tests found". `tsc` and `node --import tsx` both accept the bare form, so
   the unit tier and the typecheck stay green. `with { type: 'json' }` is NOT the
   fix: `tsc` rejects it under this repo's `module` setting (TS2823). Keep the
   JSON import in the COMPONENT that needs it and leave the pure lib clean, so a
   spec can import the lib's constants instead of transcribing them.

2. **`prettier --check` is not part of the gate, and two tracked files fail it.**
   `.githooks/pre-push` runs docs manifest, quadlet, changelog, `pnpm lint`
   (oxlint), typecheck, unit, integration, build, then `pnpm test:e2e`. No
   prettier stage. `app/lib/route-tree.ts` and `app/routes/diary.tsx` already
   fail `prettier --check` at HEAD, so check only the files you wrote, and never
   `--write` those two: the reformat would be a large unrelated diff.

3. **`BUILD.version` is not always in `releases.json`.**
   `BUILD.version` is `package.json`'s version, which only moves on a release
   commit. `scripts/sync-release-catalog.ts` writes the newest three releases
   THAT CHANGED THE APPLICATION, so a docs-only release (0.35.1 was one) is in
   `package.json` and absent from the catalog. Any rule of the form "the entry
   whose version equals the running build" is therefore silently empty after
   such a release. Bound it with "the newest entry at or below the build"
   instead, or state the gap.

4. **A profile state no click can reach is seeded on disk, then read back.**
   "This device was in use before the bundle was built" cannot be produced by
   the UI, because the bundle is minutes old. Patch
   `profileGoals.me.entity.onboardingCompletedAt` in IndexedDB
   (`openplate-primary`, store `t`, one `{ k, v }` record per table, each row's
   entity is a JSON string), then navigate and read it back through the fresh
   document before asserting. `tests/e2e/insights-doors.spec.ts` seeds
   `foodLogs` the same way.

5. **An absence needs a settle that is not a sleep.** `toHaveCount(0)` resolves
   on its first poll, so a card drawn from an effect that awaits IndexedDB is
   "absent" before it ever had a chance. Issue a NEW IndexedDB read (its
   transaction is ordered after the component's) and then await two animation
   frames. Prove it with a mutation: an always-show decision must turn those
   assertions red.

Related: [[openplate-app-gate-gotchas]], [[openplate-app-anti-slop-lint]]
