/**
 * The E2EE sync WIRE CONTRACT, the entire shared surface between an openplate
 * client and a sync service (M128 spec 01).
 *
 * THIS FILE IS MAINTAINED IN TWO REPOS AND MUST STAY IDENTICAL IN SUBSTANCE:
 *  - `openplate/app/lib/sync/engine/protocol.ts`   (the client half)
 *  - `openplate-core/src/protocol.ts`              (this file, the service half)
 *
 * They are deliberately NOT a shared package: the two repos ship and version
 * independently, and a third party must be able to implement either side from
 * `openplate-core/PROTOCOL.md` alone without depending on our code. The price
 * of that independence is hand-maintained duplication, so each repo carries a
 * unit test that asserts its local `PROTOCOL_VERSION` (and the size/retention
 * limits) against TRANSCRIBED literals, there is no shared CI, so drift has
 * to fail a test rather than rely on a promise in a doc comment
 * (`tests/unit/protocol.test.ts` here,
 * `tests/unit/sync-engine/protocol.test.ts` there).
 *
 * The service stores OPAQUE BYTES. It never sees a key, never parses an
 * envelope, and never learns anything about the plaintext beyond its length.
 * Everything below is therefore either transport framing or non-secret
 * metadata the service legitimately needs (versions, sizes, CAS tokens).
 */
import { asNumber, asObject, asString, type JsonObject, type JsonValue } from './lib/json.js';

/**
 * The wire-protocol version a client and service must agree on before any
 * sync traffic flows (see {@link checkProtocolCompatibility}).
 *
 * Bump this for ANY breaking change to the endpoints, request/response
 * shapes, auth scheme, or CAS semantics documented in `PROTOCOL.md`.
 * Purely additive changes (a new optional response field, a new endpoint that
 * older clients simply never call) do not require a bump.
 */
export const PROTOCOL_VERSION = 2;

/**
 * The encrypted-blob wire format version, INDEPENDENT of
 * {@link PROTOCOL_VERSION}. This one describes what is inside
 * `ciphertext`: `gzip(JSON(payload))` sealed with AES-256-GCM, the 12-byte IV
 * packed as the leading bytes (`openplate`'s `app/lib/sync/engine/envelope/build-envelope.ts`).
 *
 * Bump ONLY for a genuine crypto/framing change (a different cipher, a
 * different compression codec, a different IV packing). Never bump it for a
 * payload SCHEMA change, that is the local store's own
 * `payloadSchemaVersion`, which travels through this protocol as an opaque
 * number bound into the AAD.
 */
export const ENVELOPE_VERSION = 1;

/**
 * Hard cap on one account's encrypted blob, enforced by the service and
 * mirrored by the client so it can fail early with a useful message instead
 * of eating a 413.
 *
 * CAPACITY PLAN (counsel, 2026-08-03): food-log JSON runs ~400-700 bytes per
 * entry BEFORE compression, so an un-gzipped whole-store blob would reach
 * this cap within 2-4 years of daily use. `ENVELOPE_VERSION` 1 gzips the
 * plaintext before encrypting, which buys roughly an order of magnitude of
 * headroom on highly-repetitive JSON. The long-term fix (chunked/per-entity
 * blobs) is a FUTURE PROTOCOL VERSION BUMP, deliberately deferred and
 * recorded in `PROTOCOL.md` so it is planned rather than discovered under
 * pressure.
 */
export const MAX_BLOB_BYTES = 2 * 1024 * 1024;

/** How many historical blob versions the service retains per account; older ones are pruned on every successful write. */
export const BLOB_VERSION_RETENTION = 5;

