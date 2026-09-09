/**
 * Table definitions — the source of truth for this service's schema.
 *
 * Every change here must ship a generated migration: run `pnpm drizzle:generate`
 * and commit the resulting `drizzle/migrations/<n>_<name>.sql` +
 * `meta/_journal.json` alongside the edit. `pnpm drizzle:push` is a dev-only
 * convenience for a throwaway local database — it never reaches
 * `drizzle/migrations/`, so it never ships to anything that boots via the
 * migrator (which every deployment does; see `src/main.ts`). Never hand-edit
 * `when` timestamps in the journal: the migrator applies only migrations
 * newer than the last applied one, so an out-of-order value causes a later
 * migration to be SILENTLY skipped at boot with no error.
 *
 * `sync_blobs` and `sync_key_records` were relocated here from the openplate
 * app in M128 spec 02, together with the security-reviewed CAS adapter that
 * writes them (`db/storage-adapter.ts`). The migrations are a fresh baseline
 * rather than a port of the app's history: zero production blobs ever
 * existed, so there was nothing to migrate — only DDL to re-home.
 */
import { relations, sql, type InferInsertModel, type InferSelectModel } from 'drizzle-orm';
import {
  boolean,
  check,
  customType,
  date,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  serial,
  text,
  timestamp,
  uniqueIndex,
} from 'drizzle-orm/pg-core';
import type { AccountRole, SyncKeyRecordKind } from '../protocol.js';
import type { AccountTokenKind } from '../lib/tokens.js';
import type { KdfDescriptor } from '../lib/kdf-descriptor.js';
import type { JsonObject } from '../lib/json.js';

/**
 * Raw binary column (Postgres `bytea`). drizzle-orm's `pg-core` has no
 * built-in helper, so this is the documented `customType` pattern. Used for
 * opaque ciphertext only: the service stores and returns these bytes
 * verbatim and never parses them (PROTOCOL.md §10.5).
 */
const bytea = customType<{ data: Buffer; driverData: Buffer }>({
  dataType() {
    return 'bytea';
  },
});

// =============================================================================
// Accounts
// =============================================================================

/**
 * DELIBERATELY MINIMAL, and since M192 minimal about an ORGANIZATION rather
 * than about a stranger. An account is an identity, the material needed to
 * authenticate it, and the standing an operator granted it. There is still no
 * profile and no settings blob, because everything a user actually owns lives
 * inside the encrypted sync blob that this service cannot read.
 *
 * Future community features do NOT extend this table with a second set of
 * credentials; they authenticate through a separate lane that shares only the
 * `id` space. See `docs/adr/001-community-auth-lane.md` for why the vault
 * KDF/verifier material stays isolated.
 */
