# 21. A room is a property of the device

Date: 2026-10-19

## Status

Accepted (supersedes the storage half of 0006; amends 0010)

## Context

ADR 0006 chose materialised paths (`Ground Floor/Kitchen`) and kept them in `room` documents
that devices pointed at by id. The path grammar has worked well. The documents have not
earned their keep.

- A room document holds one field anybody reads, `path`, plus a manual `sortKey`. Every
  screen that shows a device reads a second document type to print a name. That is a
  relational foreign key carried into a document database.
- The reference can dangle. To keep devices findable, the project grew the machinery that
  orphaned references need:
  - a conflict rule that resurrects a deleted room as `Unassigned/<path>` (0010);
  - a browser-side record of deleted rooms, to explain such a resurrection;
  - a delete dialog that asks where the devices go;
  - a "write the room before the device" ordering in every form.
- ADR 0006's main argument for the id, that a rename is one write, saves little. A house has
  tens of devices per room, and a rename is a rare, deliberate act.

0006 rejected free text per device because typos fragment grouping (`Kitchen` versus
`kitchen`). That risk is real, and it is now handled where the text is entered and where it
is shown, rather than by a second document.

## Decision

- **A device carries its room's path**: `room: "Ground Floor/Kitchen"`, in the ADR 0006
  grammar. There is no room document and no `roomId`.
- **The rooms a project has are derived from its devices**, in memory (`roomsOf`). No view or
  index: every screen that needs rooms already reads every device, and the list is short. A
  room appears with the first device filed under it and goes with the last one.
- **A room is identified by its folded key** (`roomPathKey`), not by its exact text.
  - Spellings that fold to one key (`Kitchen`, `kitchen`) are one room. Grouping, the room
    filter, PDF export and rename all match by key.
  - No spelling is chosen as the room's real name. The Rooms page lists every spelling and
    offers **Merge**.
- **Typing reuses an existing spelling.** It is matched ancestor by ancestor, so a new room
  under `Ground Floor` keeps that floor's spelling. New spellings arise only from devices
  saved before they synced.
- **Rename rewrites every device in the room and the rooms inside it.** Merge is the same
  operation with a chosen name. There is no delete and no manual order. A room is emptied by
  moving its devices.
- **No migration.** Documents written under 0006 are not repaired.
  - An old `room:` document is ignored, by reads and by the conflict watcher alike.
  - A device without `room` is listed under "Without a room" rather than dropped.

## Consequences

- One document per device, and the room travels with it: export, sync and conflict merge see a
  device whole. A room conflict is an ordinary last-write-wins scalar on the device.
- The machinery for room documents is deleted:
  - room merging and the `Unassigned` rule;
  - the deleted-rooms record and the "is back" message;
  - the delete dialog;
  - the room-before-device write order.
- A rename writes one document per affected device, not one per room. It is planned from
  what was read and is safe to retry after a partial failure.
- Manual room order is gone. Rooms sort by path, segment by segment (#242), as the device list
  always did.
- Case no longer distinguishes rooms. ADR 0006 treated `Ground Floor` and `ground floor` as
  different rooms with a warning. They are now one room with two spellings, which is what a
  person reading them assumes.
  - The key is `foldForComparison` per segment: whitespace collapsed, case folded (`ß` and
    `SS` match), and Unicode composed, so a pasted decomposed `ü` matches a typed one.
  - Accents are kept: `Küche` and `Kuche` remain two rooms, as they are two words.