/**
 * Path prefix the blob/key-record endpoints are mounted under.
 *
 * CHANGED IN M128 SPEC 02, from `/api/sync` to `/v1/sync`: the standalone
 * service owns its whole URL space now and versions it as a whole, so the
 * blob routes sit beside `/v1/auth/*` under one namespace rather than in a
 * leftover mount path from the era when they were grafted onto the openplate
 * app's Express server.
 *
 * `PROTOCOL.md` §7 records this as a pre-1.0 change that does NOT bump
 * `PROTOCOL_VERSION`, zero production blobs exist, there are no third-party
 * implementations, and no deployed client can be broken by it.
 *
 * CROSS-REPO NOTE: `openplate/app/lib/sync/engine/protocol.ts` is the
 * hand-maintained duplicate of this file and still carries the old value.
 * Its drift-guard test asserts against a transcribed literal, so it will keep
 * passing while disagreeing, nothing in either repo can catch this
 * automatically. The client half of the move belongs to the spec that wires
 * the client to a real service.
 */
export const SYNC_API_PREFIX = '/v1/sync';

/**
 * Path prefix the plans pass-through is mounted under (M213 spec 02).
 *
 * OUTSIDE {@link SYNC_API_PREFIX} ON PURPOSE, and that is the fact a reader
 * needs before touching `server/create-app.ts`: no bearer middleware stands
 * over this subtree by inheritance, so the mount itself has to put one there.
 *
 * The routes behind it belong to the biller, not to this protocol. This
 * service forwards `GET` and `POST` under the prefix to one configured
 * upstream and reads none of the bodies; an instance with no
 * `PLANS_UPSTREAM_URL` answers the ordinary unknown-path 404 on the whole
 * subtree. See PROTOCOL.md §5.22.
 */
export const PLANS_API_PREFIX = '/v1/plans';

// ---------------------------------------------------------------------------
// Key records
// ---------------------------------------------------------------------------

/**
 * The two ways an account's DEK is wrapped: under the passphrase-derived KEK
 * (Argon2id → HKDF) and under the recovery-code-derived KEK (HKDF only).
 * Exactly one record of each kind may exist per account.
 */
export type SyncKeyRecordKind = 'passphrase' | 'recovery';

/** Every valid {@link SyncKeyRecordKind}, for validation and exhaustive iteration. */
export const SYNC_KEY_RECORD_KINDS: readonly SyncKeyRecordKind[] = ['passphrase', 'recovery'];

export function isSyncKeyRecordKind(value: JsonValue | undefined): value is SyncKeyRecordKind {
  return value === 'passphrase' || value === 'recovery';
}

// ---------------------------------------------------------------------------
// Accounts
// ---------------------------------------------------------------------------

/**
 * What an account may do on this instance.
 *
 *  - `'member'`, the default, and what every invite that says nothing grants.
 *  - `'admin'`, may also call `/v1/admin`, authenticated by its OWN access
 *    token. That is the whole difference; an admin holds no key an ordinary
 *    account does not, and cannot read anybody's diary.
 *
 * There is no third role and no permission matrix, deliberately. One server,
 * one organization (M192 non-goal: multi-tenancy).
 */
export type AccountRole = 'admin' | 'member';

/** Every valid {@link AccountRole}, for validation and exhaustive iteration. */
export const ACCOUNT_ROLES: readonly AccountRole[] = ['admin', 'member'];

export function isAccountRole(value: JsonValue | undefined): value is AccountRole {
  return value === 'admin' || value === 'member';
}

/**
 * WHAT USED TO BE HERE, AND WHY IT IS NOT (M192).
 *
 * `SignupMode` (`open` | `invite` | `closed`) stood here, was published on the
 * handshake, and was read from `SIGNUP_MODE`. Signup is now invite-only,
 * always: an account is created by redeeming an addressed invite an operator
 * minted, and there is no other door. A mode that has one value is not a mode,
 * so the type, the env var and the handshake field are gone together. Setting
 * `SIGNUP_MODE` is a boot failure (`config.ts`), never a silent no-op.
 */

/**
 * One account, as every endpoint that returns one reports it. The same shape
 * comes back from `POST /signup`, `POST /login`, `GET /account`,
 * `PATCH /account`, `POST /recover`, `POST /recover-rotate` and the admin
 * account endpoints, so a client has exactly one account decoder.
 *
 * NOTHING SECRET IS IN IT, and nothing can be: no verifier, no KDF
 * descriptor, no wrapped DEK, no escrow, no token. Every field below is
 * either the person's own information or the standing an operator granted
 * them.
 */