export const accounts = pgTable(
  'accounts',
  {
    id: serial('id').primaryKey(),
    /**
     * The account identifier: the person's EMAIL ADDRESS, canonicalised.
     *
     * It replaced the opaque `handle` of M181 in M192, and the inversion is
     * deliberate rather than a drift back (ADR-0005 supersedes ADR-0004's
     * prohibition 1). A handle was the right identity for a beta of one and
     * the wrong one for an organization: an employee who is invited by mail,
     * signs in on a second device a month later, and forgets everything in
     * between still knows their address. The address is also what makes an
     * invitation and a password reset deliverable at all.
     *
     * Stored already-normalized — NFKC, trim, lowercase, at most 254
     * characters, exactly one `@` (`accounts/auth-input.ts`'s `parseEmail`).
     * See the index below for why normalizing before the write is what makes
     * uniqueness true.
     */
    email: text('email').notNull(),
    /** Optional, cosmetic, editable by the owner and by an admin. */
    displayName: text('display_name'),
    /**
     * `'admin'` or `'member'`. An admin's own access token authenticates the
     * `/v1/admin` tree (`server/admin-auth.ts`), beside the operator's static
     * break-glass `ADMIN_TOKEN`.
     *
     * A TEXT COLUMN WITH A TYPE, not a Postgres enum: adding a role to an
     * enum needs its own migration and a lock, and the set of roles here is a
     * protocol constant (`protocol.ts`'s `ACCOUNT_ROLES`) that the input layer
     * already validates.
     */
    role: text('role').$type<AccountRole>().default('member').notNull(),
    /**
     * How many AI requests this account may make per UTC day. `0` — the
     * default, and what an invite that says nothing grants — means no AI at
     * all, refused with `403 ai-not-allowed` rather than silently ignored.
     * Spend is counted in `ai_usage_days`.
     */
    dailyAiLimit: integer('daily_ai_limit').default(0).notNull(),
    /**
     * The instant this account's AI allowance ends, or `NULL` for no end at
     * all. `NULL` is what every account created before M212 has and what a
     * self-hosted instance keeps: an operator who never sells anything never
     * sets a date.
     *
     * IT GATES AI AND NOTHING ELSE, and which side of it is load-bearing is
     * the whole content of this column. `ai/proxy.ts` refuses a request whose
     * `allowanceExpiresAt` is not after the instant it read the clock at, with
     * `403 allowance-expired`, BEFORE the quota reservation. Sync is
     * deliberately untouched: the diary belongs to the account, so a person
     * whose trial lapsed must still be able to sign in on a new device and
     * pull what they wrote. An expired allowance is a feature ending, not an
     * account ending, and deletion is the erasure path.
     *
     * IT IS A DATE ON THE ROW RATHER THAN A REMOTE FACT on purpose. An access
     * rule that ends because another service's cron fired fails OPEN when that
     * service is down, and what fails open here is the operator's provider
     * bill. Checked in the same `if` ladder that already refuses
     * `dailyAiLimit <= 0`, by the process that spends the money, it cannot be
     * lost.
     */
    allowanceExpiresAt: timestamp('allowance_expires_at'),
    /**
     * Set when an operator suspends the account, `NULL` while it is in good
     * standing. A suspended account cannot log in, refresh, sync or use AI:
     * every such call is `403 {"error":"account-suspended"}`.
     *
     * NOT A DELETION, and deliberately reversible. Deletion is the erasure
     * path and takes the ciphertext with it; suspension is the answer to
     * "this person left on Friday and we are not sure yet", and it must be
     * possible to undo without a restore.
     */
    suspendedAt: timestamp('suspended_at'),
    /**
     * The last time this account presented a live access token. Operator
     * diagnostics only — never a rate limit, never an authorization input.
     * Nullable because an account that has never signed in since the column
     * existed has no honest value to report.
     *
     * WRITTEN BY EXACTLY TWO PLACES, a login (`accounts/auth-handlers.ts`) and
     * a proxied completion (`ai/proxy.ts`), and deliberately not by the bearer
     * middleware: that would be one UPDATE on every authenticated request,
     * including every sync poll, to answer a question no code asks. Both
     * writers are acts a person took on purpose, so the column means what an
     * operator reads it as, and since M201 an operator does read it
     * (`server/admin-routes.ts`).
     */
    lastSeenAt: timestamp('last_seen_at'),
    /**
     * THE RECOVERY CODE, SEALED — and the one column on this service that a
     * reader should stop and think about.
     *
     * `iv(12) ‖ AES-256-GCM(escrowKey, recoveryCode) ‖ tag(16)`, under a
     * subkey of `SERVER_SECRET` derived at the frozen label
     * `openplate-sync:escrow-key:v1` (`lib/server-secrets.ts`, `lib/escrow.ts`).
     * The key lives in the environment, so a dumped table alone does not open
     * it; the operator of a managed instance holds both, so the operator can.
     *
     * SAID PLAINLY: this is a decryption capability on the server, and
     * ADR-0004 prohibition 5 forbade exactly that. ADR-0005 supersedes it with
     * its eyes open. An organization cannot hand every employee a code they
     * must never lose, and the operator of a managed instance already sees
     * every plate photo that passes through the AI proxy. The self-hosted,
     * personal instance keeps the old promise by simply being its own
     * operator.
     *
     * NULLABLE only transiently: `POST /v1/auth/signup` always writes one, and
     * an account with a `NULL` here is an account no mailed reset can restore.
     */
    recoveryCodeEscrow: bytea('recovery_code_escrow'),
    /**
     * `HMAC-SHA-256(serverPepper, clientAuthHash)`, hex — never the auth-hash
     * itself and never anything that can decrypt a blob. See
     * `lib/verifier.ts` for why this is a fast keyed hash and not a second
     * slow KDF.
     */
    verifier: text('verifier').notNull(),
    /**
     * The SECOND authenticator (M181 spec 02): `HMAC-SHA-256(serverPepper,
     * clientRecoveryAuthHash)`, hex, computed by the very same
     * `lib/verifier.ts` `computeVerifier` as the column above. Never the raw
     * hash, and never anything that opens a blob.
     *
     * THE CLIENT DERIVES ITS INPUT UNDER A LABEL THAT IS NOT THE RECOVERY-KEK
     * LABEL, and that separation is the whole security argument for this
     * column. `openplate-sync:recovery-auth:v1` is a sibling of
     * `openplate-sync:recovery-kek:v1`: both are HKDF branches over the raw
     * recovery code, and the KEK branch is what WRAPS the account's DEK. Were
     * the same output used for both, this service would be storing an HMAC of
     * the material that opens the diary, and "the operator cannot read your
     * data" would rest on SHA-256 being one-way rather than on the operator
     * never having held the value at all. Domain separation is what keeps the
     * claim structural.
     *
     * NULLABLE, because an account may be created without one. A `NULL` here
     * means the account has no second authenticator: a lost passphrase is then
     * terminal, which is stated plainly rather than papered over.
     */
    recoveryVerifier: text('recovery_verifier'),
    /**
     * Argon2id salt + cost parameters, served UNAUTHENTICATED to a new device
     * before login (PROTOCOL.md §5.7). Non-secret by construction — a salt
     * that has to be handed out cannot be a secret, and cost parameters are
     * published in the protocol anyway.
     */
    kdfDescriptor: jsonb('kdf_descriptor').$type<KdfDescriptor>().notNull(),
    createdAt: timestamp('created_at').defaultNow().notNull(),
    updatedAt: timestamp('updated_at')
      .defaultNow()
      .$onUpdate(() => new Date())
      .notNull(),
  },
  // Addresses are stored already-normalized (`lib/verifier.ts`'s
  // `normalizeEmail`: NFKC, trim, lowercase), so a plain unique index is a
  // true case-insensitive AND Unicode-form-insensitive uniqueness guarantee.
  // This index is also what makes concurrent signups for the same address safe
  // — never a read-then-insert check.
  (table) => [uniqueIndex('accounts_email_idx').on(table.email)],
);

export type InsertAccount = InferInsertModel<typeof accounts>;
export type SelectAccount = InferSelectModel<typeof accounts>;

// =============================================================================
// Account tokens
// =============================================================================

/**
 * Every opaque token this service issues. Since M181 that is session pairs and
 * nothing else: the two single-use link kinds went with the mailer
 * (`lib/tokens.ts` owns the kinds and their TTLs).
 *
 * Only digests are stored, so this table is not replayable if dumped. Rows
 * are retained after revocation rather than deleted: a presented-but-revoked
 * refresh token is the reuse signal that revokes its whole family, and you
 * cannot detect reuse of a row you deleted.
 */
export const accountTokens = pgTable(
  'account_tokens',
  {
    id: serial('id').primaryKey(),
    accountId: integer('account_id')
      .notNull()
      .references(() => accounts.id, { onDelete: 'cascade' }),
    kind: text('kind').$type<AccountTokenKind>().notNull(),
    /** SHA-256 hex of the raw token. The raw value exists only in the client's memory. */
    tokenHash: text('token_hash').notNull(),
    /**
     * Links an access token to the refresh token that minted it, and survives
     * rotation. `logout` revokes one family (one device); reuse detection
     * revokes the family of a replayed refresh token. Nullable because the
     * column outlived the link tokens, which had no lineage; every row written
     * today carries one.
     */
    familyId: text('family_id'),
    expiresAt: timestamp('expires_at').notNull(),
    /** Set once, never cleared. Revocation is permanent — a re-login mints new rows. */
    revokedAt: timestamp('revoked_at'),
    createdAt: timestamp('created_at').defaultNow().notNull(),
  },
  (table) => [
    // Lookup is always by digest, and a digest collision across accounts would
    // be an authentication bypass — so uniqueness here is a security property,
    // not an optimization.
    uniqueIndex('account_tokens_hash_idx').on(table.tokenHash),
    index('account_tokens_account_kind_idx').on(table.accountId, table.kind),
    index('account_tokens_family_idx').on(table.familyId),
    // Supports the periodic sweep of long-dead rows.
    index('account_tokens_expires_idx').on(table.expiresAt),
  ],
);

export type InsertAccountToken = InferInsertModel<typeof accountTokens>;
export type SelectAccountToken = InferSelectModel<typeof accountTokens>;

