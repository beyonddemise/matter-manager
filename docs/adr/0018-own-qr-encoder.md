# 18. Our own QR encoder, so the code matches the label

Date: 2026-10-05

## Status

Accepted. Supersedes the QR passages of [ADR 0007](0007-client-side-pdf.md) (QR as a raster
image), [ADR 0008](0008-lit-and-web-awesome.md) ("needs no hand-rolled encoder") and
[ADR 0013](0013-minimal-runtime-dependencies.md) ("QR generation needs nothing at all").
Their other decisions stand.

## Context

ADRs 0008 and 0013 chose `<wa-qr-code>`, which ships with Web Awesome Pro, and called a
hand-rolled encoder "moot". Comparing a reproduced code with a real manufacturer's label
showed three problems:

- **Not conformant.** The Matter Core Specification R1.4 §5.1.3.2 says the code "SHALL"
  use alphanumeric encoding. The component's encoder (`@konnorr/qr-creator`) only does byte
  mode.
- **Not the label.** Byte mode at the level H we requested gives a 29×29 symbol, while the
  label is 25×25 (level M). Fixing mode and level is not enough either. ISO/IEC 18004 leaves
  the mask to a penalty score that encoders compute differently. On the reference label,
  python-qrcode picks mask 5 (identical), Nayuki's qrcodegen picks 3 (221 of 625 modules
  differ) and segno picks 7 (253 differ).
- **Not readable in dark mode.** The component paints its three finder squares in the
  theme's text colour, ignoring `fill`, so in dark mode they turned light grey and zxing
  could not find the code.

0007's planned fallback ("drawing modules as vector rectangles needs an encoder we can call
directly") applied as well.

## Decision

Encode in `frontend/src/ui/qr/encode.ts`:

- **Alphanumeric mode only.** Other characters are refused, never silently encoded in another
  mode.
- **Level M by default.**
- **Versions 1–13.** The spec caps a payload at 255 characters, which fits version 13 even at
  level H.
- **Mask selection reproduces python-qrcode exactly**, including its scoring with the format
  information left blank. That detail is what makes the label match.

**Rendering.**
- The screen gets an inline SVG.
- The PDFs get the same path through pdf-lib's `drawSvgPath`.
- Both use literal black and white.

**Tests.**
- **Real label:** the encoder must equal the real label module for module.
- **Oracle:** it must also match python-qrcode on fixture matrices across versions 1–13 and
  all four levels (`frontend/test/ui/qr/fixtures`).

**Nearly taken: vendoring Nayuki's `qrcodegen.ts`** (MIT, one file). Rejected for three
reasons:
- it picks a different mask, so it does not reproduce labels;
- it fails `noUncheckedIndexedAccess`;
- most of it (byte, kanji, ECI and versions up to 40) is code nothing here needs or tests.

## Consequences

**Gains.**
- Codes conform to the specification and match labels made by python-qrcode-compatible
  tooling.
- Codes are correct in every colour scheme.
- PDF codes are vector, so print resolution is no longer a correctness concern.
- `<wa-qr-code>` is no longer used.

**Costs.**
- About 400 lines of encoder are now ours to maintain. The fixtures and the label test are
  what make that safe.

**Limits.**
- A manufacturer whose tooling scores masks differently gets a code that scans and conforms
  but does not look identical. Capturing the mask from the scanned label would close that gap,
  at the cost of a schema field. It was considered and deferred.
- The rules this follows are collected in [docs/qr-rules.md](../qr-rules.md).