export interface AccountView {
  id: number;
  /** The canonical address, NFKC, trimmed, lowercased (see `PROTOCOL.md` §5.8). */
  email: string;
  displayName: string | null;
  role: AccountRole;
  /** AI requests allowed per UTC day. `0` means this account has no AI. */
  dailyAiLimit: number;
  /** AI requests already spent on the current UTC day. */
  aiUsedToday: number;
  /**
   * When this account's AI allowance ends, or `null` for no end at all.
   *
   * A CLIENT MAY RENDER IT AND MUST NOT AUTHORIZE ON IT. Past this instant the
   * proxy answers `403 allowance-expired` (PROTOCOL.md §5.19), which is the
   * only place the rule lives; sync keeps working, because the diary belongs
   * to the account.
   */
  allowanceExpiresAt: IsoTimestamp | null;
  /** Non-`null` while the account is suspended; every authenticated call then answers `403 account-suspended`. */
  suspendedAt: IsoTimestamp | null;
  /**
   * How many invitations this account may still cause through
   * `POST /v1/auth/invites`, or `null` when that cap is not about it.
   *
   * `null` RATHER THAN `0`, AND THIS IS THE FIELD'S WHOLE SUBTLETY. `0` reads
   * to a client as "you have used them all". An administrator has used none:
   * they mint through the admin API, which is exempt from the cap and from the
   * re-invite rule, so `0` would be the exact opposite of the truth. `null`
   * means "this cap does not apply to you", and a client draws no invite card
   * for it. An instance where the feature is off sends `null` for the same
   * reason: there is no cap there, because there is no route, and a `0` would
   * announce a spent allowance that never existed.
   *
   * A CLIENT MAY RENDER IT AND MUST NOT AUTHORIZE ON IT. The count is a
   * property of the `signup_invites` rows the account caused, read at the
   * moment this view was built; the server refuses the sixth mint whatever a
   * client believes.
   */
  invitesLeft: number | null;
  createdAt: IsoTimestamp;
}

/**
 * What an instance says about itself on the handshake, beside the version
 * numbers. Descriptive only: a client renders it, and never authorizes on it.
 *
 * IT DOES NOT CARRY THE INSTANCE'S AI CEILING, and this is where a reader
 * looking for `AI_INSTANCE_DAILY_LIMIT` will look. That number is the
 * operator's BUDGET and `/health` is unauthenticated, so publishing it would
 * tell a stranger what the operator is willing to spend in a day. A client
 * could not act on it either: it never learns how much of the ceiling is
 * spent, so it can neither warn nor plan, and the one fact it needs, "this
 * instance is out of capacity right now", arrives as the proxy's
 * `503 ai-instance-ceiling` (PROTOCOL.md §5.19). The operator reads the
 * ceiling from `GET /v1/admin/stats`, behind the admin credential.
 */
