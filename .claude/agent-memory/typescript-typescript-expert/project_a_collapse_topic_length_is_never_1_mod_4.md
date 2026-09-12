---
name: a-collapse-topic-length-is-never-1-mod-4
description: openplate-core's web push collapse topics must never be 1 mod 4 characters long, because Apple decodes them as base64 and FCM does not
metadata:
  type: project
---

`src/push/send.ts` ships `openplate-catchups` (18) and `openplate-fast` (14).
The trailing "s" is not a typo: `openplate-catchup` is 17, and 17 mod 4 is 1,
which base64 cannot produce.

**Why:** APNs decodes the RFC 8030 collapse topic and answers
`400 BadWebPushTopic` for such a length, while FCM and Mozilla treat it as
opaque. The defect is therefore invisible on every device except an iPhone, and
nothing surfaces it but the push service's own log. Measured in the collie
project first (`collie-update` failed, `collie-updates` worked). The M223 spec
named the 17 character form and called it 16.

**How to apply:** any new topic goes through `topicIsSendable` and its test in
`tests/unit/push-payload.test.ts`. Never rename a topic for tidiness without
recounting. The two kinds must also keep SEPARATE topics, or a queued catch-up
and a fast target alert overwrite each other on an offline phone.
