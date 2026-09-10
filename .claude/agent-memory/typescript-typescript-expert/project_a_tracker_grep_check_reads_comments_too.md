---
name: a-tracker-grep-check-reads-comments-too
description: M212's checklist greps count prose and split on braces, so a doc comment can fail a check that the code satisfies
metadata:
  type: project
---

The `.tracker` verification commands for this repo are `node -e` string
surgery over source files, and they do not know what a comment is. Three of
M212 spec 03's checks bit on that:

- `(s.match(/express.json\(/g)||[]).length !== 1` on
  `src/accounts/register-auth-routes.ts` counted the TWO `express.json()`
  mentions in the module header as well as the one real call, so the check
  failed at HEAD before any edit.
- `s.split('/invites')[1].slice(0,200)` must contain `requireAuth`. `split`
  cuts at EVERY occurrence, so `[1]` is the text between the first and second
  one. The dark-instance terminator and the real route both name the path, so
  the branch order decides whether the check passes: register the route first,
  put the `handleNotFound` terminator in the `else`.
- `s.split('export interface Mailer')[1].split('}')[0]` stops at the first
  closing brace, which a `{@link Foo}` in a member's doc comment supplies. The
  third method was invisible until that link became plain backticks.

**Why:** these checks are the tracker's evidence, and the workspace rule is to
repair a check that fails for the runner's reasons rather than the code's. But
rewording a comment is usually cheaper than editing the spec, and it keeps the
invariant machine-checkable.

**How to apply:** run every Implementation checklist command yourself before
reporting, on the host, straight from `node_modules`. When one fails, read the
command before the code: if it is counting prose or splitting on a brace, say
so in the report and give the corrected command, then decide whether a reword
is the honest fix.

Related: [[a-proxy-refusal-position-is-checked-by-a-grep]].
