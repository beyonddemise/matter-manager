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

- [x] Red: `scripts/check-offline-assets.mjs` fails against the current `dist`
- [x] `scripts/fetch-offline-assets.mjs` — downloads fonts and icons, emits the local
      `@font-face` CSS with Bunny's own `unicode-range` values preserved
- [x] Vendor the 12 woff2 files and the 22 icon SVGs, with their licences
- [x] A Vite plugin that strips the external `@import` and **fails if it is not there**, so a
      Web Awesome update that renames it is loud rather than silent
- [x] `registerIconLibrary('default', …)` resolving to bundled assets
- [x] `_headers`: `style-src`, `font-src` and `connect-src` lose the third-party origins
- [x] `check-offline-assets` in `npm run verify` and in CI
- [x] Re-run the network probe: zero cross-origin requests

## Review

**Done.** `npm run verify` clean, 2058 tests pass, and the measurement that found the bug now
reports `external requests: 0`.

### Two things the work turned up that the issue did not know about

**The icons the CDN serves are Font Awesome _Pro_.** Every SVG comes back stamped
`Font Awesome Pro 7.3.0 ... (Commercial License)`, from an endpoint that asks for no credential.
This repository is public, so committing them would have been redistributing Pro assets. The
icons are therefore taken from `@fortawesome/fontawesome-free` (CC BY 4.0) as a **devDependency**
— which also makes the script reproducible, since it no longer needs the network for icons.

**Two icons have never rendered.** `camera-slash` and `cloud-slash` are Pro-only and return
**403** from the endpoint Web Awesome actually uses — confirmed, including with a `Referer` of
the deployed origin, and no kit code is configured anywhere. They are the camera-failure callout
and the offline indicator: both failure states, which is why nobody noticed. Filed as #132 and
replaced here with `video-slash` and `plug-circle-xmark`.

### Why there are two checks rather than one

They fail on different things, and this issue needed both.

`check-offline-assets.mjs` reads the built files. In CSS a URL **is** a fetch, so any absolute
URL there is a finding with no allowlist — that catches the font class exactly. JavaScript cannot
be read that way: a bundle contains the strings of code paths it never takes, and Web Awesome
ships Font Awesome's CDN template whether or not the icon library is overridden. So JS gets an
allowlist with a written reason per origin, in the manner of `dependency-policy.json`.

An allowlist entry is a promise, not a proof. `probe-runtime-requests.mjs` is the proof: it
serves `dist` under the **real `_headers` policy** and fails on any request that leaves the
origin, or on any CSP violation. That second half matters independently — a policy that has
drifted from what the application needs is invisible until it reaches a user, because locally
nothing enforces it.

### Notes

- **The icons became `data:` URLs.** Each SVG is under Vite's inline limit, so they are inlined
  rather than emitted as files. That is better than intended: an icon now costs no request at
  all. `connect-src data:` in `_headers` is what allows `<wa-icon>` to fetch them, and it was
  already there.
- **The fonts land in `/assets/`**, which the service worker already serves cache-first, so they
  survive offline from the first visit without the worker changing.
- **Biome now skips `src/fonts` and `src/icons/svg`**, alongside `src/generated`. It was
  reporting `a11y/noSvgWithoutTitle` against vendored icon files. The rule is right in general
  and wrong here: `<wa-icon>` carries the accessible name through its own `label`, and these are
  copied assets rather than authored markup.
- **Italics are not bundled.** No italic face has ever been requested and nothing renders one; a
  synthesised oblique is the fallback if that changes.
- **`fraunces` is bundled but appears unused.** It is the theme's `longform` family, and nothing
  in this application sets that. Kept because the theme declares it and a missing family is a
  silent substitution rather than an error - but worth revisiting if #70 makes themes selectable.
