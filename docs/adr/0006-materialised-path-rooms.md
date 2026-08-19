# 6. Rooms as materialised paths

Date: 2026-08-19

## Status

Accepted

## Context

Devices live in rooms, and "move this device to another room" is a required management
function. Larger houses want structure — floors, wings, outbuildings — and PDF output reads
far better grouped by area than as a flat list.

Options considered:

1. **Free-text location per device.** Trivial, never wrong, but typos fragment grouping
   (`Kitchen` and `kitchen` become two rooms) and renaming a room means editing every
   device in it.
2. **A real tree: rooms with `parentId`.** Properly models hierarchy. Costs a tree editor,
   move-with-children semantics, and reparenting conflicts under offline sync — where two
   people can concurrently move a subtree into each other, producing a cycle. Detecting and
   repairing that is genuinely hard, and it is hard in the one place we least want
   difficulty.
3. **A managed room list where the name *is* a path** — `Ground Floor/Kitchen`.

## Decision

Each project holds `room` documents whose `path` is a materialised path with `/` as the
separator. Devices reference a room by id. Hierarchy is derived by splitting the string.

Rooms can be created inline while adding a device, so filing a device never requires
leaving the flow to go and set up a room first.

`/` was chosen over `.` because `.` reads badly in names and collides with abbreviations
like `No. 2`.

## Consequences

- Hierarchy for grouping, filtering and PDF sectioning, with no tree UI to build.
- Renaming a room is one document write, not N. Devices reference the id, not the path.
- No reparenting conflicts. Two people renaming the same room concurrently is an ordinary
  last-write-wins scalar conflict, not a graph-integrity problem.
- Moving a whole subtree means rewriting the paths of its descendants — a prefix update
  across the room list. Cheap at these sizes (a house has tens of rooms), but it is a loop,
  not a single write.
- The path is a string, so `Ground Floor/Kitchen` and `ground floor/Kitchen` are different
  rooms. Normalise and warn on near-duplicates at creation time.
- A device whose room is deleted must not be orphaned. The conflict and deletion rules
  reassign it to `Unassigned/<old path>` so it stays findable (ADR 0010).
