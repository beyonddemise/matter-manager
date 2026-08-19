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
