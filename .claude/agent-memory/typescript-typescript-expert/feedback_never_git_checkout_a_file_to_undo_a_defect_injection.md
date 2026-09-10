---
name: never-git-checkout-a-file-to-undo-a-defect-injection
description: restore an injected defect from a /tmp copy, never with git checkout, which reverts the whole file to HEAD and destroys the session's work
metadata:
  type: feedback
---

To prove a new assertion can fail, break the code, run the test, then restore.
Restore from a copy taken BEFORE the injection
(`cp src/x.ts /tmp/x.orig.ts` ... `cp /tmp/x.orig.ts src/x.ts`), or by
reversing the exact string with the same script that applied it.

**Why:** `git checkout <file>` reverts to HEAD, not to the pre-injection state.
On 2026-09-09 it silently erased about eighty lines of finished, unrelated work
in `src/server/admin-routes.ts`; the injected line was gone, so the test result
looked correct, and only `git diff --stat` printing nothing gave it away.

**How to apply:** in an uncommitted working tree, treat `git checkout`,
`git restore` and `git stash` as destructive. Copy first, and confirm the
restore with `git diff --stat <file>` showing your real edits still present.

Related: [[parallel-agents-shared-worktree]].
