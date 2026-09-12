---
name: openplate-app-anti-slop-lint
description: The openplate app's oxlint anti-slop plugin rejects Record<K, string> annotations and Record<string, unknown>, in tests as well as in app code
metadata:
  type: project
---

`pnpm lint` in the openplate app runs oxlint with the local `anti-slop`
JS plugin over `app/` AND `tests/`. Two rules bite on ordinary-looking code:

- `no-known-value-widening`: `const KEYS: Record<K, string> = { ... }` is an
  error. Write the literal and end it with `satisfies Record<K, string>`.
- `no-unsafe-dictionary-type`: `Record<string, unknown>` is an error, so a
  fake transport in a test cannot type a parsed JSON body that way. Declare a
  named interface with a concrete value union instead.
- `require-safety-comment-for-type-assertion`: every `as` needs a `SAFETY:`
  comment immediately before the assertion or its statement, tests included.
  An `Object.keys(X) as K[]` is easiest avoided by writing the array out.

- `no-runtime-typeof` / `no-unknown-parameters`: a hand-rolled
  `function isX(value: unknown): value is X` guard is an error. Parse with a
  zod schema at the I/O boundary and export `z.infer` as the type.
- `no-shape-in-symbol-names`: a variable called `shapes` is an error.

`unicorn` runs beside it, and `prefer-add-event-listener` makes
`request.onsuccess = ...` on an `IDBRequest` an error. Use
`request.addEventListener('success', fn, { once: true })`; `fake-indexeddb`
(already in devDependencies) supports it.

Module mocking is banned, so every effect goes through an injected dependency
record (`app/lib/pulse.ts` and `app/lib/push.ts` are the worked examples:
a `set*Dependencies` / `reset*` pair, with the strongest test assertion being
that the fake fetch was never called).

Related: [[openplate-app-gate-gotchas]]
