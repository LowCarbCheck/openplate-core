---
name: openplate-notify-grep-check-reads-peer-comments
description: M223's openplate-notify sole-owner grep counts a prose mention in another worker's file
metadata:
  type: project
---

M223 spec 02 verifies the catch-up record's isolation with
`test "$(grep -rl 'openplate-notify' app | sort -u | tr -d '\n')" = "app/lib/notify-store.ts"`.
`app/lib/push-decision.ts` (spec 03's module) names the literal in a doc
comment, so the check exits 1 while the code invariant it exists to protect is
intact.

**Why:** `grep -rl` reads comments. Same failure mode as the openplate-core
proxy refusal check.

**How to apply:** when a spec pins ownership of a string by grep, the doc
comments in every peer module must name the MODULE, not the literal. Fix the
peer comment rather than the check.
