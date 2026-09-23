# The text of the declaration letters

`POST /v1/legal/declarations` takes a cancellation (§ 312k BGB) or a withdrawal
(§ 356a BGB), stores it, and mails two letters: a receipt to the person who
filed it and an alert to `MAIL_OPERATOR_EMAIL`. This page says where the words
of those two letters come from, and what goes out when there are none.

This service ships no letter text of its own beyond a neutral fallback. The
words are yours: you write them, you have them reviewed, and you mount them.

## Where the files go

Set `CONTENT_DIR` to a folder, and mount that folder read-only into the
container. It is the same variable, and can be the same folder, the openplate
app reads its legal pages from. This service reads four files from it:

| File                                            | Languages  | Placeholders                                              |
| ----------------------------------------------- | ---------- | --------------------------------------------------------- |
| `<lang>/mail/declaration-receipt-kuendigung.md` | `de`, `en` | `{{date}}`, `{{details}}`                                 |
| `<lang>/mail/declaration-receipt-widerruf.md`   | `de`, `en` | `{{date}}`, `{{details}}`                                 |
| `<lang>/mail/declaration-alert-kuendigung.md`   | `en`       | `{{date}}`, `{{receiptId}}`, `{{details}}`, `{{matched}}` |
| `<lang>/mail/declaration-alert-widerruf.md`     | `en`       | `{{date}}`, `{{receiptId}}`, `{{details}}`, `{{matched}}` |

The receipt is sent in the language the person chose on the form, `de` or
`en`. When that file is missing or refused, the English file is used instead.
The alert is English only.

## What a file looks like

UTF-8, LF line ends, no byte order mark. The file starts with exactly this
front matter, in this order:

```
---
title: A name for the file
updated: 2026-09-23
subject: The subject line of the mail
---
```

`subject` is plain text and may use the file's placeholders. `title` is not
sent. `updated` must be a real date.

The body uses a small subset of markdown: `##` and `###` headings,
paragraphs, `- ` and `1. ` lists one level deep, `**strong**`, `*emphasis*`,
links whose target starts with `/`, `https://`, `mailto:` or `tel:`, a
backslash at the end of a line for a line break, a definition list (a term
line followed by `: definition` lines), and `\` before `\`, `*`, `[` or `]`
for a literal character.

The placeholders:

- `{{date}}` is the time of receipt in Europe/Berlin with its zone name, for
  example `21 September 2026 at 12:15 CEST`, in the file's language.
- `{{receiptId}}` is the receipt number the person's confirmation page shows.
- `{{details}}` must stand alone on its line. It becomes one paragraph per
  field the person filled in, as `Label: value`, in the order the form asks
  for them. The labels are in the file's language and live in this service's
  code.
- `{{matched}}` is `yes` or `no`: whether the typed address belongs to an
  account on this instance.

What a person typed is always inserted as plain text. A `**` or a link in a
form field stays literal in the mail, and the HTML part escapes it.

## When a file is refused

Anything outside the subset refuses the whole file: raw HTML, an HTML
character reference such as `&amp;`, an image, a code span or block, a block
quote, a table, a `#` or `####` heading, an indented line, a placeholder the
file may not use, or a front matter that is not exactly the three keys above.

A refused file is never sent in part. The letter falls back to the next
language, and then to the neutral text below. The service logs one `warn` line
per refused or missing file, with the template name, the language and the
rule it broke, and never the file's content:

```
Declaration mail template not used  template=declaration-receipt-widerruf language=de reason="the file is missing"
```

Each send also logs `text=template` or `text=fallback`, so you can see which
one went out.

## The neutral fallback

With `CONTENT_DIR` unset, or with no usable file, the letters carry the facts
the statutes require and nothing else: no greeting, no promise, no outcome.
The labels are the ones the app's confirmation page shows.

The receipt, in English:

```
Subject: Cancellation confirmed          (or: Withdrawal confirmed)

Type: Cancellation                       (or: Type: Withdrawal)

Receipt no.: <receipt id>

Received at: <date>

<one "Label: value" paragraph per field the person gave>
```

The receipt, in German:

```
Subject: Kündigung bestätigt             (or: Widerruf bestätigt)

Art: Kündigung                           (or: Art: Widerruf)

Beleg-Nr.: <receipt id>

Eingegangen am: <date>

<one "Label: value" paragraph per field the person gave>
```

The operator alert, in English:

```
Subject: New declaration: cancellation (<receipt id>)   (or: withdrawal)

Type: Cancellation

Receipt no.: <receipt id>

Received at: <date>

<one "Label: value" paragraph per field the person gave>

Matched to an existing account: yes.     (or: no.)
```

## Editing a mounted file

The service checks each file's modification time and size on every letter and
reads it again when either changed. An edit shows on the next declaration,
with no restart. A missing or unreadable folder never stops the service or
delays a letter; the declaration is stored before any mail is built.
