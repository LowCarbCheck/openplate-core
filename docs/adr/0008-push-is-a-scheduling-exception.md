# ADR-0008: Push scheduling is the fourth hole in the claim

- **Status:** accepted
- **Date:** 2026-09-12
- **Amends:** the "three places" wording in `README.md` and in ADR-0007, and §9 of `PROTOCOL.md`

## Context

A tracker that only speaks when it is opened is a tracker people forget. The
owner asked, on 2026-09-12, for two notifications and no more: one quiet
morning catch-up, and an alert when a fast reaches the target the person set.

Neither can be built out of what this service already holds. It holds
ciphertext it cannot read, wrapped key records it cannot unwrap, an email
address, and counters about requests rather than about food. Nothing in it
knows that a meal exists, let alone that this morning is the morning to say
something about one.

So the feature needs two new things on the server, and only two: somewhere to
send to, and a clock that says when. Both are new state about a person, and new
state about a person is the kind of change this repository writes down before
it makes.

ADR-0006 named the AI proxy in flight as the **first** hole in the
zero-knowledge claim and the reported photograph as the **second**. ADR-0007
named the community pulse as the **third**. Push scheduling is the **fourth**,
and like the third it is small, opt in, and off until somebody turns it on.

## Decision

Add `/v1/push`, four routes behind the account's own bearer token, one table,
and a minute tick. Restate the claim rather than quietly amend it.

### The principle that bounds the whole feature

**The server never writes notification text.** Every push it sends carries a
kind and nothing else:

```json
{ "kind": "catch-up" }
{ "kind": "fast-target" }
```

The device writes the words, out of the diary it alone can read. That is not a
stylistic preference. A payload with a sentence in it would be diary content
crossing this process, which would make push a fifth hole of a completely
different size, and it would be a sentence written by a server that cannot see
what it is describing.

### The claim, restated

There are now **four** places this service's zero-knowledge position does not
hold. All four are optional, all four are off until somebody turns them on, and
they are not the same shape.

|                          | The AI proxy (first)       | Feedback reports (second)   | The community pulse (third)              | Push scheduling (fourth)                       |
| ------------------------ | -------------------------- | --------------------------- | ---------------------------------------- | ---------------------------------------------- |
| Who opts in              | The operator               | The operator, then a person | A person, on their own device            | The operator, then a person, on their own phone |
| What crosses the process | A photograph and an answer | A photograph and figures    | Four small integers                      | A push endpoint, a clock and a kind             |
| What is written          | Nothing                    | The image bytes             | An instance-wide day sum                 | One subscription row per device                 |
| Attributable to a person | No                         | Yes, to the account         | No, beyond "this account was here today" | Yes, to the account                             |
| How long it is held      | One request                | Until deleted               | 30 days                                  | Until the device unsubscribes or is pruned      |

The fourth column is the whole of this document.

### What a subscription row stores, exhaustively

One row per device, in `push_subscriptions`:

- **`account_id`**, so the row can be found, rate limited and erased with the
  account. There is no anonymous form of this: a push endpoint IS an
  identifier, so blinding the account id would buy nothing and would cost the
  cascade that deletes the row.
- **`endpoint`**, unique across the instance, and **`p256dh`** and **`auth`**,
  the two keys web push encrypts to. They are a sending credential and they are
  never returned by any route and never written to a log.
- **`user_agent`**, trimmed and capped at 160 characters, so an operator and
  the person themselves can tell "my phone" from "the laptop I used once" in a
  list of opaque endpoints. Longer than that and it is padding a column rather
  than naming a device.
- **`time_zone`**, an IANA name, validated with `Intl.DateTimeFormat` when it
  is written. The whole catch-up is a local clock question, so an unvalidated
  zone here is a notification at the wrong hour rather than an error.
- **`locale`**, `en` or `de`. The server never writes text, so this is carried
  for the device rather than used here, and it is stored because the device
  that registered is not always the device that renders.
- **`catch_up_minute`**, a minute of the local day, 0 to 1439, or `null` for
  "no catch-up on this device". Null is the default, and it is what the
  feature being off looks like.
