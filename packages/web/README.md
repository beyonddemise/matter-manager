# @matter-manager/web

The Lit + Web Awesome single-page application, built with Vite and deployed to Cloudflare
Pages.

**Created in M2.**

## What belongs here

- Lit components and the router
- `@lit/localize` setup and the `en`/`de` XLIFF catalogues
- The PWA service worker (`vite-plugin-pwa`)
- QR scanning (`BarcodeDetector` with a `@zxing/browser` fallback) and QR rendering
- PDF generation with `pdf-lib` (M3) — client-side, so it works with no connectivity

## House rules

- **Every user-visible string goes through `msg()`.** From the first component, before any
  German translation exists. Retrofitting i18n is never quite finished.
- Components render and handle input. Decisions belong in `core`; persistence in `data`.
- Must work at phone, tablet and desktop widths. The scan-and-file flow is used one-handed,
  standing in front of a device, which is the case to design for first.

## Web Awesome

Licensing and component maturity must be confirmed as the first task of M2. The components
are Lit-based, so a swap is contained if it proves necessary.

## Dependencies and workers

Runtime dependencies are allowlisted in `dependency-policy.json` and enforced by
`npm run check:deps` ([ADR 0013](../../docs/adr/0013-minimal-runtime-dependencies.md)). Use
`fetch`, `crypto.randomUUID()`, `structuredClone` and `Intl` before reaching for a package.

`@zxing/browser` must be **lazily loaded**, only when `BarcodeDetector` is missing. Browsers
with the native API should never download it.

**The service worker is hand-written.** Precache the shell, cache-first for hashed assets,
and never intercept API or replication requests. A service worker sits in front of every
request and outlives the page that installed it, which makes it the last place to want
generated code nobody has read.

**Web workers** are for the QR decode loop (only on the ZXing fallback path) and large PDF
generation. Measure before adding one — a worker's message-passing is not free, and the
native detector is already off-thread.
