# Todo — #33 · M3-2 Export a selection

Branch: `33-export-selection` (stacked on `32-inventory-pdf`)

## Acceptance criteria (from the issue)

```gherkin
Scenario: selected devices are exported → only those appear
Scenario: a room is exported → devices in that room and its sub-rooms are included
Scenario: disabled devices are opt-in → excluded unless explicitly included
```

## Plan

- [x] `isWithinRoom` extracted in `rooms/path.ts`, and `renameRoomPath` made to use it
- [x] `core/pdf/selection.ts` — a closed union of the three questions, and the filter
- [x] Per-device checkboxes, a per-room export, and a count on the selection button
- [x] Strings through `msg()`, German written

### Tests (each observed failing first)
- [x] only the ticked devices appear
- [x] a room export includes its sub-rooms
- [x] `Floor 1` does not take `Floor 10` with it
- [x] a disabled device cannot be exported even by ticking it
- [x] a selection survives a search typed while choosing
- [x] a room whose devices are all deselected is dropped rather than printed empty

## Review

**All three scenarios met**, and the third one is met by *not implementing it*.

### The disabled rule is satisfied by having one answer, not two

The selection filters the groups `browseDevices` already produced for the screen. A disabled
device is not in those groups at all, so its id in a selection matches nothing — and a device
the user cannot see cannot reach a PDF they hand to someone else, whatever they tick. Ticking
the box marked "Show disabled devices" puts them on screen and therefore in scope, which is
exactly "excluded unless explicitly included", implemented by having no second opinion.

There is a test pinning this specifically, because the obvious alternative implementation —
filtering the raw device list by id — would export a disabled device that had been selected
before the filter changed.

### One rule, two callers

`Floor 1` must not take `Floor 10/Kitchen` with it. `renameRoomPath` already documented that
trap and implemented it inline; the export needs the identical rule. Rather than write a second
`startsWith`, the predicate was extracted as `isWithinRoom` and the rename made to use it. Two
implementations would be two chances to get it wrong, in two features, at different times — and
the export's version of the failure is worse: a rename puts a room in the wrong building, an
export puts rooms nobody asked for into a document handed to someone else.

### What the probe found

4/5. The survivor was the `path !== ''` guard, and chasing it was worth it: the guard is
redundant for every *sensible* selection and load-bearing for one insensible one. An empty
selection path matches the empty group path, so `{ kind: 'room', path: '' }` would export
precisely the devices whose room is gone. An empty string is what an uninitialised variable
looks like, not what a request looks like — so the permissive reading turns a bug elsewhere into
a PDF of exactly the devices nobody asked about. The guard stays, with a comment, and now a test.

### Interface decisions

**The checkbox is outside the row's link.** Inside it, every tick would also navigate to the
device, and on a phone the targets would overlap — choosing several devices would mean visiting
each one.

**The selection button says how many.** On a page where the ticks have scrolled out of view,
"Export selection" is a button whose effect is invisible.

**Per-room export is a button on the room heading.** "Print the labels for the kitchen" is the
request people actually have, and ticking eleven boxes is not an answer to it. Absent for
devices whose room is gone, because there is no room there to export.
