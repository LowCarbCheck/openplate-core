---
name: openplate-worker-copies-its-pure-logic
description: openplate's service worker is a classic script that cannot import app code, so pure logic exists twice and a behavioural parity test holds the two together
metadata:
  type: project
---

`openplate/public/sw.js` is hand written and NOT bundled, and
`app/lib/service-worker.ts` registers it with `register('/sw.js')` and no
`{ type: 'module' }`, so it is a CLASSIC worker: no `import`, only
`importScripts('/<file>.js')` from the same origin.

Any pure logic the worker needs therefore exists twice: the TypeScript source
under `app/lib/`, and a plain JavaScript transcription under `public/` that
attaches one namespace to `self`.

**Why:** M223/03 needed the push decision both in the worker and in node tests.

**How to apply:** hold the two together with a BEHAVIOURAL parity test, not a
textual diff. A text comparison has to be taught to ignore type annotations,
`export` and JSDoc, and every exception is a hole. Run both implementations over
a matrix and mutate the copy in memory as the control:
`tests/unit/sw-push-copy-parity.test.ts` is the worked example, and
`tests/unit/sw-push-decision-harness.ts` loads the copy with `node:vm` under a
bare `{ self: {} }` scope.
