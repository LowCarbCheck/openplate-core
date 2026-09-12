---
name: openplate-oxlint-bites-plain-js-too
description: In the openplate member repo oxlint lints public/*.js, bans typeof everywhere, and misreads clearTimeout inside a Promise executor as a second resolve
metadata:
  type: project
---

`openplate` (sibling member of `openplate-core` in the same workspace) runs
`oxlint --max-warnings 0` over the WHOLE tree, `public/*.js` included, so the
hand written service worker and anything it loads is held to the same rules as
`app/`.

Three of those rules bite plain worker JavaScript, and none is obvious:

- `anti-slop/no-runtime-typeof` bans `typeof` everywhere, not only in TS.
  Validate an untrusted value with `value ?? ''`, `String(...)`,
  `Number.isFinite(...)` or `Array.isArray(...)` instead.
- `unicorn/prefer-add-event-listener` rejects `request.onsuccess = ...` on an
  IndexedDB request. Use `request.addEventListener('success', ...)`.
- `promise/no-multiple-resolved` reports a FALSE POSITIVE when `clearTimeout()`
  sits directly above `resolve()` inside a `new Promise` executor: it counts the
  `clearTimeout` call as a resolve. Reproduced on a four line file. The fix that
  keeps the timer cleared is to race the work against a timeout promise and
  clear the timer in a `.then()` outside the executor.

**Why:** M223/03 added a `push` handler to `public/sw.js`; all three fired on
code that was correct.

**How to apply:** lint any new `public/*.js` explicitly
(`pnpm exec oxlint --max-warnings 0 public/<file>.js`) before claiming done.

See [[openplate-worker-copies-its-pure-logic]].
