---
name: openplate-app-i18n-third-namespace
description: In the openplate app a new i18n namespace is auto-discovered, but it reddens the German byte-for-byte rebuild test until translate:ui is run, and a two-digit JSON key hoists once it reaches "10"
metadata:
  type: project
---

Adding a namespace to `~/projects/openplate-workspace/openplate` (the app) means
`app/i18n/locales/<locale>/<ns>.json` for all six languages plus three edits in
`app/i18n/i18n.ts`: the imports, `RESOURCES` with its `satisfies`, and `ns`.
Nothing else lists namespaces. `scripts/lib/translate-ui.ts` `namespacesOf()`
DISCOVERS them by listing `app/i18n/locales/en/*.json`.

Four things that only show up afterwards.

1. **`tests/unit/translate-bundles.test.ts` goes red immediately.** It loops
   `namespacesOf()` and asserts, for German, that the catalog on disk is byte
   for byte what `rebuildByPath` produces from the memory, AND that an EMPTY
   memory does not produce it. A placeholder locale file copied from English
   fails both. It goes green only after
   `pnpm translate:ui --locale de --local` writes `app/i18n/memory/de.json`.
   Say so up front; it is not your defect.

2. **`tests/unit/i18n-key-parity.test.ts` does NOT cover it.** Its
   `NAMESPACES` is the literal `['common', 'legal']`. Same for
   `shipped-copy-no-dash.test.ts`, whose `BUNDLES` is four hand-written pairs.
   A new namespace needs its own parity check in its own test file.

3. **No `CustomTypeOptions` augmentation exists in the repo.** i18next's
   `CustomTypeOptions` is empty, so `t('a.b.c', { ns: 'whatever' })` and
   `useTranslation('whatever')` typecheck with loose string keys. Nothing to
   update, and adding an augmentation would be a new constraint, not a fix.

4. **A two-digit JSON key hoists once it reaches `"10"`.** A catalog keyed
   `"01"`, `"02"` is fine, but `"10"` IS a canonical array index, so JS puts
   it, `"11"` and `"12"` FIRST in `Object.keys` and in `JSON.stringify`, ahead
   of `"01"`. The zero padding is what saves the reader: sort the keys, never
   trust insertion order. A release with ten or more bullets in one group is
   where this first bites.

Related: [[openplate-app-gate-gotchas]], [[openplate-app-anti-slop-lint]]