// =============================================================================
// Signup invites (M166, addressed in M192)
// =============================================================================

/**
 * One single-use capability to create ONE named account. Signup is invite-only
 * and always has been since M192: there is no open mode and no closed mode,
 * so this table is the only door.
 *
 * ADDRESSED TO ONE PERSON, which reverses M166's design on purpose. An invite
 * used to name nobody, so that the service stored nothing about a person who
 * had no account; it also meant the invite could not be mailed, the address
 * had to be typed again at signup, and nothing verified it. Addressing the
 * invite makes the mail deliverable and makes the invite ITSELF the address
 * verification: the person who received it at that mailbox is the person who
 * redeems it, and `POST /v1/auth/signup` reads the email from this row rather
 * than from the request body, which is why the body cannot claim another
 * address.
 *
 * The cost is stated rather than hidden: between minting and redemption this
 * table holds the address, the display name and the allowance of somebody who
 * has no account yet. An operator inviting their own colleagues is the case
 * this service is for; `DELETE /v1/admin/invites/:id` withdraws the row.
 *
 * NOT IN `account_tokens`, though the lifecycle rhymes. Every row in that
 * table belongs to an account (`account_id` is `NOT NULL`), and an invite by
 * definition exists before one does. Widening that column to nullable to fit
 * this in would weaken a constraint that protects every session token.
 */
export const signupInvites = pgTable(
  'signup_invites',
  {
    id: serial('id').primaryKey(),
    /** SHA-256 hex of the raw token, exactly as `account_tokens` stores its own. The raw value is shown once, at mint, and never persisted. */
    tokenHash: text('token_hash').notNull(),
    /**
     * The address this invite is for, canonicalised by the same `parseEmail`
     * the account column uses. It becomes `accounts.email` at redemption and
     * is never taken from the signup body.
     */
    email: text('email').notNull(),
    /** What the operator typed as the person's name, carried onto the account at redemption. Optional. */
    displayName: text('display_name'),
    /** The role the redeemed account gets. Defaults to `member`; an operator inviting a second admin says so here. */
    role: text('role').$type<AccountRole>().default('member').notNull(),
    /** The daily AI allowance the redeemed account gets. `0` means no AI, which is what an invite that says nothing grants. */
    dailyAiLimit: integer('daily_ai_limit').default(0).notNull(),
    expiresAt: timestamp('expires_at').notNull(),
    /**
     * Set when an operator withdraws a still-spendable invite, or when a newer
     * invite for the same address supersedes it. A revoked invite is refused
     * exactly as an expired one is, and with the same words.
     *
     * A COLUMN RATHER THAN A DELETE, unlike M166's `revoke`. An addressed
     * invite is re-issued by superseding it (`POST /v1/admin/invites` for an
     * address that already has a pending one), and an operator looking at the
     * list needs to see that the first letter went out and was replaced.
     */
    revokedAt: timestamp('revoked_at'),
    /** Set once, by the transaction that also creates the account. NULL means still redeemable. */
    redeemedAt: timestamp('redeemed_at'),
    /**
     * The account this invite produced.
     *
     * `set null`, NOT `cascade`. Deleting an account must not delete the
     * evidence that an invite was spent: a cascade would silently return a
     * used invite to a clean, unredeemed-looking state in every audit, and
     * `redeemed_at` would be the only survivor of a row that no longer
     * explains itself.
     */
    redeemedAccountId: integer('redeemed_account_id').references(() => accounts.id, { onDelete: 'set null' }),
    createdAt: timestamp('created_at').defaultNow().notNull(),
  },
  (table) => [
    // Lookup is always by digest, and a collision would let one invite redeem
    // as another — so uniqueness here is a security property, as it is on
    // `account_tokens`.
    uniqueIndex('signup_invites_hash_idx').on(table.tokenHash),
    // Supports the operator listing outstanding invites newest-first.
    index('signup_invites_created_idx').on(table.createdAt),
    // Supports "is there a pending invite for this address?", which every mint
    // asks in order to supersede one. NOT unique: an address may legitimately
    // have several rows over time — one redeemed, one revoked, one live.
    index('signup_invites_email_idx').on(table.email),
  ],
);

export type InsertSignupInvite = InferInsertModel<typeof signupInvites>;
export type SelectSignupInvite = InferSelectModel<typeof signupInvites>;

// =============================================================================
// Password resets (M192)
// =============================================================================

/**
 * One single-use capability to be told this account's escrowed recovery code,
 * once, at the address the account is named by.
 *
 * WHY THIS IS NOT THE MAILED RESET ADR-0004 DELETED. That flow let the link
 * holder REPLACE the verifier and the key records: a takeover that returned no
 * recovery, because the DEK stayed wrapped under keys the server never held.
 * This one writes nothing to the account. It hands back the recovery code the
 * server already holds in escrow (`accounts.recovery_code_escrow`), and the
 * CLIENT then runs the ordinary `POST /v1/auth/recover-rotate` ceremony with
 * it: prove the code, set a new passphrase, re-wrap the DEK, re-escrow a new
 * code — one transaction, exactly as before. The link is a delivery mechanism
 * for a credential the operator already has, never a new authority.
 *
 * The honest consequence is on `accounts.recovery_code_escrow`, not here: what
 * makes this endpoint possible is that the operator holds what opens a diary.
 *
 * ONE LIVE TOKEN PER ACCOUNT. A new request marks every older unconsumed row
 * for that account consumed, in the same transaction, so an old letter cannot
 * be redeemed after a new one was asked for.
 */
export const passwordResets = pgTable(
  'password_resets',
  {
    id: serial('id').primaryKey(),
    accountId: integer('account_id')
      .notNull()
      .references(() => accounts.id, { onDelete: 'cascade' }),
    /** SHA-256 hex of the raw `sr_` token. The raw value exists only in the mail that was sent. */
    tokenHash: text('token_hash').notNull(),
    expiresAt: timestamp('expires_at').notNull(),
    /**
     * Set once, by the statement that spends the token or by a later request
     * that supersedes it. Rows are kept rather than deleted so a spent token
     * is refused by the same predicate an expired one is, with no branch that
     * could tell the two apart.
     */
    consumedAt: timestamp('consumed_at'),
    createdAt: timestamp('created_at').defaultNow().notNull(),
  },
  (table) => [
    // Lookup is always by digest, and a collision across accounts would hand
    // one person another person's recovery code — uniqueness here is a
    // security property, exactly as it is on `account_tokens`.
    uniqueIndex('password_resets_hash_idx').on(table.tokenHash),
    // Supports superseding an account's older unconsumed rows on every request.
    index('password_resets_account_idx').on(table.accountId),
  ],
);