export interface InstanceInfo {
  /** The operator's name for this instance (`INSTANCE_NAME`, default `openplate`). */
  name: string;
  /** The language its mail is written in (`INSTANCE_LANGUAGE`, `en` or `de`). */
  language: InstanceLanguage;
  /** Whether this instance can send mail at all. `false` means invites and resets are printed as links instead. */
  mail: boolean;
  /**
   * Whether an ordinary member may invite people on this instance
   * (`MEMBER_INVITE_DAILY_AI_LIMIT` and `MEMBER_INVITE_ALLOWANCE_DAYS`, both
   * or neither).
   *
   * DESCRIPTIVE, NEVER A GRANT, like every other field here. A client reads it
   * to decide whether to draw an invite card at all, and never to decide
   * whether it may mint: `false` means `POST /v1/auth/invites` answers the
   * ordinary unknown-path 404, and `true` still leaves the cap, the re-invite
   * rule and the throttle to the server.
   */
  memberInvites: boolean;
  /**
   * Whether this instance has a biller behind it, so `/v1/plans/*` exists
   * here (`PLANS_UPSTREAM_URL` and `PLANS_UPSTREAM_SECRET`, both or neither).
   *
   * A BOOLEAN AND NOT AN OPTIONAL PROMISE, which is the choice `feedback`
   * below makes and the opposite one. `feedback` is a promise about what
   * happens to a photograph, and an instance with nothing to promise says
   * nothing. This field promises nothing at all: it says only whether a door
   * exists, which is the same kind of statement `mail` and `memberInvites`
   * make, so `false` is the honest answer for every instance that has no
   * biller and for every build older than the field.
   *
   * DESCRIPTIVE, NEVER A GRANT. `false` means the whole subtree answers the
   * ordinary unknown-path 404, so a client draws no plan door; `true` still
   * leaves the bearer gate, the account's own state and the biller's own
   * refusals where they are.
   */
  plans: boolean;
  /**
   * Whether this instance can send web push notifications, so `/v1/push/*`
   * exists here (`VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY` and `VAPID_SUBJECT`,
   * all three or none).
   *
   * THE `plans` PRECEDENT, AND FOR THE SAME REASON. It is a boolean rather
   * than an optional promise: it says only whether a door exists, never what
   * comes through it, so `false` is the honest answer both for an instance
   * with no keys and for a build older than the field.
   *
   * DESCRIPTIVE, NEVER A GRANT. `false` means the whole subtree answers the
   * ordinary unknown-path 404, so a client draws no notification settings;
   * `true` still leaves the bearer gate, the seven day pause and the daily cap
   * on the server. What it never says is what a push contains: the payload
   * carries a kind and the device writes the words. See ADR-0008.
   */
  push: boolean;
  /** The AI proxy this instance offers, or `null` when it has no upstream key. Wired by spec 03. */
  ai: InstanceAi | null;
  /**
   * What this instance does with a reported photograph, or ABSENT when it
   * accepts no reports, see {@link InstanceFeedback}.
   *
   * OPTIONAL, AND NOT NULLABLE, which is the opposite of the choice `ai`
   * makes above, on purpose. `ai: null` is a statement ("no AI here") that
   * every instance makes. This field is a PROMISE, and an instance with
   * `SYNC_FEEDBACK` unset has none to make: it omits the key entirely, so it
   * stays indistinguishable from an instance built before the field existed,
   * exactly as its `/v1/feedback` subtree stays indistinguishable from one
   * where the feature was never written.
   */
  feedback?: InstanceFeedback;
}

/**
 * What an instance promises about a reported photograph. One number, because
 * `/health` is the container's own healthcheck path and is polled forever.
 *
 * THE CLIENT SHOWS THIS NUMBER TO A PERSON, in the consent step they read
 * before they hand over a photograph of their food. It is therefore the number
 * the service's own retention sweep deletes on
 * (`feedback/feedback-retention.ts`), read across rather than written out
 * again: two copies is one wrong sentence shown to somebody at the moment they
 * are deciding.
 */
export interface InstanceFeedback {
  /** How many days a report and its image are kept before the sweep deletes them. */
  retentionDays: number;
}

/** The two languages the invite and reset mails exist in. */
export type InstanceLanguage = 'en' | 'de';

/** Every valid {@link InstanceLanguage}, for validation and exhaustive iteration. */
export const INSTANCE_LANGUAGES: readonly InstanceLanguage[] = ['en', 'de'];

export function isInstanceLanguage(value: JsonValue | undefined): value is InstanceLanguage {
  return value === 'en' || value === 'de';
}

/**
 * What the instance's AI proxy advertises. Diagnostics and UI copy only, never
 * a routing decision: `instance.ai` being non-`null` says an upstream is
 * configured, not that the caller may use it.
 */
export interface InstanceAi {
  /** `AI_ADVERTISED_MODEL`, or `null` when the operator named none. Never the upstream URL and never a key. */
  model: string | null;
}

// ---------------------------------------------------------------------------
// Version handshake
// ---------------------------------------------------------------------------

/**
 * What a service reports about itself, read by the client BEFORE its first
 * sync of a session. This replaces the same-process `HOOK_VERSION` check that
 * died with M117's build-time composition seam: client and service are now
 * separately deployed artifacts that can drift by a release, and the only
 * safe way to notice is to ask.
 */
