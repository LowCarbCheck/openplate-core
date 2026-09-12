---
name: a-new-commonjs-dependency-must-be-external
description: In openplate-core, adding a CommonJS npm dependency breaks `pnpm build` until it is listed in `external` in scripts/build.ts
metadata:
  type: project
---

Adding a CommonJS package to openplate-core (`web-push` in M223, `dotenv` before
it) makes `pnpm build` fail with "dist/server.js contains esbuild's
dynamic-require shim". esbuild inlines the CJS module into the ESM bundle and
the process would die on its first line at runtime.

**Why:** `scripts/build.ts` greps the emitted bundle for `Dynamic require of`
and throws. Nothing else catches it: typecheck, the unit suite and the
integration suite all run TypeScript sources and never touch `dist/`.

**How to apply:** when you add a dependency the server imports, add it to the
`external` array in `scripts/build.ts` and update the count in the header
comment there and in the `Dockerfile` header. The externals are installed into
the image by `pnpm install --prod`, so nothing else has to change. Run
`pnpm build` after any dependency change, not only after a source change.

Related: [[the-cli-import-graph-is-swept]]