export type InsertPasswordReset = InferInsertModel<typeof passwordResets>;
export type SelectPasswordReset = InferSelectModel<typeof passwordResets>;

// =============================================================================
// AI usage (M192)
// =============================================================================

/**
 * One row per account per UTC day: how many AI requests it has spent against
 * `accounts.daily_ai_limit`.
 *
 * A COUNTER, NOT A LOG. There is no prompt, no response, no model, no
 * timestamp beyond the day, and no request id — nothing here says what anybody
 * asked. That is the whole design: a quota needs a number, and a number is all
 * this table is allowed to hold on a service that stores health-adjacent data
 * it cannot read.
 *
 * THE DAY IS UTC AND THE COLUMN IS A `date`, so the reset boundary is one the
 * client and the server agree on without a timezone negotiation, and
 * "yesterday" is never a range query. Rows accumulate at one per account per
 * active day, and M201 gave them an end date: `ai/usage-retention.ts` deletes
 * everything older than ninety days on an hourly sweep that runs on every
 * instance, so the table no longer grows for the life of a deployment. Ninety
 * is also the longest strip `GET /v1/admin/accounts/:id/activity` can draw, on
 * one binding, so a pruned row can never be read as a day somebody did
 * nothing.
 *
 * WRITTEN BY SPEC 03, which owns the proxy. Spec 01 creates the table and
 * reads today's count for `AccountView.aiUsedToday`.
 */
export const aiUsageDays = pgTable(
  'ai_usage_days',
  {
    accountId: integer('account_id')
      .notNull()
      .references(() => accounts.id, { onDelete: 'cascade' }),
    /** The UTC calendar day, `YYYY-MM-DD`. `mode: 'string'` because a date has no instant and a `Date` here would invent one. */
    day: date('day', { mode: 'string' }).notNull(),
    count: integer('count').default(0).notNull(),
  },
  (table) => [
    // The composite primary key IS the upsert target: one row per account per
    // day, reserved with an `ON CONFLICT DO UPDATE` that increments.
    primaryKey({ columns: [table.accountId, table.day] }),
  ],
);

export type InsertAiUsageDay = InferInsertModel<typeof aiUsageDays>;
export type SelectAiUsageDay = InferSelectModel<typeof aiUsageDays>;

/**
 * ONE ROW PER UTC DAY FOR THE WHOLE INSTANCE: how many AI requests every
 * account together has spent against the operator's ceiling
 * (`AI_INSTANCE_DAILY_LIMIT`). M212 spec 02.
 *
 * WHY THIS TABLE EXISTS AT ALL, when `ai_usage_days` above already holds every
 * number in it. A `SUM` over that table for one day is an operator STATISTIC
 * and cannot be a limit, for two independent reasons:
 *
 *  1. IT IS NOT MONOTONIC. `ai_usage_days.account_id` cascades on delete, so
 *     erasing an account removes the days it spent and the sum FALLS. A ceiling
 *     built on it would hand the instance free requests back every time
 *     somebody deleted themselves, which is the one thing a spend ceiling must
 *     never do.
 *  2. IT SCANS. That table's primary key is `(account_id, day)` with no index
 *     on `day` alone, and this number is needed on every single request.
 *
 * So the instance total is its own row, incremented in the same one-statement
 * upsert shape the per-account reservation uses (`ai/quota-store.ts`), and it
 * references nothing: no foreign key means no cascade means the day's spend
 * only ever goes up. THE TWO COUNTERS ARE NOT REDUNDANT, they answer different
 * questions: `ai_usage_days` answers "what did this person spend", this one
 * answers "what did this instance spend".
 *
 * A COUNTER, NOT A LOG, exactly as the table above is: a day and an integer,
 * and nothing that says who asked for what. The same ninety-day retention
 * sweep does NOT touch it yet, and it does not need to: at one row per day a
 * decade of instance history is 3650 rows.
 */
export const aiInstanceDays = pgTable('ai_instance_days', {
  /** The UTC calendar day, `YYYY-MM-DD`, and the whole primary key: one row per day for the instance. */
  day: date('day', { mode: 'string' }).primaryKey(),
  count: integer('count').default(0).notNull(),
});

export type InsertAiInstanceDay = InferInsertModel<typeof aiInstanceDays>;
export type SelectAiInstanceDay = InferSelectModel<typeof aiInstanceDays>;

// =============================================================================
// Sync blobs (relocated from the openplate app, M128 spec 02)
// =============================================================================

export const syncBlobs = pgTable(
  'sync_blobs',
  {
    id: serial('id').primaryKey(),
    /**
     * `onDelete: 'cascade'` is the self-serve DSAR mechanism: deleting an
     * account removes every blob it ever pushed in the same statement, with
     * no cleanup job to forget to run and no window where orphaned ciphertext
     * survives its owner. This closed the M118 privacy blocker.
     */
    accountId: integer('account_id')
      .notNull()
      .references(() => accounts.id, { onDelete: 'cascade' }),
    /**
     * Monotonic per-account version — the CAS token (PROTOCOL.md §5.1). A
     * push is accepted only when its `baseVersion` equals the current max;
     * a stale push is a `409`, never a blind overwrite that would silently
     * discard another device's unsynced changes.
     */
    blobVersion: integer('blob_version').notNull(),
    /** The envelope's wire-format version (`ENVELOPE_VERSION`), independent of the payload's own schema version. */
    envelopeVersion: integer('envelope_version').notNull(),
    /** Opaque ciphertext: `iv ‖ AES-256-GCM(...)` as one packed blob. The service never parses it and holds no key for it. */
    ciphertext: bytea('ciphertext').notNull(),
    /** Redundant with `ciphertext`'s length, but avoids reading a 2 MiB blob just to report storage usage. */
    sizeBytes: integer('size_bytes').notNull(),
    createdAt: timestamp('created_at').defaultNow().notNull(),
  },
  (table) => [
    // The CAS guarantee itself: two concurrent pushes off the same
    // `baseVersion` can both pass the read, but only one INSERT of the same
    // (account, version) pair can survive. Retention (N=5) is enforced by the
    // adapter's prune step — Postgres has no native "keep last N rows" rule.
    uniqueIndex('sync_blobs_account_version_idx').on(table.accountId, table.blobVersion),
    index('sync_blobs_account_idx').on(table.accountId),
  ],
);

