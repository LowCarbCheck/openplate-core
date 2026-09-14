# The mail translation memory

`<lang>.json` in this directory is the record of every bought string in
`src/mail/strings.<lang>.ts`, keyed by a hash of its path and the English it
translates:

```json
"188786ebf7e2b659": { "en": "Hello,", "path": "mail:reset.greeting", "model": "google/gemini-3.8-flash", "at": "2026-09-14", "fr": "Bonjour," }
```

It is written by `pnpm translate:mail --locale <lang> --local`
(`scripts/translate-mail.ts`) and read by nothing at runtime. The service
ships the module, not this file.

## The memory is the record, the module is its output

Every run rebuilds `strings.<lang>.ts` from the English in `strings.ts` and
this memory, memory first. A French sentence changed by hand in the module
alone is put back by the next run, and `tests/unit/translate-mail.test.ts`
fails before that on a module that no longer matches its memory. To change a
translation:

- edit the entry here, found by its `path` field, then run the script for
  that language (it buys nothing and rewrites the module), or
- delete the entry, and the next run buys that one string again.

## Why an English edit costs one string

Editing an English string in `strings.ts` changes its hash, so exactly that
key stops matching and is bought on the next run. Every other entry still
resolves. The run refuses to write a module with a missing string, so a
reworded English sentence is a red typecheck in no language and a red
`pnpm translate:mail` in four until each is bought.

## Two languages are not here

`en` and `de` are hand-written in `strings.ts` and were judged by wordsmith.
They are never bought and have no memory file.
