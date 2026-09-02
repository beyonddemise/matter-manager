# todo-125 — A room I deleted comes back, and nothing says why

Closes #125.

## The spike first, because the issue asked for one

The issue is explicit that `mergeRoom`'s resurrection branch **cannot be reached**: CouchDB
reports a losing deletion in neither `_conflicts` nor the change feed, and when every branch is
deleted the feed carries a bare tombstone. So it asks where the signal comes from before anything
is built on one.

Probed against three replicating databases rather than reasoned about:

```
heardAboutIt: true   arrivedDeleted: false   isAliveOnA: true   pathOnA: "Cocina"
```

The deleting device **does** hear about it, through its own change feed, as a live document under
the other person's name. The signal is real and costs no extra read.

## And then the scenario turned out to be unreachable

*"Given I deleted a room while offline"* could not happen: there was no way to delete a room in
the interface at all. `planRoomDeletion` and its neighbours were imported by nothing but core's
own tests — #142, which is #120's defect one package over, and which had to be built first.

Building the notification before that would have been a branch nothing can feed. Which is L32.
Which is the lesson this issue is written around.

## What it does

A comparison, not a subscription. The rooms list is read anyway, so asking "is anything I deleted
in it?" costs nothing — and gives the same answer whether the room came back a second ago or
while the tab was closed, which a change-feed listener would not.

Matched by **id**, never by path: the whole point is that it came back under a different name, so
a path comparison would find nothing exactly when there is something to find.

The record lives in `localStorage`, per database, and is never replicated. It answers "did *I*
delete this?" — a record that travelled would answer it for everybody, including the person whose
rename won, who has nothing to be told.

## What the message says

Both names. *"Kitchen is back as Cocina, because somebody else changed it while you were offline.
Nothing was lost."*

- **Both names**, because "Cocina is back" is a different puzzle to the one being solved.
- **Who caused it**, because the alternative reading — that the application dropped the deletion —
  is the one that makes somebody stop trusting it.
- **Nothing was lost**, because that is true and is the reader's actual worry.
- **Delete it again** is one button, not a hunt through the list for a room under a name they did
  not choose. Keeping it is the other button, and forgets the record.

## What it deliberately does not do

**Make the deletion win.** That needs `open_revs: 'all'` on every document on every read, to find
losing branches the database will not otherwise report — a second read per document, on every
list, to change an outcome that is already the safe one. The rename still stands on both devices,
and there is a test asserting exactly that.

## Tasks

- [x] Spike: establish that the signal exists at all
- [x] `resurrectedRooms` in `core`, pure and matched by id
- [x] A record of what this device deleted, per project, never replicated, pruned after 30 days
- [x] Malformed stored values dropped rather than trusted
- [x] The message, naming both names and the cause
- [x] Deleting it again in one action; keeping it forgets the record
- [x] The other person sees nothing, with no rule suppressing it — they simply have no record
- [x] Proved through real replication, not stubs
- [x] German for all four new strings

## Review

`npm run verify`, `check:offline`, `check:graph` and `probe:runtime` clean; 2291 tests pass.

The integration test uses the three-database harness from #53 because a stub would let the test
decide what replication does — and what replication actually does was contrary to what the code
assumed twice before.
