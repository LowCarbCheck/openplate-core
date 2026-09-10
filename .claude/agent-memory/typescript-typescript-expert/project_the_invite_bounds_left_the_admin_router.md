---
name: the-invite-bounds-left-the-admin-router
description: MAX_DAILY_AI_LIMIT and DEFAULT_INVITE_TTL_MS live in src/admin/invite-store.ts now, so config.ts can validate against them without importing express
metadata:
  type: project
---

M212 spec 03 moved `MAX_DAILY_AI_LIMIT` (10_000) and `DEFAULT_INVITE_TTL_MS`
(7 days) out of `src/server/admin-routes.ts` and into
`src/admin/invite-store.ts`. `MAX_INVITE_TTL_DAYS` and
`DEFAULT_INVITE_DAILY_AI_LIMIT` stayed on the router, because they only bound
that route's body.

**Why:** two new readers appeared that must not pull an Express router into
their graph. `src/config.ts` validates `MEMBER_INVITE_DAILY_AI_LIMIT` against
the ceiling at boot, and `src/accounts/auth-handlers.ts` gives the member mint
the same invite lifetime the admin default uses. `invite-store.ts` is the
invite contract and imports nothing but `protocol.js`, so it is the one place
both doors can read.

**How to apply:** a new bound that BOTH the admin mint and the member mint
obey belongs in `admin/invite-store.ts`; one that only parses an admin request
body stays in `server/admin-routes.ts`. The member mint is
`handleMintMemberInvite` in `accounts/auth-handlers.ts`, and its cap and
`invitesLeft` arithmetic live in `accounts/member-invites.ts`, which both
`toAccountView` builders call.

Related: [[an-account-view-field-is-pinned-by-four-lists]].
