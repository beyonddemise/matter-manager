# 7. Generate PDFs in the browser

Date: 2026-08-19

## Status

Accepted

## Context

Users export a PDF of some or all devices, with QR codes, to file with the house documents
or hand to a homeowner.

Server-side generation is the conventional choice: better typography, easier fonts, a
single implementation.

But it contradicts the product. The person who most needs a printed sheet is standing in a
building holding a phone, often with no connectivity — the same situation that motivates
offline-first everywhere else. A PDF export that requires a server is an export that fails
exactly when it is wanted.

It would also mean the server needs the payloads in order to render the QR codes, putting
commissioning secrets on the wire for a purely presentational operation.

## Decision

Generate PDFs in the browser with `pdf-lib`, rendering QR codes locally.

Two layouts: a label sheet (a grid sized for adhesive label stock) and an inventory
document (a table grouped by room path). Both print the numeric manual pairing code
alongside each QR, because a phone camera cannot always focus on a small printed code.

## Consequences

- Export works offline, which is when it is needed.
- Payloads never leave the client for rendering purposes.
- No server-side rendering infrastructure, no headless browser, no font pipeline on the
  droplet.
- Typography is more limited than a server-side toolchain. Acceptable — this is an
  inventory sheet, not a brochure.
- **Fonts must be embedded deliberately.** German is a launch language, so umlauts and ß
  must be verified in the output rather than assumed. This is a test case, not a hope.
- **The QR reaches the PDF as a raster image.** `<wa-qr-code>` renders to a canvas and its
  encoder is bundled inside the component rather than separately importable (checked against
  `@awesome.me/webawesome-pro@3.11.0`), so the route is: render off-screen at high resolution,
  `canvas.toDataURL()`, embed the PNG. Render resolution is therefore a *correctness* concern,
  not a cosmetic one — a QR that prints marginally is the one failure this feature cannot
  survive. If paper testing shows raster is not good enough, the fallback is drawing modules
  as vector rectangles, which needs a QR matrix and so an encoder we can call directly.
- Large exports do real work on the main thread. If a project of several hundred devices
  makes the UI janky, move generation to a web worker — but measure first rather than
  assuming.
