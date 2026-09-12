---
name: openplate-app-gate-gotchas
description: In the sibling openplate app repo, a new English i18n key reddens the gate without German, and the settings hub model is pinned by a frozen test fixture
metadata:
  type: project
---

Three traps in `~/projects/openplate-workspace/openplate` (the app, not this
service) that only show up after the code is already written.

1. **An English-only key reddens `pnpm test:unit`.**
   `tests/unit/i18n-key-parity.test.ts` asserts `de ⊇ en` over
   `app/i18n/locales/{en,de}/common.json`. So a task scoped to "English keys
   only, another worker does German" ends with a red gate by construction.
   Say so up front; do not treat it as your own defect.

2. **`SettingsHubFacts` is pinned by a literal.**
   `tests/unit/settings-hub.test.ts` builds a `RICHEST` object literal and
   asserts SEVEN group labels in order, plus the exact row list of the account
   and lists groups. A new hub row therefore costs one line in that fixture,
   and a new hub GROUP breaks the order test outright. Put a new row in an
   existing group unless you also own that test.

3. **`en/common.json` has carried duplicate keys.**
   `fasting.plan.protocol` was written twice at 2026-09-12. A JSON round trip
   (python `json.load` then `dump`) silently keeps only the last and deletes
   the first, which lands as an unrelated deletion in your diff. Prefer a
   surgical text edit, or check the diff for removals you did not intend.

4. **Iterate bare, verify through toolbox.**
   Node 24 is on the worker's PATH at `~/.config/nvm/versions/node/v24.8.0/bin`,
   so `node --import tsx --test --test-concurrency=1 tests/unit/<f>.test.ts`,
   `pnpm exec oxlint --max-warnings 0` and
   `pnpm exec react-router typegen && pnpm exec tsc` all run directly. Re-run
   the spec's own `toolbox run -c ts-dev env CI=true ...` forms before
   reporting. The full `pnpm test:unit` is about 90 s, and `i18n-key-parity`
   alone is 22 s of it.

Related: [[openplate-app-anti-slop-lint]], [[openplate-notify-grep-check-reads-peer-comments]]
