# todo-142 — Room management had no caller

Closes #142.

## The defect

`packages/core/src/rooms/list.ts` exports `roomsInOrder`, `reorderRooms`, `renameRoom`,
`devicesInRoom` and `planRoomDeletion`. Every one was imported by nothing but `core/src/index.ts`
and core's own tests. Ordering, reordering, renaming and deleting a room were implemented,
reviewed and green — and none of them existed in the running application.

`20d59c0` is candid about what it built: `feat(core)`, *"pure functions that plan and do not
write — so a deletion touching a room, a new room and nine devices is one decision, written by
the caller in whatever order the store needs."* The caller is what did not exist.

**This is #120 one package over**, and my own check could not see it: `check-module-graph.mjs`
walks from `packages/web/src/main.ts` and only scans `packages/web/src`, so a `core` module that
no web module imports is outside its reach.

## Found while spiking #125

#125 wants a message when a room you deleted comes back. The spike established the signal is
real — the deleting device does hear about the resurrection through its own change feed, alive,
under the other person's name. But the scenario opens *"Given I deleted a room while offline"*,
which could not happen. Building the notification first would have been a branch nothing can
feed: L32, the lesson #125 is itself written around.

## What this adds

A rooms view at `#/rooms`. Every write is the caller's half of a plan `core` already made, in the
order the plan says.

- **Order** from `roomsInOrder`, not sorted here. A second answer would drift from the first.
- **Reorder** with buttons rather than dragging: the people using this are standing in a building
  holding a phone, and `reorderRooms` returns only the rooms whose position actually changed, so
  a nudge writes two documents rather than forty.
- **Rename** through `renameRoom`, which moves the whole subtree — renaming `Ground Floor` has to
  take `Ground Floor/Kitchen` with it. A collision throws, nothing is written, and the name is
  the user's to choose again.
- **Delete** through `planRoomDeletion`, whose required destination is the mechanism rather than
  a check: no value of `RoomDestination` means "never mind". The dialog asks even for an empty
  room, because an optional-when-empty parameter is an optional parameter.

Read-only projects get no controls at all, absent rather than disabled, as #55 established.

## The route guard did not guard

`routes.test.ts` has a test called *"registers no route whose view the shell cannot render"* that
compares the registry against a hardcoded array. It pins the registry, which is worth something,
but it never looks at the shell — a route naming a view that does not exist would pass it as long
as the array was updated to match.

It cannot look: that file runs in Node, and importing the shell defines custom elements. So the
claim now lives in `views.browser.test.ts`, in both directions — every route has a view, and no
view goes unrouted. The second half is #120's defect in miniature, and that map is exactly where
one would sit unnoticed.

## Tasks

- [x] A rooms view, reached from the navigation
- [x] List in the domain's order, with the device count per room
- [x] Rename, including the subtree, with collisions reported and nothing written
- [x] Reorder, writing only what moved
- [x] Delete, with the destination the plan requires, asked even when the room is empty
- [x] No controls at all on a read-only project, with a positive control in the tests
- [x] The route guard makes the claim its name makes
- [x] German for all fourteen new strings

## Review

`npm run verify`, `check:offline`, `check:graph` and `probe:runtime` all clean; 2255 tests pass.

The domain logic needed no changes at all, which is the encouraging part: it was written from the
scenarios and it fitted the interface built on it a milestone later without argument.
