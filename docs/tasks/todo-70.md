# todo-70 — Theme switcher: let the user choose theme and palette

Closes #70.

M2-2 fixed the look at `wa-theme-glossy wa-palette-anodized` with a light/dark toggle. This makes
the other two axes the user's as well.

## What the look actually is

Two class names on `<html>`, plus the scheme:

```html
<html class="wa-theme-glossy wa-palette-anodized wa-light">
```

Web Awesome Pro ships **11 themes and 10 palettes**. Every component reads from the same `--wa-*`
tokens, so switching is a class swap plus that theme's stylesheet — provided M2-2's rule holds and
no component ever hardcodes a colour, radius or font size.

## Decisions taken

**Only `glossy` keeps its real fonts.** Nine of the eleven themes `@import` their own webfonts
from `fonts.bunny.net`. #106 removed every third-party request and added `probe:runtime` to keep
it that way, so those imports are stripped like glossy's was and the other themes fall back to the
platform's stack.

Self-hosting them all was tried and abandoned on the evidence. The estimate was ~1.2 MB; the
actual download is **4.3 MB in 308 files**, because these families ship cyrillic, greek,
vietnamese, hebrew, maths and symbol subsets on top of latin. The user's download would have been
unchanged — `unicode-range` means a German reader fetches latin and nothing else — so the whole
4.3 MB was repository weight for typography almost nobody would select. Measuring before
committing is the only reason that was a decision rather than a surprise.

Themes whose identity is partly their typeface (`playful`, `premium`, `brutalist`) lose some of
it. That is the accepted cost.

**Contrast is measured, and a failing combination is not offered.** #70 records that `premium`
rendered a pale brand button with a low-contrast label, and `matter` did the same in dark mode.
With 11 × 10 × 2 = **220** combinations, "check it looks right" is not a thing anybody will do
twice, so it is a test.

## The stripper now runs in dev too

`vite.config.ts` had `apply: 'build'`, so `npm run dev` still fetched fonts from Bunny while a
build did not — dev and production disagreeing about typography, in the one area this issue
multiplies by nine. The transform now runs in both; only the "it stripped nothing" assertion is
build-only, which is what `apply: 'build'` was really protecting.

## Measuring contrast

Not by rendering a button and reaching into shadow DOM. The tokens are what every component
reads, so a probe element carrying `color: var(--wa-color-brand-on-loud)` and
`background-color: var(--wa-color-brand-fill-loud)` gets both halves resolved to `rgb()` —
`color-mix()` and all — and the ratio follows from WCAG's formula.

**Ten token pairs, not three.** The first attempt checked only the `loud` fills and reported all
clear. #70 describes a *pale* fill, and `loud` is the saturated one — so the pairs that would show
the reported defect were the ones not being measured. Adding the `normal` and `quiet` fills, plus
quiet text, turned "nothing fails" into ninety failures.

### What it found

2200 measurements. Ninety fail, in **three themes**, in **light only**, and the palette makes no
difference to any of them:

| Theme | Pair | Ratio |
| --- | --- | --- |
| `tailspin` | quiet brand / danger / warning / success fills | 2.98 – 2.99 |
| `shoelace` | the same four | 4.09 – 4.15 |
| `brutalist` | the normal neutral fill | 4.29 |

Because they are palette-independent and light-only — and the scheme is a control the user sets
separately — the exclusion can only be of the whole theme. Eight themes × ten palettes remain.

**The issue's own suspects were wrong.** #70 named `premium` and `matter`, from a comparison made
at M2-2. Both now pass every pair in both schemes. The measurement disagreed with the issue, and
the measurement is what was acted on.

### The control matters more than the assertion

The first version of the probe globbed the stylesheets from a path that matched nothing, so every
token resolved to its initial value and all 2200 checks "failed" identically. The mirror image of
that mistake — colours resolving to something that happens to pass — would have reported all clear
and been believed. So the suite asserts that a known pair resolves to real colours with a high
ratio, and that the formula gives 21 for black on white and 1 for white on white, before it
asserts anything about themes.

## Tasks

- [x] Strip theme font imports in dev as well as build
- [x] Measure contrast across all 220 combinations and record what fails
- [x] `theme.ts` — offered sets, the blocklist, class application, persisted preference
- [x] Lazy-load theme and palette stylesheets, listed explicitly rather than interpolated
- [x] Theme and palette pickers in Settings, beside the language
- [x] A test that the blocklist is neither too small nor too large: every offered combination
      passes AA, and every blocked one actually fails
- [x] German for every new string

## Review

**Done.** `npm run verify` clean, 2102 tests pass, `check:offline` and `probe:runtime` still ok.

### Two measurements changed the design

**The contrast probe was wrong twice before it was right.** First it globbed stylesheets from a
path that matched nothing, so every token resolved to its initial value and all 2200 checks
"failed" identically. Fixed, it reported *zero* failures — which was also wrong, because it was
only measuring the `loud` fills while #70 describes a **pale** one. Adding the `normal` and
`quiet` pairs turned "nothing fails" into ninety failures in three themes.

Both errors were invisible from the result alone. That is why the suite now asserts its own
control first: real colours, a ratio above 10 for a pair known to be high contrast, and 21 and 1
for the two ends of the formula.

**Self-hosting every theme's fonts was tried and abandoned on the numbers.** The estimate was
1.2 MB; the actual download is 4.3 MB in 308 files, because these families ship cyrillic, greek,
vietnamese, hebrew, maths and symbol subsets. The user's download would have been identical
either way — `unicode-range` sees to that — so the whole difference was repository weight for
typography almost nobody would select.

### Lazy loading is real, and verified

The entry stylesheet is 144 kB and contains `glossy` only; `playful`, `mellow`, `premium` and
`matter` appear in none of it and are separate chunks. The three withheld themes are in the built
output **nowhere at all**, so excluding them costs nothing rather than shipping bytes for a
choice the interface will not offer.

`index.html` still hard-codes the default pair, so the first paint is styled rather than bare. A
reader who has chosen something else sees one frame of the default — the same trade `scheme.ts`
already documents, and for the same reason: the alternative is blocking the document on storage
and a stylesheet.

### The order of the two lines matters

`loadLook` is awaited **before** `applyLook`. The other order puts a class on the document naming
a theme nothing defines yet, which renders as Web Awesome's bare defaults until the fetch lands —
a flash of unstyled application, and on the settings screen specifically, where somebody is
looking at how the application is styled.

### The stripper now runs in development

It was `apply: 'build'`, so `npm run dev` fetched fonts from Bunny while a build did not. That was
tolerable with one theme; with eight selectable and seven falling back to the platform stack in
production, a developer would have been looking at fonts no user ever sees. Only the
"it stripped nothing" assertion is build-only now, which is what that flag was really protecting.
