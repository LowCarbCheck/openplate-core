---
name: openplate-sync-gate-and-toolbox
description: openplate-sync gate commands, the prettier baseline that already fails, and the oxlint anti-slop rules that bite
metadata:
  type: project
---

The gate is `pnpm lint` (oxlint, zero warnings), `pnpm typecheck` (tsc
--noEmit), `pnpm test` (unit then integration). Everything runs as
`toolbox run -c ts-dev env CI=true pnpm ...`.

**Why:** `pnpm format:check` is NOT in the gate and eleven files already fail it
on a clean tree (PROTOCOL.md, two ADRs, README.md, several src and test files).
Do not "fix" the repo's formatting; run `npx prettier --write` on your own new
files only, then confirm the failing count is unchanged.

**How to apply:** the local `anti-slop` oxlint plugin rejects patterns that pass
tsc. The three that bit on 2026-09-07: `no-known-value-widening` (an inline
anonymous object as a function's declared return type, use a named interface),
`no-runtime-typeof` (branching on `typeof x === 'string'`), and
`require-safety-comment-for-type-assertion` (every `as` needs a `SAFETY:`
comment directly above the statement).

Integration tests hit the shared Postgres on 5433 through
`tests/integration/db-harness.ts` and need `--test-concurrency=1`.

Related: [[openplate-sync-feedback-admin-m200-06]].
