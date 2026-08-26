# Listing, searching and filtering devices — design

Date: 2026-08-26
Issue: [#23 M2-6](https://github.com/beyonddemise/matter-manager/issues/23)
Status: proposed

## The shape, which is the same shape as last time

M2-5 put the decision about *what to write* in `core` (`planNewDevice`) and left the view with
rendering. This does the same for *what to show*:

```ts
export function browseDevices(
  devices: readonly DeviceDocument[],
  rooms: readonly RoomDocument[],
  options?: BrowseOptions,
): readonly DeviceGroup[]
```

Grouping, matching and ordering are decisions over plain data. Put in the view they would need
a DOM, a database and a rendered page to test; put here, "a search for a room name finds what
is in that room" is one line and a millisecond. What is left in `device-list.ts` is genuinely a
rendering job.

Out of scope: editing, moving and disabling *from* this list (M2-8) — this story only has to
show that a device is disabled and let it be filtered, not change it. Remarks (M2-9), the
device page (M2-7).

## Search

One box, matching against name, room path, spot, serial, product name and vendor name. The
issue names four of those; `spot` and `vendorName` are here because "ceiling" and "the Ikea
one" are both how people describe a device they are hunting for, and neither match is ever
surprising.

**`payload` and `manualCode` are excluded, and that is a security decision rather than a
scoping one.** They encode the setup passcode. A search box that matched them would confirm a
guess — type digits, watch a device appear — turning the list into an oracle for the one secret
this application holds. A test asserts it, next to the reason.

Terms are whitespace-separated and **all** must match. "kitchen light" finds the light in the
kitchen, not everything in the kitchen plus every light in the house.

### One shared answer to "is this the same text?"

`roomPathKey` already had to decide that `Ground Floor/Kitchen` and `ground floor / kitchen`
are the same room: case folded (upper, not lower, so `Straße` matches `STRASSE`), whitespace
collapsed, Unicode composed. Search needs exactly that decision again.

Having two of them would mean a search that fails to find the room the duplicate check just
refused to create. So the logic moves to `core/text/fold.ts` as `foldForComparison`, and
`roomPathKey` becomes one of its two callers — `splitRoomPath(…).map(foldForComparison)`. No
behaviour changes; the 58 room-path tests are the proof of that, and a short test file pins the
properties directly now that the fold has a second caller with its own reasons to depend on
them.

Fields are joined on a **newline** before matching. A folded query can never contain one, since
`foldForComparison` collapses every whitespace run to a single space — which is what stops a
term like `light/ground` from matching across the name and the room path and reporting a device
that contains that string nowhere. Joining on `/`, the obvious choice given room paths, has
exactly that bug.

## Ordering, and the one thing `core` cannot know

Ordering is genuinely locale-dependent: in German `Ärmelleuchte` belongs beside `Armel`, not
after `Zuluft`. But `String.prototype.localeCompare` with no argument reads a locale from the
environment, which is the ambient dependency this package refuses.

So `BrowseOptions.compare` is a seam. The default folds and compares by code point —
deterministic, fine for ASCII. `device-list.ts` passes `new Intl.Collator(getLocale()).compare`,
because the view already knows which locale it is rendering in. Two lines, and the alternative
was either a wrong default or an ambient read.

## Two facts the list must not confuse

**"No devices yet" and "nothing matched".** Telling someone with a full catalogue that it is
empty because they mistyped a word is the kind of small lie that makes people stop trusting an
application. The empty state checks `devices.length` and not the number of *results*.

**A device whose room is gone.** `roomId` may name a room deleted on another replica. Those
devices are grouped under `''`, sorted last, and headed "Without a room" — never dropped, and
never shown with a raw `room:…` id in place of a name. Losing sight of a device is the failure
this whole application exists to prevent, so the one thing that must not happen is a device
becoming invisible because its room did.

Groups with no devices are not produced at all: a search for "kitchen" that also listed every
empty room in the house would bury the two results it found.

## Disabled devices

Left out unless the checkbox asks for them, and marked with a `<wa-tag>` plus a dashed border
when shown — reduced emphasis, not reduced contrast. A device someone cannot read is one they
cannot make a decision about, and deciding is the whole reason to look at a disabled device.

## What could go wrong

**A test proves the widget rather than the behaviour.** Every search test asserts on the device
ids actually rendered, not on component state.

**The fold extraction changes room behaviour silently.** It is a move, not a rewrite, and the
room-path suite runs unchanged against it. Mutation probe: 10/10 on `browseDevices`.

**Searching becomes an oracle for the passcode.** Covered above; asserted, not merely intended.
Any future field added to the haystack has to be checked against that rule.
