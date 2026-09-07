# ADR-0006: A reported photograph is the second hole in the claim

- **Status:** accepted
- **Date:** 2026-09-07
- **Amends:** the "one place" wording in ADR-0005, `README.md` and `src/ai/proxy.ts`

## Context

openplate names a plate from a photograph, and sometimes it is wrong. A person
looking at a measurement they know is wrong currently has nowhere to put that
knowledge: the entry is in a diary this service cannot read, the photograph is
in a separate on-device database that no outbound path can reach, and the model
that produced the number has already forgotten the request.

Building a way to report it is not a feature question. It is a question about
what this service IS.

Every published sentence about this server says the same thing three ways: it
stores an opaque ciphertext blob, wrapped key records it cannot unwrap, and
counters that hold numbers. The one stated exception is the AI proxy, and the
exception is stated carefully: the photograph crosses the process and nothing
writes, caches or logs it. `src/ai/proxy.ts` says so in its header, `README.md`
repeats it, and `.env.example` repeats it again under `UPSTREAM_API_KEY`.

A report endpoint breaks that. It does not merely see a photograph, it KEEPS
one. It is the first time this service holds a picture of a person's food in a
form an operator can open. The temptation is to describe that as a small
extension of the proxy hole, because both involve a photograph, and that
description is false in the only way that matters: one of them forgets.

There is a second temptation, which is to put the images in an object store
because that is what one does with images. For this service that means a new
vendor, a new secret in an operator's environment, a new international transfer
question for a German health-adjacent product, and a fake bucket in a local gate
that has no cloud CI at all.

## Decision

Add `POST /v1/feedback`, behind `SYNC_FEEDBACK`, off by default, and **restate
the claim rather than quietly amend it**.

### The claim, restated

There are now **two** places this service's zero-knowledge position does not
hold. They are both optional, both off until an operator turns them on, and they
are **not the same shape**. Anywhere the old "one place" wording survives, it is
wrong and is corrected in the same change:

|                                   | The AI proxy (`UPSTREAM_API_KEY`)                         | Reported estimates (`SYNC_FEEDBACK`) |
| --------------------------------- | --------------------------------------------------------- | ------------------------------------ |
| What it does with a photograph    | **Sees** it                                               | **Keeps** it                         |
| What is written                   | Nothing. Not the body, not a prefix, not a decoded buffer | The image bytes, in Postgres         |
| What is logged                    | Account id, upstream status, byte counts, duration        | Nothing about the content            |
| How long it is held               | The life of one request                                   | Until deleted                        |
| Who can read it                   | The upstream provider, in flight                          | The operator, at leisure             |
| What the operator is trusted with | Choosing a provider                                       | Holding pictures of people's food    |

The second row is the one that makes them different in kind rather than in
degree. A route that forgets can be argued about in terms of a provider's
policy. A route that keeps cannot: the operator holds the thing, and no property
of the code changes that.

### What may be stored, exhaustively

The photograph, the figures from the entry being disputed, and the consent
record. `feedback_reports` has eight columns and that is the whole allowlist:
the account, the idempotency key, the measurements, whether an image came with
it, when the person agreed, which wording they agreed to, and when the report
arrived.

**A column added to that table is a column an operator can read.** Adding one is
a privacy decision, and it belongs in this document before it belongs in
`src/db/schema.ts`.

### What consent has to be

Consent is a **separate, explicit step**, not a single tap on a report button,
and it is recorded **on the row**: the timestamp and the version identifier of
the wording that was shown. A device-local flag proves nothing to the person
reviewing that image six months later, which is precisely the person the record
exists for. The wording itself stays in the client's locale bundles under
version control, so an identifier plus a git history answers "what did they
actually read" exactly, and a typo fix later does not rewrite what an older row
claims.

Where an entry has no photograph, the wording says what is actually being sent
and does not ask for consent to send an image that does not exist.

### Postgres, behind an interface

The image goes in the Postgres this service already runs and already backs up.
No S3 client, no `@aws-sdk`, no object-storage secret. The move stays cheap
because storage sits behind `FeedbackImageStore` with `put`, `get` and `delete`
and nothing else: a later adapter is one new file and no caller change. There is
deliberately no `list`, no `stat` and no URL, because a caller that could
enumerate images would be a second way to reach them.

