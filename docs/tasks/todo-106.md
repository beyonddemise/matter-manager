# todo-106 — Icons and fonts come from third-party CDNs

Closes #106.

## Measured, not assumed

`packages/web/dist` was served and loaded in Chromium with every request recorded. Twelve
cross-origin requests, on a first visit, with no interaction beyond opening two screens:

```
https://fonts.bunny.net/css?family=chivo-mono:…|figtree:…|fraunces:…&display=swap
https://fonts.bunny.net/figtree/files/figtree-latin-{400,600,800}-normal.woff2
https://ka-f.fontawesome.com/releases/v7.3.0/svgs/solid/{bars,circle-half-stroke,circle-info,
  file-pdf,gear,lightbulb,plus,tags}.svg
```

For an offline-first application (ADR 0002) that is the interface failing in exactly the
situation the product exists for. The service worker cannot help: it never sees those URLs on a
first visit.

## Where they come from

- **Fonts** — `@awesome.me/webawesome-pro/dist/styles/themes/glossy.css` line 3 `@import`s
  `fonts.bunny.net`. Vite leaves an external `@import` in place, so it survives into the built
  CSS verbatim.
- **Icons** — `<wa-icon>`'s default library resolves to
  `ka-f.fontawesome.com/releases/v7.3.0/svgs/${folder}/${name}.svg`, fetched the first time each
  icon renders.

## Decisions

**Vendor the font files rather than add a package.** All twelve are **144 KB** together, they
are the exact files the browser fetches today, and ADR 0013 asks for the platform over a
dependency. `@fontsource/*` would be three runtime dependencies for data that never changes.

**Only the weights the theme resolves to.** `glossy.css` names 350, 400, 600 and 800; CSS font
matching sends 350 to the 300 file. So Figtree needs 300/400/600/800, Chivo Mono 400 (code) and
Fraunces 300 (longform), each in `latin` and `latin-ext`. The `@import` requests all nine weights
and both styles for all three families — 108 combinations — of which the browser has ever been
observed to fetch three.

**`latin-ext` is included even though nothing observed needs it.** Device and room names are
whatever the user types, and a missing subset is a silently wrong glyph rather than an error.

**Italics are not vendored.** No italic face was ever requested, and nothing in the application
renders one. A synthesised oblique is the fallback if that changes; noted rather than guessed at.

## Tasks

- [ ] Red: `scripts/check-offline-assets.mjs` fails against the current `dist`
- [ ] `scripts/fetch-offline-assets.mjs` — downloads fonts and icons, emits the local
      `@font-face` CSS with Bunny's own `unicode-range` values preserved
- [ ] Vendor the 12 woff2 files and the 22 icon SVGs, with their licences
- [ ] A Vite plugin that strips the external `@import` and **fails if it is not there**, so a
      Web Awesome update that renames it is loud rather than silent
- [ ] `registerIconLibrary('default', …)` resolving to bundled assets
- [ ] `_headers`: `style-src`, `font-src` and `connect-src` lose the third-party origins
- [ ] `check-offline-assets` in `npm run verify` and in CI
- [ ] Re-run the network probe: zero cross-origin requests

## Review