export type InsertSyncBlob = InferInsertModel<typeof syncBlobs>;
export type SelectSyncBlob = InferSelectModel<typeof syncBlobs>;

// =============================================================================
// Sync key records (relocated from the openplate app, M128 spec 02)
// =============================================================================

export const syncKeyRecords = pgTable(
  'sync_key_records',
  {
    id: serial('id').primaryKey(),
    accountId: integer('account_id')
      .notNull()
      .references(() => accounts.id, { onDelete: 'cascade' }),
    /** Which KEK this record wraps the account's DEK under — `passphrase` or `recovery`. */
    kind: text('kind').$type<SyncKeyRecordKind>().notNull(),
    /** Argon2id salt + params for the `passphrase` kind; NULL for `recovery` (HKDF-only, nothing to record). */
    kdfDescriptor: jsonb('kdf_descriptor').$type<JsonObject>(),
    /** The account's DEK wrapped under this record's KEK, one packed `iv ‖ ciphertext‖tag` blob. Never unwrapped here. */
    wrappedDek: bytea('wrapped_dek').notNull(),
    /**
     * MILLISECOND precision, deliberately — `timestamp(3)`, not the `timestamp(6)`
     * a bare `timestamp()` gives you. Kept identical to `updatedAt` below so the
     * two are comparable; see that column for the whole reason.
     */
    createdAt: timestamp('created_at', { precision: 3 }).defaultNow().notNull(),
    /**
     * Also this row's CAS token: `PUT /v1/sync/key-records/:kind` requires the
     * caller's `expectedUpdatedAt` to match exactly (or be `null`, asserting
     * no row exists yet) before a write is accepted.
     *
     * MILLISECOND precision is therefore LOAD-BEARING, not cosmetic. The token
     * leaves here as an ISO-8601 string, which carries milliseconds; Postgres's
     * `now()` carries MICROSECONDS. While this column was a bare `timestamp`
     * (= `timestamp(6)`) an INSERT that let `defaultNow()` supply the value
     * stored a µs tail the wire could not express, so the token a client read
     * back was a truncation of the stored value and the exact-equality CAS
     * matched zero rows — every rotation 409'd forever (M160 spec 06).
     *
     * Declaring the precision fixes the CLASS rather than the instance: the
     * database now refuses to hold anything the protocol cannot round-trip, so
     * the next writer who reaches for `defaultNow()` here cannot reintroduce
     * the trap. `sync_shares` solves the same problem the other way, by writing
     * JS `Date`s on insert — that works, but only for as long as every future
     * insert remembers to.
     */
    updatedAt: timestamp('updated_at', { precision: 3 })
      .defaultNow()
      .$onUpdate(() => new Date())
      .notNull(),
  },
  (table) => [uniqueIndex('sync_key_records_account_kind_idx').on(table.accountId, table.kind)],
);

export type InsertSyncKeyRecord = InferInsertModel<typeof syncKeyRecords>;
export type SelectSyncKeyRecord = InferSelectModel<typeof syncKeyRecords>;

// =============================================================================
// Sync shares (ADR-0002 — sharing a diary without giving the server a key)
// =============================================================================

/**
 * A THIRD WRAP of an account's DEK, addressed to another account's public key.
 *
 * The server's position is unchanged by this table: it holds one more blob it
 * has no key for. `wrappedDek` here is the ADR's frozen 125-byte
 * `ephPub(65) ‖ iv(12) ‖ AES-256-GCM(KEK_share, DEK, aad=...)` construction,
 * and the AAD binds the wrap to its grantor and its recipient key — so a
 * malicious server splicing one patient's wrap into another patient's row
 * produces a tag failure rather than a misattributed diary.
 *
 * WHY THIS IS NOT A `kind` ON `sync_key_records`. That table's invariant is
 * one row per (account, kind), both kinds owner-held, both rotating together
 * through the atomic credential change of PROTOCOL.md §5.14. A share is
 * multi-valued, is held by a DIFFERENT principal, has a grant/revoke
 * lifecycle rather than create/rotate, and must never ride through
 * change-passphrase or reset — those rotate KEKs, and a share has no KEK to
 * rotate. A nullable discriminator would make the unique index partial and
 * fork every kind-validation branch.
 *
 * THE GRANTEE'S PUBLIC KEY IS NOT STORED HERE, only a fingerprint used for
 * pinning. Storing the key would make this service the clinician key
 * directory ADR-0002 rejects outright — a trust role a zero-knowledge service
 * does not have. The full public key is pinned inside the grantor's own
 * encrypted snapshot.
 *
 * REVOCATION IS A HARD DELETE. There is deliberately no tombstone column: a
 * whole-database restore predates the revoke and so lacks the tombstone too,
 * which means it cannot prevent what it never contains, and re-creating a row
 * needs the grantor's own bearer token AND a fresh wrap only the grantor's
 * client can produce — a re-grant, which is a legitimate act. Against that
 * zero defensive value stands a permanent server-side assertion that a named
 * patient was under a named clinician's care, outliving its own revocation.
 */
