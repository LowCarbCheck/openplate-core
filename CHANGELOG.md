# Changelog

All notable changes to `openplate-core` are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses
[semantic versioning](https://semver.org/spec/v2.0.0.html). Pre-1.0, a breaking
change moves the minor.

## [Unreleased]

### Added

- **A shrinking blob is acknowledged, or it is refused.**
  A push whose ciphertext is under half the stored version's `size_bytes` is
  now answered `400` unless the request body carries
  `"shrinkAcknowledged": true`. Absent means false, so every deployed client
  says no and none of them can wipe an account. A person lost her whole diary
  on 2026-09-12 to a client that found its local store evicted, concluded she
  had deleted every entry, and pushed a tombstone for each one, 5310 bytes to
  1588 in one accepted write; a second device then pulled that blob and deleted
  its own rows. A client fix reaches nobody who has not updated, and an
  installed progressive web app cannot be made to update, so the refusal lives
  here. The guard reads `size_bytes`, which this service already stored and
  already reported, so it discloses nothing new. What it gives up is the claim
  to be a store with no opinion about what it holds. `400` and not `409`,
  because `409` already means "another device wrote first" on this route and
  obliges a client to push the same bytes again. A body field and not a header,
  because a new header must be named in the CORS allow list or browsers drop
  the request after a clean preflight.
  ADR 0009 states the trade: the false positives cost a field, the false
  negatives cost data.

- **Tiered blob retention, and a pin on the version before an acknowledged shrink.**
  `BLOB_VERSION_RETENTION` keeps its name and its five, and becomes one tier of
  three: the newest 5 versions, the newest version of each UTC calendar day for
  14 days, and up to 14 versions held for 14 days because an acknowledged large
  shrink replaced them. At most 33 versions and 66 MiB per account, and the
  daily tier is per calendar day rather than per count so two devices in a merge
  loop cannot burn through it. The flat five was the only reason the wiped diary
  above was recoverable at all, and by luck.

- **An operator can roll a blob back.**
  `GET /v1/admin/accounts/:id/blob/versions` lists every retained version with
  its byte count, its time and its pin, and never its bytes.
  `POST /v1/admin/accounts/:id/blob/rollback` makes an older version current
  again by deleting the versions above it, refusing an unknown version, the
  current version, an envelope format this build cannot accept and a zero-byte
  row. A rollback rather than a re-upload because the envelope binds
  `blobVersion` into its AAD: re-inserting old bytes as a new version yields
  something no client could ever decrypt.
  `pnpm sync-api accounts blob-versions <id>` and
  `pnpm sync-api accounts rollback <id> --to-version <n> --yes`.
  `docs/operations/restoring-a-wiped-diary.md` is the playbook, and its
  non-negotiable step is the one the rollback cannot do: every device the person
  signed into still holds the baseline that caused the loss, and has to have its
  local data erased before it syncs again.

### Changed

- `sync_blobs` gains a nullable `pinned_until`. Migration `0016`.

## [0.13.0] - 2026-09-12

### Added

- **Web push, carrying a kind and never a sentence.**
  Four member routes under `/v1/push` let a device register where to reach it,
  the minute of its own local day it wants a morning catch-up, and the instant
  a fast reaches its target. A minute tick sends at most two pushes per
  subscription per UTC day, pauses for anybody who has not opened the app in
  seven local days, and deletes a subscription the push service answers 404 or
  410 for. The payload is `{"kind":"catch-up"}` or `{"kind":"fast-target"}`:
  the device writes the words, because this server cannot read the diary they
  describe. Set `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY` and `VAPID_SUBJECT`
  together, or none of them and the whole subtree answers the ordinary 404 and
  `/health` reports `push: false`. `pnpm sync-api push keygen` prints a pair.
  ADR 0008 names push scheduling as the fourth exception to zero knowledge and
  the `wake_at` correlation with the pulse's presence row.
  `GET /v1/admin/stats` gains `push: { subscriptions, sentToday }`.

- **An opt-in pulse: instance-wide counts for the day, and who is fasting right now.**
  Four member routes under `/v1/pulse` take small rounded deltas from devices
  whose owner turned the pulse on (a meal with its calories rounded to 50 and
  protein to 5 g, a photo, a "still fasting" heartbeat) and answer today's sums
  plus the live fasting count from a 5 minute cache. Day sums keep 30 days,
  presence rows expire 30 minutes after the last heartbeat, idempotency keys
  24 hours, all swept hourly. The routes log no account id. ADR 0007 names the
  pulse as the third exception to zero knowledge; `PROTOCOL.md` §5.23 has the
  wire shapes. `GET /v1/admin/stats` gains the same numbers.

### Fixed

- **Browsers could not send a pulse write, or read a Retry-After.**
  `Access-Control-Allow-Headers` never named `Idempotency-Key`, which every
  write under `/v1/pulse` carries, so a browser read the preflight and refused
  to send the request at all: no request arrived, no log line was written, and
  the app saw a write that never answered. The same response now also sends
  `Access-Control-Expose-Headers: Retry-After`, so a rate-limited client can
  read the wait this service computed instead of guessing one. Both were
  invisible to `curl` and to the test suite, because neither enforces CORS;
  operators need no configuration change, only the new image.

## [0.12.0] - 2026-09-09

### Added

- **A billing principal reaches two fields and nothing else.** `BILLING_TOKEN`
  authenticates a caller scoped to reading and writing only `dailyAiLimit` and
  `allowanceExpiresAt` on one account, off unless you set it.
- **`/v1/plans` passes an authenticated caller through to one upstream.**
  `PLANS_UPSTREAM_URL` and `PLANS_UPSTREAM_SECRET` turn it on; unset, the
  whole subtree answers the ordinary unknown-path 404.

## [0.11.0] - 2026-09-09

### Added

- **An account's AI allowance can carry an expiry date.** `allowanceExpiresAt` is
  nullable and stays off unless an admin sets one on an account; sync never
  gates on it, only the AI proxy does.
- **The instance can cap its own total AI spend.** `AI_INSTANCE_DAILY_LIMIT`
  bounds every account together in requests per UTC day, and it is off unless
  you set it.
- **A member can invite up to five people on the instance's own terms.**
  `MEMBER_INVITE_DAILY_AI_LIMIT` and `MEMBER_INVITE_ALLOWANCE_DAYS` set the
  allowance a member's invitation carries, and the whole feature is off unless
  both are configured.

## [0.10.0] - 2026-09-09

### Changed

- **The repo, the package and the published image are now `openplate-core`.**
  The hostname `sync.openplate.de`, the `/v1/sync` routes, the
  `SYNC_SERVER_URL` env var and the `pnpm sync-api` CLI are unchanged; only
  the project's own name moved. A self-hoster's only action is to repoint
  their image reference to `ghcr.io/lowcarbcheck/openplate-core`.

## [0.9.0] - 2026-09-08

### Added

- **One activity read for a whole page of accounts.** `GET /v1/admin/activity`
  returns the same daily photo counts as the single account endpoint, for every
  account on a page, in the order `GET /v1/admin/accounts` returns them. The
  console draws a strip beside every row of its people list, and the only way
  to do that before was one request per person. It pages exactly like the
  accounts list, same defaults, same bounds, same refusal, so a caller reads
  the two in lockstep. The store beneath it reads the whole page in one query
  rather than moving the N+1 down a layer.

  Every account on the page is in the answer, including one that has never made
  a request, whose strip is zeroes. Leaving it out would make "this person did
  nothing" and "this person was not in the answer" the same fact, which is the
  distinction the zero fill exists to keep.

### Changed

- The paging refusal that `GET /v1/admin/accounts`, `GET /v1/admin/activity`
  and the feedback list all answer with is now one sentence in one place. It
  also drops an en dash for a hyphen.

## [0.8.0] - 2026-09-08

### Added

- **An operator can see who is actually using the instance.** `last_seen_at`
  now reaches the admin account view, and `GET /v1/admin/accounts/:id/activity`
  returns a bounded, zero-filled strip of daily photo counts. Both facts were
  already in the database and read by nothing, so this is a read path and not a
  new collection: no migration, no new write, and nothing about a person that
  was not already recorded. The blobs stay end to end encrypted and no endpoint
  added here exposes any diary content.

  The window is zero filled on purpose. A day with no activity and a day
  outside the window must not look the same to whoever reads the strip, because
  "they stopped" is exactly the question the strip is for.

### Changed

- **`ai_usage_days` now expires at ninety days.** Nothing pruned it before, and
  the schema said so. A per-day activity log kept for the life of a deployment
  is health-revealing on its own, so the retention limit landed together with
  the screen that reads it rather than after it. `AI_USAGE_RETENTION_DAYS` is
  one definition, shared by the prune and by the longest activity window the API
  will draw, so a pruned row can never be served as a quiet day.

- **The usage sweep runs on every instance, not only where AI is configured.**
  It used to sit behind `config.ai`, which left exactly the wrong case
  unswept: an instance that had an upstream key once and none today kept those
  rows forever.

- `last_seen_at`'s comment no longer claims the AI proxy is its only writer.
  A login writes it too, and the comment had been wrong since login was added.

## [0.7.0] - 2026-09-07

### Added

- **A person can report a wrong estimate, and this service can hold what they
  send.** `POST /v1/feedback` takes an entry's figures, its consent record and
  optionally the photograph. `GET`/`DELETE /v1/admin/feedback` let an
  administrator read and remove one. A sweep deletes anything past the retention
  window without an operator remembering to.

  **This is the second place this service's zero-knowledge position does not
  hold, and it is not the same shape as the first.** The AI proxy sees a
  photograph and keeps nothing. This KEEPS what it is given, and an
  administrator can look at it. Read
  `docs/adr/0006-a-reported-photograph-is-the-second-hole-in-the-claim.md`
  before you turn it on.

- **`SYNC_FEEDBACK`, off by default.** Unset, the whole `/v1/feedback` and
  `/v1/admin/feedback` tree answers the ordinary 404 any unknown path answers,
  to everybody, with or without a valid token. An instance without it is
  indistinguishable from one built before the feature existed, which is the same
  bargain `SYNC_SHARING` and `SYNC_RESEARCH` make. `FEEDBACK_DAILY_LIMIT` and
  `FEEDBACK_MAX_REQUEST_BYTES` bound it.

- **The retention window is advertised on `GET /health`** (`instance.feedback.retentionDays`,
  PROTOCOL.md 5.6), so the client shows the window this server will actually
  apply rather than a number of its own. With the feature off the key is absent,
  not null. The window is one constant here; there is no second copy anywhere to
  drift from it.

- **Migration `0010`.** `feedback_reports` and `feedback_images`, both cascading
  from the account, so erasing an account removes its reports and its
  photographs. The idempotency key is unique PER ACCOUNT, so one account cannot
  burn a key value for another.

- The image is stored in this Postgres, behind a `FeedbackImageStore` interface
  with `put`, `get` and `delete`. There is no S3 client and no AWS dependency;
  the interface exists so a later move is one adapter and no caller change.

- Every read of a reported photograph is logged: which administrator, which
  report, when.

## [0.6.2] - 2026-09-07

- `PROTOCOL.md` now carries a sequence diagram of one session. It shows the
  version handshake, a sign-in, and a push, including the conflict path where
  the client fetches, merges and pushes again. The handshake is drawn failing
  closed.
- The README and the protocol were reworded to drop every em dash and en dash.
  No obligation changed, and every code span is byte for byte what it was.

## [0.6.1] - 2026-09-05

- The README now lists the published documentation (`PROTOCOL.md`) in a
  Documentation table, so the project site at openplate.de can quote it.
- A release now tells the site to re-quote the docs.

## [0.6.0] - 2026-09-04

One server. This service is now the whole backend an openplate deployment
needs: identity by email address, organization roles, an escrowed password
reset that restores the diary, and the AI proxy that used to live in a separate
gateway. The gateway is retired.

### BREAKING

- **`accounts.handle` is `accounts.email` again** (migration `0009`), unique per
  server, canonicalised with NFKC then trim then lowercase. `PROTOCOL.md` calls
  the field `email` everywhere, and the server rejects an address with no `@`.
  0.5.0's handles were a five-week detour; the reason for the return is that a
  password reset needs somewhere to send the letter.
- **PROTOCOL_VERSION is 2.** A 0.5.0 client sends a `handle` this server does
  not accept, and a 0.6.0 client sends an `email` a 0.5.0 server does not. The
  `/health` handshake (§6) turns that into a clear refusal rather than a
  partial failure. **The openplate client must be 0.10.0 or newer.**
- **Signup takes an ADDRESSED invite.** `POST /v1/auth/signup` reads the email
  from the invite row and ignores any address in the body, so the person who
  received the letter is the person who signs up. There is no confirmation
  link, because there is nothing left to confirm.
- **Signup writes both key records itself**, the passphrase-wrapped one and the
  recovery-wrapped one, in the same transaction as the account. A first
  `PUT /v1/sync/key-records` with `expectedUpdatedAt: null` is therefore a
  genuine `409` on any account created by this version: every put is a
  rotation now.
- **`SIGNUP_MODE` is removed and is a boot failure**, along with the older
  `SIGNUPS_OPEN`. Signup is invite-only, always; there is no mode to set and
  therefore no mode to get wrong. `EMAIL_FROM`, `SMTP_*`, `PIGEON_*` and
  `REQUIRE_EMAIL_VERIFICATION` remain boot failures, mail is `MAIL_API_*` now.
- **`POST /v1/sync/rotate-dek` requires `newRecoveryAuthHash` and
  `recoveryCode`.** The recovery verifier and the escrow are replaced in the
  same transaction as the wraps. Without that, a rotation left the old recovery
  code able to open the new data key, which is the opposite of what a rotation
  is for.
- **The openplate gateway is retired.** Its `/v1/chat/completions`, its family
  invites and its own account model are gone. Point the client's AI at this
  service instead; the request shape is unchanged, and the token is now the
  ordinary sync access token.

### Added

- **The AI proxy.** `POST /v1/chat/completions` forwards a signed-in account's
  completion request to the operator's provider, spending one unit of that
  account's daily allowance. The caller's token is replaced by the operator's
  key rather than merged with it, inbound headers are rebuilt rather than
  copied, responses stream, and **no body is ever logged**. Every string that
  came off the upstream wire passes through a scrubber before it reaches a log
  line or a response, because a provider that rejects a request routinely
  echoes the image back inside its error body. Configured with
  `UPSTREAM_BASE_URL` + `UPSTREAM_API_KEY`; unset, the route answers the
  ordinary unknown-path 404.
- **A per-account daily allowance** in `ai_usage_days`, reserved before the
  upstream call in one atomic statement and released only when the provider
  cannot have billed us. `X-Quota-Used` and `X-Quota-Limit` on every proxied
  answer; `429` with `Retry-After` to the next UTC midnight at the limit;
  `403 ai-not-allowed` for an allowance of zero, before anything leaves the
  host. Plus a per-account limiter of `AI_RATE_LIMIT_PER_MINUTE` (default 20),
  which is a different bound for a different failure: a stuck client retrying
  on every error.
- **A password reset that restores the diary.** The client's recovery code is
  sealed at signup into `accounts.recovery_code_escrow` under a subkey of
  `SERVER_SECRET`. `POST /v1/auth/reset/request` sends a link,
  `POST /v1/auth/reset/open` spends it once and returns the code, and the
  client then runs the ordinary recovery ceremony. **The reset endpoint writes
  nothing to the account.** The cost is stated in the README and argued in
  ADR-0005: the operator of a hosted instance can open any account on it.
- **Roles and standing.** `role` (`admin` | `member`), `daily_ai_limit`,
  `suspended_at` and `last_seen_at` on the account. An admin account reaches
  `/v1/admin` with its own access token, which is what puts the console in the
  app at `/admin` rather than in a shell; `ADMIN_TOKEN` remains as the
  break-glass credential and is still optional.
- **Mail.** `MAIL_API_URL` + `MAIL_API_KEY` + `MAIL_API_FROM`, all three or
  none, over pigeon's HTTP API. Two letters exist and no more: an invitation
  and a password reset, in English or German per `INSTANCE_LANGUAGE`. Unset,
  both come back to the operator as links to paste.
- **Admin writes.** `PATCH /v1/admin/accounts/:id` (role, allowance, display
  name, suspension), `POST /v1/admin/accounts/:id/reset-mail`,
  `POST /v1/admin/invites/:id/resend`, `total` on both lists, and
  `pendingInvites` / `admins` / `aiRequestsToday` on stats. Suspending revokes
  every session in the same act. An administrator cannot suspend, demote or
  delete **their own** account; the static token is exempt because it has no
  self and is the way back in.
- **CLI**: `accounts set-role`, `accounts set-limit`, `accounts suspend`,
  `accounts reactivate`, `accounts reset-mail`, `invites resend`, and
  `--daily-limit` on `invites create`.
- **`/health` reports `instance`**: the instance name, its language, whether it
  can send mail, and `ai`, `{ "model": … }` when an upstream is configured and
  `null` otherwise. Descriptive, never a grant: an account with an allowance of
  zero gets a 403 whatever it says.
- **`AI_MAX_REQUEST_BYTES`, default 8 MB**, the proxy route's body limit,
  sized for a camera photograph after base64 rather than for a stored blob. In
  the same change, every router's `express.json()` was scoped to its own path
  prefix: they are all mounted at the root, so an unscoped parser applied to
  the whole service and whichever ran first silently capped every other route.
  The visible effects were a `413` on every plate photograph and on any blob
  push over 64 KB.
- **`undici` as a runtime dependency**, the fourth after express, pg and
  dotenv. Node's global `fetch` applies a 300-second header timeout that an
  `AbortSignal` can only tighten, so an operator setting
  `UPSTREAM_TIMEOUT_MS=600000` would be cut off at 300 with an error naming no
  knob. It is external to the bundle.

### Removed

- `POST /v1/auth/verify-email` stays gone, and the 0.5.0 handle endpoints are
  replaced rather than renumbered. `SIGNUP_MODE` and `SIGNUPS_OPEN` are gone
  from the code and are boot failures if set.
- `signup_invites.note` is gone; the row carries `email`, `display_name`,
  `role`, `daily_ai_limit` and `revoked_at` instead. An invitation is addressed
  now, so an operator's private note has no place to be.

### Upgrading

1. **Back up the database and `SERVER_SECRET` together.** Migration `0009`
   renames a column and adds two tables. Neither half restores anything usable
   without the other, and this release makes that more true rather than less:
   the escrow is sealed under a subkey of that secret.
2. **Every account needs an email address.** The rename carries the handle over
   as-is, so any handle that is not an address must be corrected before the
   person can be sent a reset. `pnpm sync-api accounts list` shows what you
   have.
3. **Upgrade the client to 0.10.0 or newer, at the same time.** The protocol
   version moved, so a mixed pair refuses to talk rather than half-working.
4. **Set `MAIL_API_*` if you want the letters posted.** Unset, invitations and
   resets are returned to you as links, which is a complete and supported way
   to run this.
5. **Retire the gateway.** Move `UPSTREAM_BASE_URL` and `UPSTREAM_API_KEY` onto
   this service, give each account an allowance
   (`pnpm sync-api accounts set-limit <id> <n>`, it defaults to 0), and stop
   the gateway container. Its family invites have no equivalent here: a person
   gets a signup invitation instead, and one account covers both sync and AI.
6. **If you run your own Compose file**, add the new variables to its
   `environment:` block. Compose forwards only what that block names, so a
   variable set in `.env` alone never reaches the container.

## [0.5.0] - 2026-09-02

Identity without email. An account is a **handle** plus a passphrase, and a lost
passphrase is recovered with the recovery code the client showed the user at
signup. The service sends no mail and stores no email address.

### BREAKING

- **`accounts.email` is now `accounts.handle`** (migration `0007`), and
  `email_verified_at` is dropped. The server rejects any handle containing `@`,
  canonicalises with NFKC then trim then lowercase, and keeps it unique per
  server.
- **Removed endpoints**: `POST /v1/auth/verify-email`,
  `POST /v1/auth/request-reset`, `POST /v1/auth/reset`. They answer `404`.
  `PROTOCOL.md` §5.12 and §5.13 are marked REMOVED rather than renumbered, so
  section references in both repos still resolve.
- **Removed env vars, and each is a boot failure rather than a no-op**:
  `REQUIRE_EMAIL_VERIFICATION`, `CLIENT_BASE_URL`, `EMAIL_FROM`, `SMTP_HOST`,
  `SMTP_PORT`, `SMTP_USER`, `SMTP_PASSWORD`, `SMTP_SECURE`, `PIGEON_API_KEY`,
  `PIGEON_BASE_URL`. A container that refuses to start costs one deploy; a
  variable that is quietly ignored lets an operator believe mail is configured
  on a service that has no mailer.
- **A pre-0.5.0 client cannot talk to a 0.5.0 server.** It sends an `email`
  field that no longer exists and calls endpoints that are gone. The `/health`
  handshake (`PROTOCOL.md` §6) is what turns that into a clear refusal instead
  of a partial failure.
- **Signup invites now carry an `si_` prefix.** A token of the wrong shape is
  refused by a shape gate before any lookup, with the same answer an unknown or
  spent invite gets. A gateway `gi_` token can no longer be posted here.

### Added

- **The recovery code is the second authenticator.** `POST /v1/auth/recover`
  and `POST /v1/auth/recover-rotate` let a user who holds their recovery code
  set a new passphrase. The client derives its proof under a new frozen HKDF
  label, `openplate-sync:recovery-auth:v1`, which is deliberately never the
  recovery-KEK label. Both endpoints are throttled per IP and handle, and both
  answer every failure identically.
- `accounts.recovery_verifier` (migration `0008`), stored with the same peppered
  `computeVerifier` the passphrase uses.
- **The operator notice.** `SYNC_NOTICE` and the optional `SYNC_NOTICE_URL` are
  published on the `/health` handshake and shown by the client. It is pull, not
  push: the service still has no way to contact anyone. A notice over 280
  characters, or a URL whose scheme is not http(s), or a URL without a notice,
  is a boot failure.

### Removed

- `src/mail/` and all three transports (pigeon, SMTP, console), the
  email-verification and auth-reset token kinds, and the reset-link plumbing.
  The mailed reset was an account-takeover path that returned no recovery: the
  DEK is wrapped under keys the server never sees, so whoever redeemed a link
  got a login to a diary they still could not read.

### Changed

- Anti-enumeration is unchanged. The signup `409` stays the one accepted oracle,
  and it now leaks an opaque per-server handle rather than a person's address,
  which is strictly less.
- `docker/compose.yml` forwards `SYNC_NOTICE` and `SYNC_NOTICE_URL`, which the
  README and `.env.example` already documented as operator settings.
- Docs: `PROTOCOL.md`, `SECURITY.md`, `README.md` and `.env.example` match the
  service. `docs/adr/0004-identity-without-email.md` records the decision.

### Upgrading

Losing both the passphrase and the recovery code ends an account. There is no
third path, because a reset the server could perform would mean a server that
can open your data. Say this to your users before you upgrade.

## [0.4.1] and earlier

Not recorded here. See the git history.
