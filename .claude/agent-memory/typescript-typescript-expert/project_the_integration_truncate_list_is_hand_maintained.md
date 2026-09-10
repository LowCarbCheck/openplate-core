---
name: the-integration-truncate-list-is-hand-maintained
description: tests/integration/db-harness.ts resets state with one TRUNCATE naming every table by hand, so a new table leaks between tests unless it is added
metadata:
  type: project
---

`setupTestDatabase().reset()` issues ONE
`TRUNCATE TABLE a, b, c ... RESTART IDENTITY CASCADE` with the table names
written out. `beforeEach` calls it in every integration suite.

**Why:** CASCADE only reaches tables that reference something in the list. A
table with no foreign key, such as `ai_instance_days` (M212 spec 02, keyed on
the UTC day and referencing nothing on purpose), is never emptied. The symptom
is a counter that carries into the next test and an assertion that fails as a
fixture problem, in a DIFFERENT test from the one that wrote the row.

**How to apply:** every new table in `src/db/schema.ts` needs its name added to
that TRUNCATE, in the same change. Check specifically whether the table has a
foreign key: if it does not, CASCADE will not save you.

Related: [[a-schema-change-reddens-every-integration-test]].
