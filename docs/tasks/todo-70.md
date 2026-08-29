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

**Every theme is offered; only `glossy` keeps its real fonts.** Nine of the eleven themes
`@import` their own webfonts from `fonts.bunny.net` — roughly 24 families across the set. #106
removed every third-party request and added `probe:runtime` to keep it that way, so those imports
are stripped like glossy's was, and the other themes fall back to the platform's stack. They still
differ in colour, radius, spacing and shadow. Themes whose identity is partly their typeface
(`playful`, `premium`, `brutalist`) lose some of it; that is the accepted cost of not committing
1.2 MB of woff2 for fonts almost nobody will select.

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

Not by rendering a button and reaching into shadow DOM. The tokens are the thing every component
reads, so a probe element carrying `color: var(--wa-color-brand-on-loud)` and
`background-color: var(--wa-color-brand-fill-loud)` gives resolved `rgb()` for both halves —
`color-mix()` and all — and the ratio follows from WCAG's own formula.

Three pairs, chosen because each is a different kind of failure:

| Pair | Why |
| --- | --- |
| `text-normal` on `surface-default` | Body text. The one that affects every screen. |
| `brand-on-loud` on `brand-fill-loud` | The primary button — the failure #70 actually observed. |
| `danger-on-loud` on `danger-fill-loud` | The delete confirmation, where a misread is expensive. |

## Tasks

- [ ] Strip theme font imports in dev as well as build
- [ ] Measure contrast across all 220 combinations and record what fails
- [ ] `theme.ts` — offered sets, the blocklist, class application, persisted preference
- [ ] Lazy-load theme and palette stylesheets, listed explicitly rather than interpolated
- [ ] Theme and palette pickers in Settings, beside the language
- [ ] A test that the blocklist is neither too small nor too large: every offered combination
      passes AA, and every blocked one actually fails
- [ ] German for every new string

## Review