- **`fast_target_enabled`**, a boolean, separately toggled from the catch-up
  because the two are separate kinds and a person may plausibly want one
  without the other.
- **`last_catch_up_day`**, a `YYYY-MM-DD` in the subscription's own zone. It is
  what makes the catch-up once per LOCAL day rather than once per 24 hours.
- **`last_seen_day`**, the same form, touched by every registration and every
  schedule change. A person who has not opened the app for seven local days is
  not pushed until they come back.
- **`wake_at`**, a nullable instant, one shot: the moment this device asked to
  be woken. The tick sends the fast target alert when it passes and clears the
  column in the same write.
- **`sends_today_day`** and **`sends_today`**, the daily cap's own two columns:
  at most two sends per subscription per UTC day, whatever the clock and the
  toggles say. A capped send is skipped, not queued.
- **`created_at`**, so a row's age is knowable.

Nothing else. No title, no body, no meal, no figure, no history of what was
sent.

### The correlation with M222's presence row, named

`wake_at` is the instant a device wants to be woken, and for a fasting person
that is the end of their fast. M222's `pulse_presence` row describes the same
fast from the other end: it says this account is fasting right now.

An operator with database access can therefore line up a `pulse_presence` row
and a `wake_at` value for the same account and learn when that person is
fasting and until when. ADR-0007 named this from the pulse's side before this
feature existed; it is named here from push's side so neither document is the
only one that knows.

Nothing in either feature prevents it. Both need the account id for reasons
that are not negotiable (the pulse for deduplication, push because an endpoint
belongs to somebody), and a scheme that blinded one of them would be un-blinded
by the timing anyway. It is **named and accepted for opt in accounts**: a
person who has turned neither on has neither row.

### Why the schedule lives here rather than on the device

A device that is asleep cannot wake itself at 08:00. That is the entire reason
this table exists: the push service is the only thing that can reach a closed
phone, and it only sends what a server gave it. So the clock has to be on the
server, and the cost of that is the row above.

What does NOT move here is the content. The tick sends a kind; the device wakes,
reads its own diary, and writes the sentence.

### Two rules that keep it quiet

- **Seven days.** A subscription whose `last_seen_day` is more than seven local
  days old receives no catch-up. Somebody who stopped using the app is not
  chased by it.
- **Two a day.** No subscription receives more than two sends in a UTC day,
  counted in the row itself, so a bug in the clock arithmetic costs somebody two
  notifications rather than a hundred.

### VAPID, and what absence means

`VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY` and `VAPID_SUBJECT` are all-or-nothing.
All three set means push exists here; none set means it does not, and the whole
`/v1/push` subtree answers the ordinary unknown-path 404 to everybody,
credentialed or not, exactly as the plans subtree does. A partial set is a boot
failure that names the missing variable, because a half-configured block is an
operator who believes notifications work.

`GET /health` advertises `push: true|false`, following the `plans` precedent: a
boolean that says only whether a door exists, never a promise.

## Consequences

- `README.md`'s "three places" paragraph becomes four, and `PROTOCOL.md` §9.2
  gains the subscription row on the side of what the server does know.
- The service gains one table and one more timer, and the timer is a minute
  tick rather than the hourly sweeps around it, because a catch-up at 08:00
  that arrives at 08:59 is a different notification.
- `GET /v1/admin/stats` reports `push: { subscriptions, sentToday }`, so an
  operator can see that the feature is alive without reading any row.
- An instance with no VAPID keys holds an empty table, sends nothing, and is
  indistinguishable from a build where the feature was never written.

## Alternatives considered

- **Text in the payload.** Refused above: it is diary content crossing the
  process, written by a party that cannot read the diary.
- **A UTC schedule instead of a local one.** Simpler by a lot, and wrong twice a
  year for every person in a zone with a changeover, plus permanently wrong for
  everybody who is not in UTC. The local day is the whole point of a morning
  notification.
- **No cap.** Refused: the cap is the thing that bounds the damage a clock bug
  can do, and a clock bug is the most likely defect in this feature.
- **Storing the fast itself rather than a wake instant.** That would be a second
  copy of diary content. `wake_at` is one instant with no meaning attached, and
  the device decides what to say when it arrives.