export interface ProtocolHandshake {
  /** The service's {@link PROTOCOL_VERSION}. */
  protocolVersion: number;
  /** The highest {@link ENVELOPE_VERSION} the service is willing to accept on a push. */
  envelopeVersion: number;
  /** Human-readable build identifier, diagnostics only, never compared. */
  serviceVersion: string;
  /**
   * What this instance calls itself, what language it writes in, whether it
   * can send mail, and what AI it offers, see {@link InstanceInfo}.
   *
   * OPTIONAL, and it must stay optional. A service older than this field omits
   * it entirely, and a client that required it would refuse to talk to every
   * such instance: a compatibility break wearing the clothes of an additive
   * change. It replaced `signupMode`, which described a setting that no longer
   * exists (signup is invite-only, always).
   *
   * It is DESCRIPTIVE, never authoritative. `mail: true` does not promise a
   * letter arrives, and `ai` is what the operator configured rather than a
   * capability grant, an account with `dailyAiLimit: 0` gets `403` whatever
   * this says.
   */
  instance?: InstanceInfo;
  /**
   * A short message the operator wants every client to show, a planned
   * migration, a shutdown date, a "read this before you sync again".
   *
   * WHY IT LIVES ON THE HANDSHAKE. This service holds no addresses (M181), so
   * it has no channel to write to anybody. The notice is PULL, never push: the
   * client already reads `/health` on every connect, so a person who opens the
   * app sees the message and a person who does not, does not. That limitation
   * is real and is written down rather than papered over, it is not a
   * notification system and must never be relied on as one.
   *
   * OPTIONAL, for the same reason {@link ProtocolHandshake.instance} is: an
   * instance with nothing to say omits it, and an older client that has never
   * heard of it ignores it.
   * Its text is bounded by the service's config (`MAX_SYNC_NOTICE_LENGTH`)
   * because `/health` is the container's own HEALTHCHECK path and is polled
   * continuously.
   *
   * IT IS HOSTILE INPUT ON THE CLIENT SIDE. It arrives from whatever server
   * the user pointed at, which is not necessarily the operator they think it
   * is: render it as TEXT, never as markup, and never build a link from
   * {@link OperatorNotice.url} without checking its scheme first.
   */
  notice?: OperatorNotice;
}

/** The optional operator message of {@link ProtocolHandshake.notice}. `url` is absent when the notice links nowhere. */
export interface OperatorNotice {
  text: string;
  url?: string;
}

/** Result of {@link checkProtocolCompatibility}, `reason` is a user-presentable sentence. */
export type ProtocolCompatibility = { status: 'compatible' } | { status: 'incompatible'; reason: string };

export function isProtocolHandshake(value: JsonValue | undefined): boolean {
  const candidate = asObject(value);
  if (candidate === null) return false;
  // `instance` is deliberately absent from this check. It is optional on the
  // wire, so demanding it here would reject every service older than the field.
  return (
    asNumber(candidate.protocolVersion) !== null &&
    asNumber(candidate.envelopeVersion) !== null &&
    asString(candidate.serviceVersion) !== null
  );
}

/**
 * Decides whether this build may talk to the service that returned `remote`.
 *
 * Pure and total, it never throws and never guesses. A mismatch is REFUSAL
 * with a clear message, never a best-effort attempt: pushing an envelope a
 * service can't store, or decrypting one framed by rules this build doesn't
 * know, corrupts an account's only copy of its data. Silent wrongness is the
 * one outcome this whole handshake exists to prevent.
 */
export function checkProtocolCompatibility(remote: ProtocolHandshake): ProtocolCompatibility {
  if (remote.protocolVersion !== PROTOCOL_VERSION) {
    return {
      status: 'incompatible',
      reason: `This sync server speaks protocol version ${remote.protocolVersion}; this app speaks version ${PROTOCOL_VERSION}. Update whichever side is older before syncing.`,
    };
  }
  if (remote.envelopeVersion !== ENVELOPE_VERSION) {
    return {
      status: 'incompatible',
      reason: `This sync server expects envelope version ${remote.envelopeVersion}; this app produces version ${ENVELOPE_VERSION}. Update whichever side is older before syncing.`,
    };
  }
  return { status: 'compatible' };
}

