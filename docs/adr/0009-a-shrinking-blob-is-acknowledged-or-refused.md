# ADR-0009: A shrinking blob is acknowledged, or it is refused

- **Status:** accepted
- **Date:** 2026-09-12
- **Amends:** §5.1 and §8 of `PROTOCOL.md`, and the "dumb store" sentence in `README.md`

> **On the number.** `openplate-core/docs/adr/` stops at 0008, so 0009 is the
> next one here. The `openplate` app cites an "ADR-0009" in three places
> (`app/lib/sync/compartment-kind.ts`, `app/lib/sync/private-store.ts`,
> `app/lib/sync/sync-actions.ts`); that is the app's OWN register,
> `openplate/.adr/0009-a-compartment-carries-its-kind.md`, a different document
> in a different repository. The two registers have always been separate and
> have always overlapped in numbering. Nothing in this document touches that
> one.

## Context

On 2026-09-12 a person lost her entire diary.

The client is local first and end to end encrypted. It keeps the diary in
IndexedDB and its record of what it last synced in localStorage. The browser
evicted the IndexedDB store and left the localStorage record standing. The app
compared the two, concluded that the person had deleted every entry, and pushed
a tombstone for each one. Her blob went from 5310 bytes to 1588 in a single
accepted write. The production trace puts 373 milliseconds between a forced
re-login and the wipe push.

It also spreads. A second device holding the real diary pulls that blob on its
next cycle, merges it, and deletes its own rows. One evicted store on one
device takes every device.

The client defect is being fixed. That fix protects nobody who has not updated,
and an installed progressive web app cannot be made to update: it can be asked,
and it will comply whenever it next happens to boot with a network. Between now
and then, every device running the old build is one eviction away from the same
push, and this service will accept it.

## Decision

Refuse a push whose ciphertext is under half of the stored version's
`size_bytes`, unless the request says it means it.

The acknowledgement is a **body field**, `shrinkAcknowledged`, on
`POST /v1/sync/blob`. Absent means `false`, which is what every deployed client
says. A new client sets it `true` exactly when it emits tombstones from state
it positively trusts.

Three supporting pieces come with it, and none of them is optional:

1. **The refusal** is a `400` carrying a sentence a person can read. Not a
   `409`: that status already means "another device wrote first" on this route,
   and the deployed client acts on it by pulling, merging and pushing the same
   bytes again, which is the loop this exists to stop. A `400` arrives in the
   deployed client as `SyncErrorKind.invalid`, which its status surface renders
   as "this app and the sync server don't speak the same version yet, so
   syncing is paused on purpose", with the service's own sentence underneath.
   That is true, and the remedy it implies, update the app, is the right one.
2. **The compare-and-swap is checked first.** A push off a stale `baseVersion`
   is the ordinary `409` whatever its size. It writes nothing either way, and
   the honest answer to that client is "pull and merge", which usually leaves
   it not shrinking at all. Refusing it as a shrink would send every ordinary
   two-device race off to update an app that is not the problem.
3. **A pre-shrink pin.** When an acknowledged shrink is accepted, the version
   immediately before it is exempt from pruning for 14 days. The refusal is the
   protection; this is the recovery. The only reason the woman above is
   recoverable at all is that her pre-wipe blob happened to still be inside the
   retention window.
4. **Tiered retention**, replacing the flat count of five: the last 5 versions,
   plus one version per UTC calendar day for 14 days, plus the live pins.
5. **A rollback**, on the admin surface, because a service that can refuse a
   wipe and cannot undo one has done half the job.

### Why this is not a hole in the zero-knowledge claim

`size_bytes` is already stored, and already read, for the storage figure in
`GET /v1/admin/accounts` and for the capacity warning of
`server/blob-size-telemetry.ts`. The guard compares two integers this service
has held since M128. It parses no ciphertext, holds no key, and learns nothing
it did not already know. ADR-0006 and ADR-0007 name the three places the claim
does not hold; this is not a fourth.

### What it IS an exception to

A different promise, made in `README.md` and implied throughout `PROTOCOL.md`:
that this service is a dumb compare-and-swap store which accepts any correctly
versioned blob and has no opinion about its contents.

It now has exactly one opinion. It is stated in one number, and it is about a
length rather than a meaning, but it is an opinion, and a third party
implementing this protocol has to implement it or their clients will behave
differently against the two services. §5.1 of `PROTOCOL.md` says so.

### What it costs when it is wrong

