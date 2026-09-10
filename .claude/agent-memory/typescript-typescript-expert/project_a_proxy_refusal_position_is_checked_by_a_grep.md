---
name: a-proxy-refusal-position-is-checked-by-a-grep
description: M212's checklist proves the AI proxy's refusal order by comparing line NUMBERS of four substrings, so a doc comment mentioning quota.reserve breaks it
metadata:
  type: project
---

The spec check for `src/ai/proxy.ts` finds the FIRST line containing each of
`const requestedAt = now()`, `account.dailyAiLimit <= 0`,
`'allowance-expired'` (with the single quotes) and `quota.reserve`, then
asserts clock < zero, clock < expiry and expiry < reserve.

**Why:** it is a cheap structural proof that a money-spending refusal sits
before the unguarded `reserve` insert. It is also brittle in one specific way:
a COMMENT is a line like any other. Writing "before `quota.reserve`" in the
comment above the expiry refusal put a `quota.reserve` hit ABOVE the literal
and failed the check while the code was correct.

**How to apply:** in `proxy.ts`, refer to the reservation as "the reservation
in step 3", never by the expression the checker greps for; and never hoist a
refusal's code string into a top-level `const`, because the declaration line
would then precede the clock read. Run the node one-liner from the spec after
editing that function.

M212 spec 02 adds two more of these, on `src/ai/quota-store.ts`: it takes the
text BETWEEN the first and second occurrence of `reserveInstance` and requires
`onConflictDoUpdate` in it and no `sum(`. That forces the implementation to
appear before the interface declaration, because `countRequestsOn`'s
`coalesce(sum(...))` sits between them in any other order. The file now reads
factory-first in its bottom section for that reason. A third greps the 800
characters before the literal `ai-instance-ceiling` for `503` and
`nextUtcMidnight`, so that string must appear nowhere earlier in `proxy.ts`,
not even in the module header.
