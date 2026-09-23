# Test content folder

A stand-in for an instance's mounted `CONTENT_DIR` (M246/04), used by
`tests/unit/declaration-templates.test.ts` and `tests/unit/mailer.test.ts`.

Every sentence here is a neutral marker, not a letter. The real text lives in
a private repo and never enters this one. `de` holds only the cancellation
receipt on purpose: the withdrawal receipt in German must fall back to the
English file, and the withdrawal alert is missing in every language, so it
must fall back to the neutral text in code.

`../content-refused/` holds one file the contract refuses: it names a
placeholder the template may not use.
