---
name: a-required-instanceinfo-field-reddens-five-fixtures
description: Adding a required field to InstanceInfo in openplate-core breaks five hand-written instance literals plus one deepEqual, none of them near protocol.ts
metadata:
  type: project
---

A new required boolean on `InstanceInfo` (`src/protocol.ts`) is a six edit
change. tsc names five of them; the sixth only fails at runtime.

**Why:** the handshake block is typed at every construction site rather than
built by one factory, and `feedback-retention-advertised.test.ts` asserts the
whole block with `deepEqual`, which tsc cannot see.

**How to apply:** after the protocol edit, expect to touch `src/main.ts`,
`tests/integration/service-harness.ts`,
`tests/integration/admin-invites-mail.test.ts`,
`tests/unit/health-notice.test.ts` (two literals),
`tests/unit/feedback-retention-advertised.test.ts` (a literal AND a
`deepEqual`). Build the harness field from the SAME binding that mounts the
surface, as `main.ts` does, or a `create-app` that forgets to report it passes
every suite.

Related: [[an-account-view-field-is-pinned-by-four-lists]]
