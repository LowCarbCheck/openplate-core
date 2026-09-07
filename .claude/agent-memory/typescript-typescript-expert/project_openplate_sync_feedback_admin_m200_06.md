---
name: openplate-sync-feedback-admin-m200-06
description: A Postgres cascade hides a missing store delete, so the object-store-safe path needs a fake-backed unit test
metadata:
  type: project
---

In `openplate-sync`, `feedback_images.report_id` cascades from
`feedback_reports`, which cascades from `accounts`. Deleting the row therefore
deletes the bytes today, so an integration test that reads the image store back
after a delete CANNOT tell a correct implementation from one that never calls
`FeedbackImageStore.delete`.

**Why:** `FeedbackImageStore` exists so the bytes can move to S3 or MinIO with
one adapter and no caller change, and an object store has no foreign key to
Postgres. Code that leans on the cascade keeps deleting rows and silently keeps
every photograph forever after that move, with a green suite.

**How to apply:** delete the image through the store FIRST and the row second,
in both the admin delete route and the retention sweep. Guard it with a
fake-backed unit test (`tests/unit/feedback-retention-schedule.test.ts`), where
there is no cascade to cover the omission. Proven by mutation on 2026-09-07:
removing `images.delete` from `purgeExpiredFeedback` fails the unit test and
PASSES the integration one.

Related: [[openplate-sync-gate-and-toolbox]].
