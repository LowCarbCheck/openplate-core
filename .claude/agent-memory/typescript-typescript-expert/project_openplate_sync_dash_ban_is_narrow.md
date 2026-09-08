---
name: openplate-sync-dash-ban-is-narrow
description: the en/em dash ban is enforced only for mail copy, not repo-wide; do not treat a grep hit as a gate failure
metadata:
  type: project
---

The workspace CLAUDE.md bans en dashes and em dashes "everywhere, including
wire copy," but in `openplate-sync` the only automated check is
`tests/unit/mail-messages.test.ts` (`BANNED_DASHES = ['—', '–']`), which scans
`src/mail/strings.ts` only. There is no oxlint rule and no repo-wide test for
either character.

**Why:** on 2026-09-08 a targeted fix (removing one en dash from
`admin-routes.ts`'s `PAGING_REFUSAL`) turned up roughly 833 em dashes across
128 files (mostly doc-comment prose) and 8 en dashes (CLI help text in
`scripts/sync-api/main.ts` and `client.ts`, capacity-planning comments in
`src/protocol.ts`, `src/main.ts`, `src/lib/throttle.ts`) that the gate does not
catch and that predate this rule. A prior commit, `50a7fb0 docs: drop every em
and en dash from the readme and the protocol`, shows this has been swept
before in scoped passes, not as a standing invariant.

**How to apply:** when a task asks to fix a specific dash, fix only that one
plus any duplicate of the SAME sentence, then grep and report the rest instead
of scrubbing the whole tree. A repo-wide sweep is its own task, needs the
user's go-ahead, and should probably land as a named commit like the
2026-09-07 predecessor.

Related: [[openplate-sync-gate-and-toolbox]].