export const syncShares = pgTable(
  'sync_shares',
  {
    id: serial('id').primaryKey(),
    /** The grantor — the account whose blob is being shared. Cascades: deleting it kills every grant it made. */
    accountId: integer('account_id')
      .notNull()
      .references(() => accounts.id, { onDelete: 'cascade' }),
    /** The grantee — the account the wrap is addressed to. Cascades: deleting it kills every wrap aimed at it. */
    granteeAccountId: integer('grantee_account_id')
      .notNull()
      .references(() => accounts.id, { onDelete: 'cascade' }),
    /** The grantor's DEK wrapped to the grantee's public key. Opaque here; the service holds no key for it. */
    wrappedDek: bytea('wrapped_dek').notNull(),
    /** Pinning metadata only (see the table doc) — never a key, and never served as one. */
    recipientKeyFingerprint: text('recipient_key_fingerprint').notNull(),
    /** Millisecond precision, for the reason recorded on `updatedAt` below. */
    createdAt: timestamp('created_at', { precision: 3 }).defaultNow().notNull(),
    /**
     * Also this row's CAS token, exactly as for `sync_key_records`: a
     * re-wrap after a DEK rotation can race a re-grant, so
     * `PUT /v1/sync/shares/:granteeAccountId` requires the caller's
     * `expectedUpdatedAt` to match (or be `null`, asserting no row yet).
     *
     * MILLISECOND PRECISION, DECLARED, NOT MERELY WRITTEN. A bare `timestamp`
     * is `timestamp(6)`, and the wire carries ISO-8601 at millisecond
     * precision — so a token read back over the wire is a TRUNCATION of what
     * is stored, the exact `eq()` below it never matches, and every rotation
     * 409s forever. That is not hypothetical: it shipped on
     * `sync_key_records` and made "Regenerate recovery code" permanently
     * impossible, with an error blaming another device.
     *
     * `putShare` also writes millisecond `Date`s, which is what kept this
     * table correct before this line existed. That fixes the instance; this
     * line fixes the class, because it stops the next writer who reaches for
     * `defaultNow()` from bringing the trap back.
     */
    updatedAt: timestamp('updated_at', { precision: 3 })
      .defaultNow()
      .$onUpdate(() => new Date())
      .notNull(),
  },
  (table) => [
    // The stable identity of a share is the (grantor, grantee) PAIR — that is
    // what has to survive a DEK rotation, and it is why both sides of the API
    // address a share by the counterpart's account id and never by `id`.
    uniqueIndex('sync_shares_pair_idx').on(table.accountId, table.granteeAccountId),
    // The grantee's "what has been shared with me" read.
    index('sync_shares_grantee_idx').on(table.granteeAccountId),
    // A self-share is nonsense the schema can refuse outright: the wrap would
    // be addressed to a key the account already has a plainer route to.
    check('sync_shares_not_self', sql`${table.accountId} <> ${table.granteeAccountId}`),
  ],
);

export type InsertSyncShare = InferInsertModel<typeof syncShares>;
export type SelectSyncShare = InferSelectModel<typeof syncShares>;

// =============================================================================
// Research contributions (ADR-0003 — pseudonymous, but never anonymous)
// =============================================================================

/**
 * A REDUCED, DATE-BOUNDED SLICE of one contributor's diary, sealed to one
 * study's public key. It is a different artifact from a share, not a narrower
 * one: different payload, different key, different lifecycle, and NO DEK is
 * involved at all — the wrap is over the payload directly (PROTOCOL.md §3.5).
 *
 * WHY THIS IS NOT A `kind` ON `sync_shares`. ADR-0003 opens by forbidding
 * exactly that shortcut: "the researcher case must never be built as a share
 * with a smaller UI. A scope enforced by the viewing client is not data
 * minimisation." A share hands over a wrapped DEK and therefore a key to the
 * whole diary; this row hands over a fixed, day-granular projection and
 * nothing else. Reusing the share table would make the difference a UI
 * decision.
 *
 * THE COLUMN THAT IS THE WHOLE PRIVACY DESIGN, AND THE ONE THAT IS NOT HERE.
 * `pseudonym` is `HMAC-SHA-256(root, "openplate-sync:study-pseudonym:v1" ‖
 * studyAccountId)` computed on the contributor's device from a root the
 * server never holds. The server neither computes nor verifies it — it
 * cannot. `contributor_account_id` sits beside it because erasure, cascade
 * and CAS all need to find the row, and ADR-0003 discloses that edge in
 * PROTOCOL.md §9.2 rather than pretending to avoid it. **It stops here: no
 * study-side response, export or endpoint ever carries it** (prohibition 2).
 * That is the deliberate inversion of §5.16's `grantorAccountId`, which is
 * *required* there because §3.2's AAD binds it; §3.5's AAD was designed so
 * this lane never needs one.
 *
 * `body` is opaque: `ephPub(65) ‖ iv(12) ‖ AES-256-GCM(KEK_research, payload,
 * aad)`. Variable length, unlike the share wrap, because the payload is a
 * window of days rather than a 32-byte DEK.
 *
 * WITHDRAWAL IS A HARD DELETE, and unlike the share case a tombstone DOES
 * follow — into `research_withdrawals`, keyed by pseudonym alone. The two
 * facts are written in one transaction (`db/research-store.ts`).
 */
export const researchContributions = pgTable(
  'research_contributions',
  {
    id: serial('id').primaryKey(),
    /** The contributor. Cascades: deleting the account erases every contribution it ever pushed, with no cleanup job. */
    contributorAccountId: integer('contributor_account_id')
      .notNull()
      .references(() => accounts.id, { onDelete: 'cascade' }),
    /** The study — an ordinary account (ADR-0003 D6: no principal type, no registry). Cascades from its end too. */
    studyAccountId: integer('study_account_id')
      .notNull()
      .references(() => accounts.id, { onDelete: 'cascade' }),
    /** Client-computed, server-unverifiable. See the table doc; this is the only identifier a researcher ever sees. */
    pseudonym: text('pseudonym').notNull(),
    /** The fixed tier the payload conforms to (`daily-intake:v1`). Frozen by protocol revision, never by configuration. */
    schemaTier: text('schema_tier').notNull(),
    /** The sealed payload. Opaque here — the service holds no key for it and never parses it. */
    body: bytea('body').notNull(),
    /**
     * MONOTONIC per (contributor, study) — the CAS token of PROTOCOL.md
     * §5.18, and an integer rather than a timestamp for the same reason the
     * blob's is: it also rides in the AAD, so a rollback to an older
     * contribution is what the check has to refuse.
     */
    contributionVersion: integer('contribution_version').notNull(),
    /** Millisecond precision, for the reason recorded on `sync_key_records.updatedAt`. */
    createdAt: timestamp('created_at', { precision: 3 }).defaultNow().notNull(),
    /**
     * Millisecond precision, DECLARED. This column is not itself a CAS token
     * — `contribution_version` is — but it is served to the study client as
     * an ISO-8601 string, and `scripts/assert-ms-precision.mts` holds the
     * whole service to one rule rather than to a per-column judgement about
     * which timestamps will one day be compared for equality. A bare
     * `timestamp` is `timestamp(6)`; the wire carries milliseconds; the gap
     * between those two already shipped once and made every CAS-gated
     * rotation impossible.
     */
    updatedAt: timestamp('updated_at', { precision: 3 })
      .defaultNow()
      .$onUpdate(() => new Date())
      .notNull(),
  },
  (table) => [
    // One live contribution per (contributor, study): the row is a projection
    // the client recomputes and re-pushes whole, never an append log.
    uniqueIndex('research_contributions_pair_idx').on(table.contributorAccountId, table.studyAccountId),
    // The study's cohort read, which is the only high-cardinality query here.
    index('research_contributions_study_idx').on(table.studyAccountId),
    // ONE PSEUDONYM PER STUDY, structurally. Two contributors submitting the
    // same pseudonym would silently merge into one participant series, and a
    // researcher would analyse two people as one without anything failing --
    // the confident-wrong-number class this whole design exists to avoid.
    //
    // An accidental collision is ~2^-128 (§3.5 truncates an HMAC to 128 bits),
    // and a deliberate one needs a pseudonym only the study can see, so this
    // constraint should never fire. That is the point: it costs nothing and it
    // makes the corruption impossible rather than improbable.
    uniqueIndex('research_contributions_study_pseudonym_idx').on(table.studyAccountId, table.pseudonym),
    // Contributing to yourself is nonsense the schema can refuse outright.
    check('research_contributions_not_self', sql`${table.contributorAccountId} <> ${table.studyAccountId}`),
  ],
);

