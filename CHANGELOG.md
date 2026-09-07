# Changelog

All notable changes to `openplate-sync` are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses
[semantic versioning](https://semver.org/spec/v2.0.0.html). Pre-1.0, a breaking
change moves the minor.

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
  `REQUIRE_EMAIL_VERIFICATION` remain boot failures — mail is `MAIL_API_*` now.
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
  can send mail, and `ai` — `{ "model": … }` when an upstream is configured and
  `null` otherwise. Descriptive, never a grant: an account with an allowance of
  zero gets a 403 whatever it says.
- **`AI_MAX_REQUEST_BYTES`, default 8 MB** — the proxy route's body limit,
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
   (`pnpm sync-api accounts set-limit <id> <n>` — it defaults to 0), and stop
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
