# ADR-0007: The community pulse is the third hole in the claim

- **Status:** accepted
- **Date:** 2026-09-12
- **Amends:** the "two places" wording in `README.md` and in ADR-0006, and §9 of `PROTOCOL.md`

## Context

Using a tracker alone is quiet work. The owner asked, on 2026-09-12, for a
small honest sign that other people are doing the same thing today: how many
are fasting right now, how many photographs were parsed, how many meals,
calories and grams of protein were tracked on this instance.

Every one of those numbers is a sum over a diary this service cannot read.
Today it holds ciphertext, wrapped key records it cannot unwrap, an email
address, and counters about requests rather than about food. Nothing in it
knows that a meal exists.

So the feature cannot be built by looking harder at what is already stored. It
can only be built by asking devices to send something new, and something new
leaving a device is exactly the kind of change this repository writes down
before it makes.

ADR-0006 named the reported photograph, the `SYNC_FEEDBACK` route, as the
**second** hole in the zero-knowledge claim, with the AI proxy in flight as the
first. The pulse is the **third**, and it is smaller than either.

## Decision

Add `/v1/pulse`, opt in on the device, default off, and restate the claim
rather than quietly amend it.

### The claim, restated

There are now **three** places this service's zero-knowledge position does not
hold. All three are optional, all three are off until somebody turns them on,
and they are not the same shape.

|                          | The AI proxy (first)       | Feedback reports (second)   | The community pulse (third)              |
| ------------------------ | -------------------------- | --------------------------- | ---------------------------------------- |
| Who opts in              | The operator               | The operator, then a person | A person, on their own device            |
| What crosses the process | A photograph and an answer | A photograph and figures    | Four small integers                      |
| What is written          | Nothing                    | The image bytes             | An instance-wide day sum                 |
| Attributable to a person | No                         | Yes, to the account         | No, beyond "this account was here today" |
| How long it is held      | One request                | Until deleted               | 30 days                                  |

The third column is the whole of this document. What follows states it exactly,
because a vague description of what leaves a device is worse than none.

### What is sent, exhaustively

Three writes, each one a delta and never a state:

- A **meal delta** is the count 1, the meal's calories **rounded to the nearest
  50**, and its protein **rounded to the nearest 5 g**. Nothing else. No name,
  no time of day beyond the UTC day the server stamps, no entry id, no food.
- A **photo delta** is the count 1. Nothing else at all.
- A **fasting heartbeat** carries nothing beyond the account's bearer token. The
  request body is empty, and the server writes only "this account was here at
  this instant".

The server re-rounds what it is given rather than trusting it, and clamps both
values, so a device that sent an exact figure or an absurd one still lands on
the same grid everybody else is on. A grid is the privacy property: an exact
1237 kcal in a day sum of two contributors is close to one person's dinner, and
1250 is not.

`GET /v1/pulse/today` reads back one row of instance-wide sums and a count of
people fasting. It answers no question about any individual, and the client
draws nothing at all below a floor of three contributors.

### Why presence must be account keyed

The honest instinct is to make the fasting heartbeat anonymous, because nothing
about "somebody is fasting" needs a name. It does not work, for two reasons
that both bite at once:

1. **Rate limiting needs an identity.** Every other guard on this service keys
   on the resolved account (`ai/rate-limit.ts`). An unauthenticated heartbeat
   could only be keyed on an IP address, which puts a household behind one NAT
   into one bucket and puts a script behind a VPN into nobody's.
2. **Deduplication needs an identity.** One row per fasting person is the whole
   number. Without a key, the same heartbeat can be **replayed** as many times
   as somebody likes, and "12 people are fasting" becomes whatever the loudest
   caller decided. An inflated counter is worse than no counter, because a
   reader cannot tell.

So presence is one row per account, replaced by an upsert on every heartbeat.
The row is not a history: the previous value is overwritten, never appended.

### What is kept, and for how long

- **Day sums** (`pulse_days`) and the contributor rows beside them
  (`pulse_day_contributors`) are kept **30 days** and then deleted by an hourly
  sweep, the same shape `ai/usage-retention.ts` already runs. A contributor row
  is a day and an account id, which is the one account-attributable thing this
  feature stores, and 30 days is short because the only question it answers is
  "how many distinct people contributed today".
- **Presence rows** (`pulse_presence`) expire **30 minutes** after the last
  heartbeat, and the same hourly sweep deletes the expired ones. An expired row
  is not counted before it is deleted, so a late sweep changes a number nobody
  can read.
- **Idempotency keys** (`pulse_idempotency`) are kept 24 hours, which is what
  makes an offline replay a no-op rather than a double count, and then deleted.
- **The routes log a status code and a byte count only.** Never the account id,
  and never a value from the body. That is stricter than the AI proxy, which
  logs an account id, and it is stricter on purpose: the proxy's log line is an
  operational record of somebody spending the operator's money, and a pulse
  write is somebody telling the instance they ate lunch.

### The correlation this cannot fix, named

M223 will add a push wake up, and the field it carries is `wake_at`: the
instant a device wants to be woken, which for a fasting person is the end of
their fast. A fasting heartbeat describes the same fast from the other end.

An operator with database access can therefore line up a `pulse_presence` row
and a `wake_at` row for the same account and learn when that person is fasting
and until when. Nothing in either feature prevents it, because both need the
account id for reasons that are not negotiable, and a scheme that blinded one
of them would be un-blinded by the timing anyway.

This is **named and accepted for opt in accounts**. A person who has not turned
the pulse on writes no presence row, and a person who has turned it on has been
told, in the app, that the instance learns they are fasting. It is written down
here rather than discovered later, which is the rule this repository actually
keeps.

## Consequences

- `README.md`'s "two places" paragraph becomes three, and `PROTOCOL.md` §9.2
  gains the pulse on the side of what the server does know.
- The server gains three tables and one more hourly sweep, and the tables are
  small by construction: one row per day, one row per contributor per day, one
  row per fasting account.
- `GET /v1/admin/stats` reports today's pulse to the operator beside the AI
  counters, which is the same number every member can already read.
- An instance that nobody opted in on holds an empty set of tables and answers
  every field as zero, which is indistinguishable from one where nobody ate.

## Alternatives considered

- **No account id anywhere.** Refused above: replay makes the number a lie.
- **A probabilistic sketch for the contributor count.** A HyperLogLog would
  remove the contributor rows entirely, at this instance's size it would be a
  harder thing to reason about than a table that is pruned on the same
  schedule, and the rows it removes are already the shortest lived thing here.
- **Deriving the numbers from what is already stored.** There is nothing to
  derive from. `ai_usage_days` counts requests, not meals, and a request count
  would report the AI users rather than the trackers.
