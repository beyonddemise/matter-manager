# Todo — #32 · M3-1 Export an inventory PDF

Branch: `32-inventory-pdf` (stacked on `31-sw-updates-offline-ux`)

## Acceptance criteria (from the issue)

```gherkin
Scenario: an inventory is generated
  Then a PDF is produced containing every enabled device
  And devices are grouped under their room path
  And each entry shows name, room, product, installation date, QR code and manual code

Scenario: the printed QR actually scans
Scenario: it works offline
```

> **The scannability scenario needs manual verification at least once per layout change.**
>
> **Getting the QR into the PDF.** `<wa-qr-code>` … its encoder is bundled inside the component
> rather than separately importable … the printed QR is **raster, not vector**, which makes
> render resolution a correctness concern rather than a cosmetic one.

## Plan

- [x] `core/pdf/layout.ts` — pagination, and every page-break invariant
- [x] `web/pdf/qr-image.ts` — the off-screen render, at four pixels per point
- [x] `web/pdf/inventory.ts` — the drawing, with `pdf-lib`
- [x] `web/pdf/download.ts` — the strings, and handing the file over
- [x] The export button on the device list, with progress and cancellation
- [x] `pdf-lib` moved from the policy's allowlist into an actual dependency

### Tests (each observed failing first)
- [x] every device appears exactly once, whatever the pagination
- [x] a heading is never stranded at the foot of a page
- [x] a room continued across a break repeats its heading, marked as continued
- [x] nothing is placed past the printable area
- [x] the QR embedded in the PDF **decodes back to its payload**
- [x] the export takes what is on screen, filter and all
- [x] progress is reported, and the export can be called off

## Review

**Two of the three scenarios are proved automatically. The third cannot be.**

The issue says so: a QR that renders correctly on screen but prints too small or too
low-contrast is a defect only physical testing finds. What *is* proved here is everything up to
the paper: the PNG that reaches the PDF is decoded back to the exact payload it was built from,
by ZXing, from the rendered pixels — not from the property that was set. A test asserting
`value === payload` would pass against a component that drew nothing at all, and a blank code
in a printed inventory is discovered years later by someone holding a phone up to it.

**Resolution is treated as correctness, not polish.** `<wa-qr-code>` keeps its encoder inside
the component, so there is no matrix to draw as vector rectangles and the printed code is
raster. It is rendered at four pixels per point — a 96pt code at 384px, about 288dpi — and a
test asserts that ratio, because a code rendered at printed size has soft module edges on paper
and a phone at arm's length inside a fuse box is not a forgiving reader.

### The layout is in `core`, and that is where the bugs were

Pagination is arithmetic over plain data, and every failure worth catching in an inventory is a
layout failure: a device printed twice, a device printed nowhere, a heading stranded above
nothing, an entry clipped by the printer. None of those is visible in a byte comparison of a
PDF, and all of them are properties of the plan.

**A real bug was caught before the implementation was believed.** A room whose first device
landed exactly on a page break lost its heading entirely — the obvious `else if` structure
skips the heading when the page-break branch runs. The test named it; the fix has a comment
saying so.

**The mutation probe caught 5 of 8, and the three survivors were all "no test produces that
geometry".** A4's round numbers hide them:

- *Heading measured apart from its device.* Differs only when the space left takes the entry
  but not the heading above it. A4's 116pt entries never land in that window; a geometry chosen
  to does, and without the fix the heading fits and the device beneath it runs off the page.
- *Footer space not reserved.* Losing 24 points happens to admit no further entry at A4's entry
  height, so the assertion could not see it. A geometry with 20pt entries can.
- *Breaking onto an already-empty page.* Only reachable when one entry cannot fit at all — a
  bug elsewhere, but the answer to it must not be a document of alternating blank pages.

8/8 after. Every one of those cases exists because the probe asked a question the round numbers
made unanswerable.

### Other decisions

**The export asks `browseDevices`.** The same function the screen uses, so the PDF and the list
cannot disagree about what the project contains — and the search and disabled filter apply to
the export exactly as the user sees them. M3-2 turns that consequence into a deliberate choice.

**A project with nothing in it still produces a file.** A zero-page PDF does not open, which is
a worse answer to an empty project than a page saying it is empty.

**The document carries a title and no other metadata.** Metadata is the quiet way documents
carry things nobody meant to publish, and this one is handed to other people.

**It works offline** because nothing in the path touches the network: `pdf-lib` writes bytes,
the codes are rendered by a component already loaded, and the fonts are the PDF standard
fourteen, which are named rather than embedded.

### Still to do, by design

- **M3-4** turns "Helvetica covers German" from an assumption into a test that extracts the text
  back out. Standard-14 fonts are WinAnsi-encoded, which does cover ä ö ü ß — but that is
  exactly the kind of thing that is true until it is not.
- **M3-5** measures whether 500 devices need a worker. The progress and cancellation seams this
  PR adds are what that measurement will be built on.