export type InsertResearchContribution = InferInsertModel<typeof researchContributions>;
export type SelectResearchContribution = InferSelectModel<typeof researchContributions>;

/**
 * THE TOMBSTONE, AND THE COLUMN THAT MUST NEVER EXIST HERE.
 *
 * ADR-0003 prohibition 6: withdrawal is one transaction — hard-delete the
 * contribution, insert this row — and **no account id survives on any
 * withdrawal record**. There is deliberately no `contributor_account_id`
 * column below, and adding one would defeat the entire point: the live system
 * forgets *who* withdrew and remembers only *that a pseudonym withdrew*. The
 * account edge dies with the contribution row; what remains is exactly the
 * payload the erasure obligation needs, which is which pseudonym the study
 * client must purge.
 *
 * ADR-0002 rejected tombstones for shares and that argument does not transfer:
 * there a tombstone defended nothing, here it carries the instruction.
 *
 * The study foreign key cascades, so deleting a study account takes its
 * withdrawal ledger with it — a tombstone for a study that no longer exists
 * instructs nobody.
 */
export const researchWithdrawals = pgTable(
  'research_withdrawals',
  {
    id: serial('id').primaryKey(),
    /** Which study must purge. The only account id on this table, and it is the RECIPIENT's, never the contributor's. */
    studyAccountId: integer('study_account_id')
      .notNull()
      .references(() => accounts.id, { onDelete: 'cascade' }),
    /** The whole payload of the obligation: purge this pseudonym. Unlinkable to an account without the contributor's root. */
    pseudonym: text('pseudonym').notNull(),
    /** Millisecond precision, for the reason recorded on `researchContributions.updatedAt`. */
    withdrawnAt: timestamp('withdrawn_at', { precision: 3 }).defaultNow().notNull(),
  },
  (table) => [
    // Re-enrolling and withdrawing again is the same pseudonym (the derivation
    // is deterministic), so this is an ordinary event, not a race: the store
    // refreshes `withdrawn_at` on conflict.
    uniqueIndex('research_withdrawals_pair_idx').on(table.studyAccountId, table.pseudonym),
    // A blank pseudonym is an instruction to purge nothing, which is a
    // withdrawal that erases nothing while reporting success. The database
    // refuses to hold one — and that refusal is what makes the atomicity of
    // `withdrawContribution` falsifiable with a LATE failure, after the
    // contribution row has already been deleted inside the transaction.
    check('research_withdrawals_pseudonym_present', sql`length(${table.pseudonym}) > 0`),
  ],
);

export type InsertResearchWithdrawal = InferInsertModel<typeof researchWithdrawals>;
export type SelectResearchWithdrawal = InferSelectModel<typeof researchWithdrawals>;

// =============================================================================
// Reported estimates (M200 spec 05)
// =============================================================================

/**
 * A wrong measurement, reported by the person who saw it, with their consent.
 *
 * READ THIS BEFORE YOU CHANGE ANYTHING HERE. Every other table in this file
 * holds something the operator cannot read: ciphertext, a digest, a counter, a
 * sealed envelope. This one holds a person's figures in the clear, and
 * `feedback_images` beside it holds their photograph. It is the SECOND place
 * this service's zero-knowledge position does not hold, and it is not the same
 * shape as the first: the AI proxy sees a photograph and keeps nothing, this
 * KEEPS what it is given. See
 * `docs/adr/0006-a-reported-photograph-is-the-second-hole-in-the-claim.md`.
 *
 * THE WHOLE TABLE IS THE ALLOWLIST. Four things are stored: who reported it,
 * what the figures were, whether an image came with it, and what wording the
 * person agreed to and when. There is no diary content, no food name beyond
 * what the reported entry itself carries, no device, no user agent and no IP.
 * A column added here is a column an operator can read, so adding one is a
 * privacy decision and belongs in the ADR before it belongs in this file.
 *
 * `onDelete: 'cascade'` on the account is the same erasure mechanism
 * `sync_blobs` uses: deleting an account takes its reports, and through
 * `feedback_images`'s own cascade its photographs, in the same statement.
 */
export const feedbackReports = pgTable(
  'feedback_reports',
  {
    id: serial('id').primaryKey(),
    accountId: integer('account_id')
      .notNull()
      .references(() => accounts.id, { onDelete: 'cascade' }),
    /**
     * The client's own key for this report, so a retried send is a no-op
     * rather than a second report.
     *
     * UNIQUE PER ACCOUNT, NOT GLOBALLY, and the difference is a real one: a
     * globally unique column lets any account permanently burn a key value for
     * everybody else by sending it first. The client generates these, so the
     * value space is whatever a client chooses, and a shared namespace across
     * accounts is a denial of service with no upside.
     */
    idempotencyKey: text('idempotency_key').notNull(),
    /**
     * The figures the person is disputing, verbatim as the client sent them.
     *
     * `jsonb` rather than columns because the server has no opinion about the
     * shape of a measurement and must not grow one: a column per nutrient here
     * would be this service learning the app's food model, which is the thing
     * it has spent every other table not doing. The route bounds its SIZE and
     * nothing else.
     */
    measurements: jsonb('measurements').$type<JsonObject>().notNull(),
    /**
     * Whether a photograph came with this report.
     *
     * STORED, NOT DERIVED FROM `feedback_images`. A report sent from a device
     * whose photo cache had already evicted the image is a legitimate report
     * with no image, and a reviewer has to be able to tell that apart from an
     * image that was stored and later deleted by retention or erasure. A join
     * that finds no row cannot answer which of the two happened.
     */
    hasImage: boolean('has_image').notNull(),
    /**
     * When the person agreed, by their own clock.
     *
     * A DEVICE-LOCAL FLAG PROVES NOTHING TO THE PERSON LOOKING AT THE IMAGE
     * LATER, which is the whole reason this column and the one below are on
     * the row rather than in the client's local storage. What was agreed to
     * travels with what was sent.
     */
    consentAgreedAt: timestamp('consent_agreed_at').notNull(),
    /**
     * WHICH WORDING was shown, by version identifier, not the wording itself.
     *
     * The text lives in the client's locale bundles under version control, so
     * an identifier plus a git history answers "what did this person actually
     * read" exactly, and storing the paragraph on every row would only make
     * that answer disagree with itself once somebody fixes a typo.
     */
    consentWordingVersion: text('consent_wording_version').notNull(),
    createdAt: timestamp('created_at').defaultNow().notNull(),
  },
  (table) => [
    // The idempotency guarantee, enforced by the database rather than by a
    // read-then-write in the route: two retries that arrive together
    // serialise on this index and exactly one row survives.
    uniqueIndex('feedback_reports_account_key_idx').on(table.accountId, table.idempotencyKey),
    // The per-account daily limit counts an account's rows for the current UTC
    // day, and the admin list of spec 06 reads newest first.
    index('feedback_reports_account_created_idx').on(table.accountId, table.createdAt),
    check('feedback_reports_key_present', sql`length(${table.idempotencyKey}) > 0`),
    check('feedback_reports_consent_version_present', sql`length(${table.consentWordingVersion}) > 0`),
  ],
);

