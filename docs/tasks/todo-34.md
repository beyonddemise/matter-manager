# Todo — #34 · M3-3 Label sheet layout

Branch: `34-label-sheets` (stacked on `33-export-selection`)

## Acceptance criteria (from the issue)

```gherkin
Scenario: labels are laid out on a standard sheet
  Then QR codes are arranged on a grid matching a common label stock
  And each label shows the QR, device name and room
  And label boundaries align with the physical sheet when printed at 100%

Scenario: a starting position can be chosen
  Given a partly-used label sheet, start at row 2 column 3
```

> **That last scenario is small and disproportionately appreciated.** Nobody wants to waste
> most of a label sheet to print four labels.

## The part that is not a programming problem

"Label boundaries align with the physical sheet" makes every dimension in this a *measurement*.
A layout that looks right on screen and is 2mm out on paper prints each label across the gap
between two of them, and the only way to find out is to waste a sheet of adhesive stock.

So the numbers were **measured from Avery's own templates** rather than recalled or taken from
a blog — Avery publishes label size and count on its product pages but no margin or pitch
table, and the geometry is in the template files. Each was cross-checked against a label
manufacturer's independent specification.

## Plan

- [x] Verify the stock dimensions from primary sources
- [x] `core/pdf/labels.ts` — the stocks, and the placement
- [x] `web/pdf/labels.ts` — the drawing, at absolute page coordinates
- [x] A dialog for stock and start position, and the instruction to print at 100%

### Tests (each observed failing first)
- [x] each stock's grid fits inside its own sheet, with no overlap between labels
- [x] the A4 grids are centred
- [x] every device is printed exactly once
- [x] row 2, column 3 lands where row 2, column 3 is
- [x] the start offset applies to the run, not to every sheet
- [x] a nonsense start position is clamped rather than refused
- [x] nothing is placed off the sheet, for any stock

## Review

**Both scenarios met**, with the same caveat M3-1 carries: the final assertion is physical and
needs one test print.

### What the sources said, including where they disagree

| Stock | Label | Grid | Top | Pitch |
|---|---|---|---|---|
| L7160 / J8160 | 63.5 × 38.1mm | 3 × 7 | 15.15mm | 66.04 / 38.1mm |
| L7163 / J8163 | 99.06 × 38.1mm | 2 × 7 | 15.15mm | 101.6 / 38.1mm |
| 5160 (US Letter) | 66.675 × 25.4mm | 3 × 10 | 12.7mm | 69.85 / 25.4mm |

All three are horizontally gapped, **vertically butt-cut** — zero vertical gap — and centred.

Two things worth recording rather than smoothing over:

- **Avery's own L7160 template sits ~0.18mm right of centre.** That is below the sheet's own
  ±2mm manufacturing tolerance and reads as a twip-rounding artefact of Word. The grid is
  centred geometrically from the verified pitches instead, which is what the independent
  manufacturer specification agrees with. A test pins the centring.
- **L7651 (65 per sheet) was left out.** Its sources disagree: Avery's template says 21.17mm
  rows and a 10.88mm top margin, the manufacturer says 21.2mm and 10.7mm. Over thirteen rows
  that accumulates to nearly half a millimetre, and the manufacturer additionally warns that
  the stock is sometimes made with a different horizontal pitch. Shipping a layout for it
  would be shipping a coin toss onto adhesive paper.

**5160 is the *role* equivalent of L7160, not a geometric one** — different page, different
label, different count. They cannot share a layout, and the type makes that impossible to try.

### Decisions the criteria did not name

**Nothing is scaled and the page is exactly the sheet.** Avery's own PDF template sets media,
crop, bleed and trim boxes all to the full page, because the label geometry is absolute on the
physical stock. The dialog says to print at 100% and not fit-to-page, because the user is the
only one who can prevent a printer from scaling — and a scaled page puts every label over its
die-cut.

**Ink stays 2mm clear of the die-cut edge.** Sheet-feed registration drifts by more than any
arithmetic here can account for.

**Text is truncated with an ellipsis; the pairing code is shrunk instead.** `pdf-lib` neither
wraps nor clips — it draws straight past the edge onto the next label. For a name, truncating
is the only readable option. For a pairing code it is not: half a code is useless where a small
one is merely hard to read, so the code is drawn at whatever size fits.

**A nonsense start position is clamped, not refused.** It arrives from a number input, where a
stray keystroke is far likelier than an intention, and the harm of clamping is one misplaced
sheet against an export that will not run.

### What the probe found

5/7 — and one of the two survivors was **my own bad mutation**, a "per-sheet offset" that was
textually identical to the original. Replaced with a real alternative-implementation bug
(choosing the sheet before applying the offset), which the tests do catch.

The other survivor was a genuine finding: the `subjects.length === 0` early return was **dead
code**. An empty list produces no pages through the loop anyway. Removed, and the test that
covers it now rests on the behaviour rather than on a branch that could not fail. 6/6 after.
