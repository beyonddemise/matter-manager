# Todo — #37 · M3-6 Print stylesheet

Branch: `37-print-stylesheet` (stacked on `36-large-exports`)

## Acceptance criteria (from the issue)

```gherkin
Scenario: the device list prints sensibly
  When the device list is printed directly from the browser
  Then navigation and controls are omitted
  And content is not clipped at page boundaries
```

> Cheap, and covers the user who reaches for Ctrl+P before finding the export button.

## Review

**Both criteria met, and the "cheap" part was true of the stylesheet and not of the test.**

This is deliberately *not* a second implementation of the PDF. The PDF is the considered
artefact with QR codes on it; this is a courtesy so that the obvious gesture produces something
usable rather than a screenshot of an application.

### The test is emulated print media, not CSS text

A test that read the stylesheet and asserted "there is a rule hiding the navigation" would pass
against a rule with a typo in its selector, one lost to specificity, or one inside a media query
that never matches — which is every way a print stylesheet actually fails. So the browser is put
into print media through CDP and the assertions are on **computed styles**, which answers the
only question that matters: what would come out of the printer.

**With a positive control**, because every assertion is of the form "this is hidden when
printing" and every one of them would also pass if the emulation silently did nothing and the
element simply was not there. The control asserts `matchMedia('print').matches`.

### Two things the tests found

**The stylesheet was brute-forcing what this codebase does with tokens.** The first version had
fourteen `!important` declarations, including a `* { background: transparent !important }`.
Biome said so. Retinting the `--wa-*` tokens inside the media block does the same job properly —
and does it *better*, because custom properties inherit through a shadow boundary where ordinary
declarations do not, so components we cannot write selectors for follow along. Six `!important`
remain, in two places that earn them: `<wa-page>`'s fixed layout, which lives in its own shadow
root, and the QR's white quiet zone, which must survive any palette because a code printed as
dark modules on nothing does not scan.

**One test was unrepresentative and said so by failing.** It never imported the Web Awesome
theme, so `--wa-border-width-s` was undefined, the declaration using it was dropped, and the
computed style read as though the rule were missing. Importing the theme the way `main.ts` does
makes the test a test of the real page — and that failure mode is worth naming, because it
reports a stylesheet bug that does not exist while hiding one that does.

### The scrolling-container bug, guarded before it happened

`<wa-page>` is a fixed application frame. Printed as one, it produces a single page containing
whatever happened to be in the viewport — the classic "only the first page prints" complaint,
which is not a clipping problem but a scrolling-container one, and which no amount of
`break-inside` fixes. There is a test asserting the page is `static` and `visible` when printing.
