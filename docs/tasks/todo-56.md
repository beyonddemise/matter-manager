# M5-9 Project settings (#56) — the room list

**This does not close #56.** It builds the room-list operations the story needs, as pure
functions in `core`. The interface that calls them, and the project's own name and address, are
separate and are noted at the end.

- [x] `roomsInOrder` — the order rooms are shown in
- [x] `reorderRooms` — a manual order, returning only the rooms that move
- [x] `renameRoom` — the room and everything inside it, refusing collisions
- [x] `devicesInRoom` — what an interface asks before it offers to delete anything
- [x] `planRoomDeletion` — the scenario: **a destination is not optional**
- [x] `UNASSIGNED_ROOM_PREFIX` moved to where rooms live, rather than duplicated
- [x] Mutation probes: 14/14 caught
- [x] `npm run verify` green

---

## The scenario is enforced by a signature, not by a check

> When I delete a room containing devices, then I must choose a destination room or confirm
> moving them to "Unassigned".

`planRoomDeletion` takes `destination: RoomDestination` as a **required argument**, and no value
of that type means "never mind". There is no overload without it and no default. So "delete this
room silently" is not a thing the API can express, which is a stronger guarantee than a check
inside a function somebody could add a second entry point around.

It is required even when the room is empty. That looks redundant for one call and is the reason
the guarantee holds: an optional-when-empty parameter is an optional parameter, and the caller
who forgets it is the caller who did not check whether the room was empty.

The refusals are the cases that read as no-ops and are not:

- **Moving devices into the room being deleted.** The room goes, and every device in it then
  points at a document that does not exist.
- **A destination that is not there.** Same outcome, one step later.
- **Deleting a room that is not there.** Nothing to plan, and inventing an empty plan would
  report success for an operation that did nothing.

## Only what changed, everywhere

Every function returns the documents that actually differ. A drag past one neighbour changes two
rooms, not forty; a rename touches the subtree, not the list. This is not micro-optimisation: on
a shared project each rewritten document is a document somebody else's phone downloads, and a
reorder that rewrote everything would replicate the whole room list on every drag.

`reorderRooms` **refuses a partial order**. A list naming two of five rooms says where those two
go and nothing about the rest, so any answer is invented — and the plausible-looking guess,
"reorder the ones I recognise", silently drops the others off the end.

## `sortKey` is a position in the list, not among siblings

The hierarchy here is derived from the path (ADR 0006), so an intermediate level such as
`Ground Floor` may have **no document at all** — and a sibling ordering would need a `sortKey`
on a room that does not exist. So `sortKey` orders the whole list, and a room nobody has
arranged sorts after every room somebody has, rather than being given an invented position among
them. Inventing one would move it the first time anybody dragged anything else.

## Renaming refuses a collision, including a confusable one

Two documents with the same path are two rooms a person cannot tell apart — the duplicate M1-5
and M2-5 both exist to prevent, arriving through the one door nobody was watching. The check is
`isNearDuplicateRoomPath`, so `ground floor / kitchen` counts, matching the rule the add and
edit flows already use.

The comparison is against the rooms **staying put**, not against the whole list. A room landing
where another room is simultaneously moving away from is not a collision, and comparing against
everything would refuse a rename that is perfectly well defined. There is a test for the subtle
half: the room being renamed is fine, and one of the rooms it drags with it lands on something.

## Two constants for one room, caught by a test

`sync/merge.ts` has resurrected deleted rooms under `Unassigned` since M2. Writing this, I added
`UNASSIGNED_ROOM_PATH` beside it with the same value — two names for one room, which is two
rooms the day somebody changes one.

`public-api.test.ts` pins core's exported names exactly, and it failed on the new name. That is
the test doing more than it says on the tin: it is written to catch an *accidental* export, and
it caught a *duplicated* one. The constant now lives in `rooms/path.ts`, which is where room
concepts belong and which `sync/merge.ts` already imported from.

## A probe harness that was lying, briefly

The first probe run reported the **no-op control as caught**, which is impossible — the control
replaces `[...rooms]` with `rooms.slice()`. It was not flaky: the `core` suite already had one
failing test, because my scoped runs against `test/rooms/list.test.ts` never ran `public-api`.
Every "caught" in that run was one pre-existing failure plus whatever the mutant did.

**The control is what makes a probe run readable.** Without one, that entire sweep would have
read as fourteen honest catches.

## Not done

- **The interface.** `area:web`, and #120 stands in front of it: the application does not yet
  reach any of this.
- **The project's own name and address.** That is a write to the central registry, so it needs a
  `PATCH /projects/{projectId}` the OpenAPI contract does not have — API work with its own
  contract change, not room work. Worth its own issue rather than being folded in here.