### Dark by default, exactly like the other three

`SYNC_FEEDBACK` unset means the whole `/v1/feedback` subtree answers the
ordinary unknown-path 404, to everybody, with or without a valid token. Not a
401: a 401 announces that a credential exists here and is merely locked, on a
service whose threat model assumes the attacker can reach it. This service
auto-deploys on push, so the commit that adds the route is the commit that puts
it in production, and an instance whose operator has not opted in must be
indistinguishable from one where the feature was never written. That is
ADR-0001's bargain for the admin API, ADR-0002's for shares and ADR-0003's for
contributions, and the stakes here are the highest of the four: the mere
existence of this tree would tell a prober that this deployment holds
photographs.

### The bounds

A maximum payload size (`FEEDBACK_MAX_REQUEST_BYTES`, 8 MB, sized for a camera
photograph after base64) and a per-account daily limit (`FEEDBACK_DAILY_LIMIT`,
five), so a compromised client cannot drain the operator's disk or bandwidth.
The image itself is capped at 5 MB decoded, which is why the body limit sits
above it: base64 inflates by 4/3, and a body limit set at the image cap would
reject a legal maximum-size report before the handler ever ran.

A repeated idempotency key stores one row and answers success. Sending is an
outbox on an offline-first app, not a request, and a client draining that queue
must be able to retry without creating a second report.

## Prohibitions

These are prohibitions on the design, not defaults to be relaxed later.

1. **No column on `feedback_reports` or `feedback_images` that is not the
   photograph, the figures or the consent record.** No IP, no user agent, no
   device identifier, no diary content, no food name beyond what the reported
   entry itself carries.
2. **No object-storage dependency in this package.** A later adapter is a new
   file implementing `FeedbackImageStore`; `@aws-sdk` in `package.json` is a
   different decision and needs its own ADR.
3. **Consent is never implied by the act of reporting**, and never recorded only
   on the device.
4. **No wording anywhere may call this route zero-knowledge, or describe it as
   the same exception the AI proxy is.** The table above is the description.
5. **`SYNC_FEEDBACK` unset means the ordinary unknown-route 404**, to everybody,
   from the first commit.
6. **No route reads an image back without an operator credential.** The read,
   list and delete side is the admin surface, and it inherits every ADR-0001
   prohibition.
7. **The client's isolation of the photo cache is not widened for this.**
   Exactly one exported function reaches that database for this purpose, the
   backup allowlist is unchanged, and no new entity reaches a backup file or the
   encrypted sync payload.

## The attacks that break this, ranked

1. **The operator.** There is no cryptographic defence, and this ADR does not
   claim one. Whoever runs the instance can open every photograph on it. That is
   the cost, it is stated in `.env.example` and `README.md` in those words, and
   an operator who is not willing to make that promise leaves the flag alone.
2. **A stale privacy policy.** The published copy said a plate photograph is
   never uploaded anywhere, in two languages and four places. Code that
   contradicts published copy is worse than either alone: the sentence has to
   become true again by being replaced with a true one, before the feature is
   reachable by anybody.
3. **Scope creep through the report row.** "While we are storing the entry, we
   may as well store the day around it" arrives the first time somebody reviews
   a report and wants context. Prohibition 1 exists so that pressure meets a
   document rather than a judgement call at six in the evening.
4. **A compromised client filling the disk.** Bounded by the size cap and the
   daily limit, and made cheap to survive by the idempotency key.
5. **Retention drift.** An image kept "until deleted" with nothing that deletes
   is an image kept forever. The retention job and the erasure hook are the
   other half of this decision and ship with the admin surface.
6. **A window that drifts from the sentence a person read.** The app states the
   number of days before somebody hands over a photograph, and it is a
   separately deployed artifact that cannot import this service's constant. It
   held a matching literal of its own, which is the same defect one level up:
   the promise and the deletion could be edited apart, and nothing would fail.
   So the window is published on `GET /health`
   (`instance.feedback.retentionDays`, PROTOCOL.md §5.6) from the same binding
   the sweep deletes on, absent entirely on an instance with the feature off,
   and a client that finds none offers no report rather than naming a period.
