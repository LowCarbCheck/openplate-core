# Restoring a wiped diary

What to do when somebody reports that their openplate diary is empty, or nearly
empty, and they did not empty it.

Read this whole page before you run anything. **The server rollback on its own
makes the problem come back**, and the step that stops it is on the person's
devices, not on the server.

## What happened, so you can recognise it

The app keeps the diary in the browser's IndexedDB and its record of what it
last synced in localStorage. A browser can evict the first and leave the
second. The app then compares an intact sync record against an empty store,
concludes that every entry was deleted, and pushes a deletion for each one.

The signature is one blob version a great deal smaller than the one before it,
written seconds after a sign-in. Since M224 the server refuses that push from a
client that does not explicitly confirm it, so on an up-to-date service the
usual report is "sync keeps failing", not "my diary is gone". A loss means the
push happened before the fix, or a client confirmed it and was wrong.

## Before you touch anything

1. **Ask the person not to open the app** on any device until you say so. Every
   time they open it, a sync cycle runs.
2. **Ask which devices they have signed in on.** Phone, tablet, laptop, a second
   browser. You need all of them for step 4, and a device you do not know about
   will undo the repair.

## 1. Look at what the service still holds

```
export ADMIN_TOKEN=...            # OPENPLATE_SYNC_ADMIN_TOKEN
export SYNC_SERVER_URL=https://sync.openplate.de

pnpm sync-api accounts list                      # find the account id
pnpm sync-api accounts blob-versions <id>
```

You get one row per retained version, newest first:

```
VERSION  SIZE        CHANGE    ENVELOPE  CREATED                   PINNED UNTIL
7        1.6 KB      0%        1         2026-09-12T09:14:02.113Z  —
6        1.6 KB      -70%      1         2026-09-12T09:12:44.901Z  —
5        5.2 KB      0%        1         2026-09-12T09:12:44.108Z  2026-09-26T09:12:44.108Z
4        5.2 KB      —         1         2026-09-11T20:03:11.740Z  —
```

Read the `CHANGE` column. The version where it drops sharply is the wipe, and
the version **below** it is the last good copy. A `PINNED UNTIL` date marks a
version the service is deliberately holding because the push that replaced it
was a confirmed large deletion: that is almost always the one you want.

If the last good copy is not in the list any more it has been pruned, and there
is nothing on the server to restore. Say so plainly, and go to
[When there is nothing to restore](#when-there-is-nothing-to-restore).

## 2. Confirm with the person which version to restore

The service cannot read a diary, so it cannot tell you what is in a version. It
can only tell you when it arrived and how big it is. Use the `CREATED` column:
"the last version before 20:03 on the 11th" is a question somebody can answer
about their own day.

## 3. Roll the server back

```
pnpm sync-api accounts rollback <id> --to-version 5 --yes
```

This **deletes** every version above the target. There is no undo, which is why
`--yes` is required. It refuses, without changing anything, if the target is not
there, is already the current version, was written with an envelope format this
build cannot accept, or holds no bytes.

The account's blob is now the good copy again, at the version number its own
encryption was sealed under. A restore is always a rollback for that reason: the
envelope binds the version number, so re-uploading old bytes as a new version
would produce something no app could ever open.

## 4. Erase the local data on every device, before any of them sync

**This is the step the rollback does not do, and skipping it undoes everything
above.** Each of that person's devices still holds the sync baseline that caused
the wipe. The next cycle on any of them compares that baseline against its local
store and pushes the same deletions again, and the server will accept them,
because a second identical push from a device that already confirmed it looks
exactly like the first.

On **every** device they named in step 0, before it goes online with the app:

1. Open the app and sign out of sync, if they can reach the screen.
2. Clear the site data for the openplate origin. In Chrome and Edge:
   Settings, Privacy and security, Third-party cookies, See all site data and
   permissions, find the site, Delete. In Firefox: Settings, Privacy & Security,
   Cookies and Site Data, Manage Data. In Safari on iOS: Settings, Safari,
   Advanced, Website Data.
   If the app is installed to the home screen, uninstalling it is the simplest
   complete answer.
3. Only then sign back in. The device pulls the restored blob as a first sync
   and writes it locally.

Do the devices one at a time, and check the diary looks right on the first one
before you do the second.

## 5. Check the repair

```
pnpm sync-api accounts blob-versions <id>
```

The current version should be the one you restored, or one above it if the
person's first device has since pushed. Its size should be back in the same
range as before the incident. Ask the person to confirm the entries are there.

## When there is nothing to restore

If the last good version has been pruned, say so directly and early. Do not
offer to look further: this service holds ciphertext it cannot read, and there
is no other copy.

What is still worth asking:

- **Does another of their devices still hold the diary?** If a device has not
  synced since the wipe, its local copy is intact. Get it OFFLINE first, or put
  the app in aeroplane mode, then export from it before anything else happens.
  An export from that device is the whole repair.
- **Do they have a backup file?** The app writes one on request, and the backup
  nudge asks for one periodically.

## What to write down afterwards

For each incident: the account id, the version you restored and the one you
discarded, which devices were cleared, and whether the person had another
device holding the data. That is the evidence for whether the refusal and the
pin are doing their job, and it is the only evidence there is.

## Related

- `docs/adr/0009-a-shrinking-blob-is-acknowledged-or-refused.md`, the decision
  and what it costs.
- `PROTOCOL.md` §5.1, the push endpoint and its refusals.
- `PROTOCOL.md` §8, the retention tiers.