// ---------------------------------------------------------------------------
// Wire shapes, blobs
// ---------------------------------------------------------------------------

/**
 * A base64-encoded byte string. Binary fields (`ciphertext`, `wrappedDek`)
 * travel as base64 inside JSON bodies rather than as a binary content type,
 * so that every field of every request is inspectable by a self-hoster
 * debugging their own instance.
 */
export type Base64Bytes = string;

/** An ISO-8601 UTC timestamp string, e.g. `2026-08-04T10:11:12.000Z`. */
export type IsoTimestamp = string;

/** `POST {prefix}/blob`, a compare-and-swap write of the account's single encrypted blob. */
export interface PushBlobRequest {
  /**
   * The `blobVersion` this client believes is currently stored (`0` for "no
   * blob exists yet"). The write succeeds only if it still matches, this is
   * the entire concurrency model, and it is never a blind overwrite.
   */
  baseVersion: number;
  envelopeVersion: number;
  ciphertext: Base64Bytes;
}

/** `200`, the CAS write won. */
export interface PushBlobAcceptedResponse {
  newVersion: number;
}

/**
 * `409`, the CAS write lost: another device wrote first. The client must
 * pull `currentVersion`, merge (`openplate`'s `app/lib/sync/engine/merge/merge-entities.ts`), and retry
 * with `baseVersion: currentVersion`.
 */
export interface PushBlobConflictResponse {
  currentVersion: number;
}

/** `200` from `GET {prefix}/blob`. A `404` means this account has never pushed. */
export interface PullBlobResponse {
  blobVersion: number;
  envelopeVersion: number;
  ciphertext: Base64Bytes;
  createdAt: IsoTimestamp;
}

// ---------------------------------------------------------------------------
// Wire shapes, key records
// ---------------------------------------------------------------------------

/** One wrapped-DEK record as it appears on the wire. */
export interface KeyRecordWire {
  kind: SyncKeyRecordKind;
  /**
   * Argon2id salt + m/t/p parameters for the `passphrase` kind so any device
   * can re-derive the KEK; ALWAYS `null` for `recovery` (HKDF-only, a
   * ≥128-bit random code needs no memory-hard stretch and therefore has no
   * parameters to record). Non-secret by design.
   */
  kdfDescriptor: JsonObject | null;
  wrappedDek: Base64Bytes;
  updatedAt: IsoTimestamp;
}

/** `200` from `GET {prefix}/key-records`. */
export interface ListKeyRecordsResponse {
  records: KeyRecordWire[];
}

/** `PUT {prefix}/key-records/:kind`, also CAS-gated, mirroring the blob endpoint. */
export interface PutKeyRecordRequest {
  kdfDescriptor: JsonObject | null;
  wrappedDek: Base64Bytes;
  /**
   * `null` asserts "no record of this kind exists yet" (first-time setup);
   * any other value asserts "the record I last read had exactly this
   * `updatedAt`" (rotation).
   *
   * The key MUST be present. An ABSENT key is a `400`, deliberately, a
   * caller must not be able to skip the concurrency check by forgetting a
   * field.
   */
  expectedUpdatedAt: IsoTimestamp | null;
}

/** `409` from a key-record PUT whose `expectedUpdatedAt` no longer matches. */
export interface PutKeyRecordConflictResponse {
  currentUpdatedAt: IsoTimestamp | null;
}

/** Every non-2xx response body shape. `error` is diagnostic text, never a machine-readable code. */
export interface ProtocolErrorResponse {
  error: string;
}

/**
 * The status codes that carry protocol meaning. Anything else is a transport
 * or infrastructure failure and should be retried or surfaced as such.
 */
export const PROTOCOL_STATUS = {
  ok: 200,
  noContent: 204,
  badRequest: 400,
  unauthorized: 401,
  forbidden: 403,
  notFound: 404,
  conflict: 409,
  payloadTooLarge: 413,
} as const;