A false positive is a person who genuinely deleted most of their diary on a
client older than the field. Their push is refused. They see an amber sync
message telling them to update, their local diary is untouched, and the
deletion lands as soon as they do update.

A false negative is a client that sets the flag and is wrong anyway. The wipe is
accepted, and the pin plus the daily tier is what an operator has to work with:
a fortnight, rather than five versions two devices can burn through in a minute.

**The false positives cost a field, and the false negatives cost data.** That
asymmetry is the whole decision. A legitimate large deletion waits for an
update; a wipe nobody meant does not happen.

### The storage this commits to

Every tier is capped, so the worst case is arithmetic rather than a promise:

| Tier              | Cap                                   |
| ----------------- | ------------------------------------- |
| Recent            | 5 versions                            |
| Daily             | 14 versions, one per UTC calendar day |
| Pre-shrink pins   | 14 versions, expiring after 14 days   |

At most **33 versions per account**, and a blob is capped at 2 MiB, so at most
**66 MiB per account**, against 10 MiB before. In practice it is far less: the
tiers overlap, blobs are gzipped before they are sealed, and a real account's
whole history today is a few hundred kilobytes.

The daily tier is per **calendar day** rather than per count, and that is what
makes it safe. Two devices fighting each other produce versions as fast as the
network allows; a count-based tier is exhausted by that in minutes, and a day
is a bucket no client can widen. The pin tier is capped for the same reason in
the other direction: a pin is taken on a client's own say-so, and an uncapped
promise made on somebody else's say-so is not a bound.

### The rollback is a rollback, not a re-upload

`PROTOCOL.md` §3.2 binds `{accountId, blobVersion, payloadSchemaVersion}` into
the envelope's AAD. Re-inserting an old ciphertext as a NEW version therefore
produces bytes whose AAD names a version they were not sealed under, and **no
client can ever decrypt them**. The restore would report success and would have
destroyed the last readable copy.

So `POST /v1/admin/accounts/:id/blob/rollback` deletes the versions above the
target, leaving it the maximum it already claims to be. It refuses every state
it can see is broken: no blob, an unknown version, a target that is already
current, an envelope version this build does not accept, and a zero-byte row.

### The rollback is not sufficient, and the playbook says so

The person's devices still hold the baseline that produced the bad push. Roll
the server back and leave a device alone, and the next cycle deletes the same
rows again. `docs/operations/restoring-a-wiped-diary.md` is the procedure, and
its non-negotiable step is erasing the local data on every device that person
signed into.

## Consequences

- `POST /v1/sync/blob` gains one optional request field and one refusal. Every
  existing client keeps working, and none of them can wipe an account.
- `sync_blobs` gains `pinned_until`, nullable, written only on the version an
  acknowledged shrink replaced.
- `BLOB_VERSION_RETENTION` keeps its name and its value and becomes one tier of
  three. `lib/blob-retention.ts` owns the combination, pure and clock-injected.
- The admin surface gains `GET /accounts/:id/blob/versions` and
  `POST /accounts/:id/blob/rollback`, guarded like `accounts delete` and behind
  `--yes` in `pnpm sync-api`. The version list reports byte counts and never
  bytes, under ADR-0001's projection.
- The client repository has to mirror the protocol constants and set
  `shrinkAcknowledged` deliberately. Until it does, an openplate client that
  legitimately deletes most of a diary is refused, which is the trade above.

## Alternatives considered

- **A header instead of a body field.** Refused. A new custom request header
  must be added to `server/cors.ts`'s allow list, or a browser reads the
  preflight, sees a header it may not send, and never sends the request at all:
  no request arrives, no log line is written, and no Node test can see it. This
  service shipped exactly that defect in M222 with `Idempotency-Key`, and
  `Access-Control-Max-Age` cached the refusal for a day.
- **Refuse every large shrink, with no acknowledgement.** That is a permanent
  block on a legitimate operation. A person who wants their diary gone is
  entitled to delete it.
- **Accept the wipe and rely on retention alone.** That is today, and today is
  how the incident happened. Retention made her recoverable by luck.
- **Have the server decide, rather than ask.** It cannot. It holds ciphertext,
  and "a diary that got much smaller" is the same bytes whether it was meant or
  not. Asking is the only honest move available.
- **A soft delete, or a tombstone column on `sync_blobs`.** Deletion here is a
  cascade with no window, on purpose (ADR-0001), and a second erasure semantics
  is exactly the drift that document exists to prevent.