export type InsertFeedbackReport = InferInsertModel<typeof feedbackReports>;
export type SelectFeedbackReport = InferSelectModel<typeof feedbackReports>;

/**
 * The photograph itself, in the Postgres this service already runs.
 *
 * A SEPARATE TABLE, AND THAT IS THE POINT. `FeedbackImageStore`
 * (`feedback/feedback-image-store.ts`) is the only thing that touches it, so
 * moving these bytes to an object store later is one adapter and no caller
 * change. A `bytea` column on `feedback_reports` would have made every read of
 * a report a read of a photograph, which is the opposite of what spec 06's
 * admin list needs.
 *
 * NO S3, DELIBERATELY. An object store would mean a new vendor, a new secret,
 * a new transfer question for a German health-adjacent product, and a fake
 * bucket in a local gate that has no cloud CI. See the ADR.
 */
export const feedbackImages = pgTable('feedback_images', {
  /**
   * The report this image belongs to, and the primary key: one image per
   * report, by construction rather than by a rule somebody has to enforce.
   * `cascade` again, so an erased account leaves no orphaned bytes.
   */
  reportId: integer('report_id')
    .primaryKey()
    .references(() => feedbackReports.id, { onDelete: 'cascade' }),
  /** The image type, so the bytes can be served back with an honest header. Bounded to an allowlist by the route. */
  contentType: text('content_type').notNull(),
  /** The photograph. The one column on this service that an operator can simply look at. */
  bytes: bytea('bytes').notNull(),
  createdAt: timestamp('created_at').defaultNow().notNull(),
});

export type InsertFeedbackImage = InferInsertModel<typeof feedbackImages>;
export type SelectFeedbackImage = InferSelectModel<typeof feedbackImages>;

// =============================================================================
// Relations
// =============================================================================

export const accountsRelations = relations(accounts, ({ many }) => ({
  tokens: many(accountTokens),
  blobs: many(syncBlobs),
  keyRecords: many(syncKeyRecords),
  passwordResets: many(passwordResets),
  aiUsageDays: many(aiUsageDays),
  // Both directions of the share graph hang off the same account row; the
  // relation names say which end this account is standing at.
  sharesGranted: many(syncShares, { relationName: 'sharesGranted' }),
  sharesReceived: many(syncShares, { relationName: 'sharesReceived' }),
  // Both ends of the study graph, named the same way. An account is a study
  // purely by having contributions point at it (ADR-0003 D6).
  contributionsMade: many(researchContributions, { relationName: 'contributionsMade' }),
  contributionsReceived: many(researchContributions, { relationName: 'contributionsReceived' }),
  feedbackReports: many(feedbackReports),
}));

export const accountTokensRelations = relations(accountTokens, ({ one }) => ({
  account: one(accounts, { fields: [accountTokens.accountId], references: [accounts.id] }),
}));

export const passwordResetsRelations = relations(passwordResets, ({ one }) => ({
  account: one(accounts, { fields: [passwordResets.accountId], references: [accounts.id] }),
}));

export const aiUsageDaysRelations = relations(aiUsageDays, ({ one }) => ({
  account: one(accounts, { fields: [aiUsageDays.accountId], references: [accounts.id] }),
}));

export const syncBlobsRelations = relations(syncBlobs, ({ one }) => ({
  account: one(accounts, { fields: [syncBlobs.accountId], references: [accounts.id] }),
}));

export const syncKeyRecordsRelations = relations(syncKeyRecords, ({ one }) => ({
  account: one(accounts, { fields: [syncKeyRecords.accountId], references: [accounts.id] }),
}));

export const syncSharesRelations = relations(syncShares, ({ one }) => ({
  grantor: one(accounts, {
    fields: [syncShares.accountId],
    references: [accounts.id],
    relationName: 'sharesGranted',
  }),
  grantee: one(accounts, {
    fields: [syncShares.granteeAccountId],
    references: [accounts.id],
    relationName: 'sharesReceived',
  }),
}));

export const researchContributionsRelations = relations(researchContributions, ({ one }) => ({
  contributor: one(accounts, {
    fields: [researchContributions.contributorAccountId],
    references: [accounts.id],
    relationName: 'contributionsMade',
  }),
  study: one(accounts, {
    fields: [researchContributions.studyAccountId],
    references: [accounts.id],
    relationName: 'contributionsReceived',
  }),
}));

export const researchWithdrawalsRelations = relations(researchWithdrawals, ({ one }) => ({
  study: one(accounts, { fields: [researchWithdrawals.studyAccountId], references: [accounts.id] }),
}));

export const feedbackReportsRelations = relations(feedbackReports, ({ one }) => ({
  account: one(accounts, { fields: [feedbackReports.accountId], references: [accounts.id] }),
  image: one(feedbackImages, { fields: [feedbackReports.id], references: [feedbackImages.reportId] }),
}));

export const feedbackImagesRelations = relations(feedbackImages, ({ one }) => ({
  report: one(feedbackReports, { fields: [feedbackImages.reportId], references: [feedbackReports.id] }),
}));
