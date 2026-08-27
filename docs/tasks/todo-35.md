# Todo — #35 · M3-4 German characters render correctly

Branch: `35-pdf-german` (stacked on `34-label-sheets`)

## Acceptance criteria (from the issue)

```gherkin
Scenario: umlauts and eszett render
  Given a room named "Küche" and a device named "Außenbeleuchtung"
  Then all characters render correctly
  And text extracted from the PDF matches the original strings
```

> **Why this is its own issue:** German is a launch language, and PDF font handling is exactly
> where non-ASCII silently becomes boxes or blanks.

## Review

**The scenario passes, and looking for it found something worse than boxes or blanks.**

### German works, and is now proved rather than assumed

`Küche` and `Außenbeleuchtung` are extracted back out of a generated PDF and compared with the
strings that went in. Standard-14 fonts are WinAnsi-encoded, which covers every character
German needs — but "covers it" was an assumption until something read the bytes back.

The extractor is hand-rolled and lives in `test/`. A general PDF text extractor is a large
problem; this one reads only documents this repository writes, and adding a PDF parsing library
as a devDependency of a package that ships a bundle is a dependency-policy conversation
(ADR 0013) for a forty-line job.

**It has a positive control, and the control earned its place twice.** Every other assertion is
"the extracted text contains X", so an extractor that found nothing would fail them all —
loudly, but looking exactly like a German rendering defect. The control fails first and says
what is actually wrong. It did: the first version found no text at all, because
`DecompressionStream` **rejects trailing bytes** rather than ignoring them, and the PDF
specification writes an end-of-line before `endstream`. Every stream in the file read as "not
compressed" and the extractor returned an empty array while appearing to work.

### The defect this issue was really guarding

A character WinAnsi cannot encode does not render as a box. **`pdf-lib` throws, and the entire
export fails**: `WinAnsi cannot encode "Ł" (0x0141)`. One Polish room name in a house otherwise
named in German loses an inventory of two hundred devices, and the error message is about a
font encoding.

The application is not German-only — rooms and devices are named by whoever owns the house, and
`Łazienka`, `Кухня` or `Kitchen 💡` is one keystroke away. So `winAnsiSafe` now guards every
string that reaches the page:

- **already representable** → unchanged, which is every English and German string
- **an accent that decomposes** → the letter without it. `světlo` becomes `svetlo`, which is
  readable; `sv?tlo` is not.
- **a letter whose accent does not decompose** → a small table. `Ł` is not `L` plus a mark as
  far as Unicode is concerned, and `?azienka` is not a room anyone can find.
- **no Latin form at all** → a visible `?`. A silent deletion produces a shorter name that
  looks deliberate.

**It does not romanise.** Transliterating Cyrillic or Greek is a linguistic decision with
several defensible answers, and guessing at one produces a document that looks authoritative
and is wrong.

The pairing code is unaffected in every case — digits are ASCII — which is what makes a degraded
entry still a usable one. There is a test for exactly that.

**This is a stopgap and says so.** Embedding a Unicode font makes all of it unnecessary and
costs about a megabyte in an application that is deliberately small and works offline. That
trade-off belongs with M8, not smuggled in here.

### Tests

- [x] the extractor finds text at all (positive control)
- [x] `Außenbeleuchtung` and `Erdgeschoss/Küche` round-trip exactly
- [x] every character German uses, including capitals and an em dash
- [x] the interface's own labels — a page footer is as much a place to fail as a device name
- [x] the string is byte-identical, not merely recognisable (an NFC/NFD swap would render the
      same and not be what the user typed)
- [x] Polish, Czech, Cyrillic, Greek and an emoji each **produce a document** rather than an
      exception
- [x] 7/7 mutations caught on the guard, including "unrepresentable dropped silently" and
      "iterated by index rather than code point" — the latter splits an emoji into two lone
      surrogates and doubles the damage
