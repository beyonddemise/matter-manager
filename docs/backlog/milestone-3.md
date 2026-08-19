# M3 — PDF export

**Goal:** a printable record you can file with the house documents or hand to a homeowner.
Generated entirely in the browser, so it works in a basement
([ADR 0007](../adr/0007-client-side-pdf.md)).

---

## M3-1 · Export an inventory PDF

`type:story` `area:pdf` `size:L`

**Story:** as a homeowner, I want a printable list of every device with its QR code, so the
codes survive independently of any app, account or company.

```gherkin
Scenario: an inventory is generated
  When I export the project
  Then a PDF is produced containing every enabled device
  And devices are grouped under their room path
  And each entry shows name, room, product, installation date, QR code and manual code

Scenario: the printed QR actually scans
  When a generated PDF is printed at normal size
  Then the QR codes are scannable by a phone

Scenario: it works offline
  Given no connectivity
  Then export succeeds
```

**Out of scope:** custom branding (M8), selection (M3-2), label sheets (M3-3).

**The scannability scenario needs manual verification at least once per layout change.** A
QR that renders correctly on screen but prints too small or too low-contrast is a defect
that only physical testing finds — and it defeats the purpose of the entire feature.

---

## M3-2 · Export a selection

`type:story` `area:pdf` `size:M`

```gherkin
Scenario: selected devices are exported
  When I select devices and export
  Then only those appear

Scenario: a room is exported
  When I export a room
  Then devices in that room and its sub-rooms are included

Scenario: disabled devices are opt-in
  Then disabled devices are excluded unless explicitly included
```

---

## M3-3 · Label sheet layout

`type:story` `area:pdf` `size:M`

**Story:** as an installer, I want adhesive labels I can stick inside a fuse box or on a
device, so the code is with the hardware rather than in a drawer.

```gherkin
Scenario: labels are laid out on a standard sheet
  When I export as labels
  Then QR codes are arranged on a grid matching a common label stock
  And each label shows the QR, device name and room
  And label boundaries align with the physical sheet when printed at 100%

Scenario: a starting position can be chosen
  Given a partly-used label sheet
  When I choose to start at row 2, column 3
  Then the first label is placed there
```

**That last scenario is small and disproportionately appreciated.** Nobody wants to waste
most of a label sheet to print four labels.

---

## M3-4 · German characters render correctly

`type:story` `area:pdf` `area:i18n` `size:S`

```gherkin
Scenario: umlauts and eszett render
  Given a room named "Küche" and a device named "Außenbeleuchtung"
  When a PDF is generated
  Then all characters render correctly
  And text extracted from the PDF matches the original strings
```

**Why this is its own issue:** German is a launch language, and PDF font handling is exactly
where non-ASCII silently becomes boxes or blanks. Extracting text back out is the assertion
that can be automated; visual inspection catches the rest.

---

## M3-5 · Large exports stay responsive

`type:story` `area:pdf` `size:M`

```gherkin
Scenario: a large project exports without freezing the UI
  Given a project with 500 devices
  When exporting
  Then progress is shown
  And the interface remains responsive
  And the export can be cancelled
```

**Approach:** measure first. If generation on the main thread is acceptable at realistic
sizes, do nothing. A web worker is the fix if measurement says so, not a precaution taken in
advance.

---

## M3-6 · Print stylesheet

`type:story` `area:web` `size:S`

```gherkin
Scenario: the device list prints sensibly
  When the device list is printed directly from the browser
  Then navigation and controls are omitted
  And content is not clipped at page boundaries
```

Cheap, and covers the user who reaches for Ctrl+P before finding the export button.
