# Matter QR code rules

The rules a Matter onboarding QR code follows, and how this application meets them. Collected so
that changes to `frontend/src/ui/qr/` start from the requirements rather than from the code.

The Connectivity Standards Alliance (CSA) sets the format, size, data structure and placement of
Matter QR codes. The rules exist so that any compliant smart home app (Apple Home, Google Home,
Home Assistant and others) can scan and understand a device's payload reliably. [1, 2]

> **Normative source.** The rules below are a secondary summary. Where it differs from the Matter
> Core Specification, the specification wins. Those points are marked **Spec note** and quote
> R1.4 (CSA document 23-27349, November 2024), §5.1.3. The specification is linked as [S].

## 1. Data encoding

- **The `MT:` prefix.** Every Matter QR code string starts with the upper-case letters `MT:`. A
  scanner that reads a code without this exact prefix does not recognise it as a Matter device. [1]
- **Base-38 encoding.** The binary payload is converted to text with Base-38. This keeps the data
  dense within the characters a QR code's alphanumeric mode allows: `0-9`, `A-Z`, space, `$`, `%`,
  `*`, `+`, `-`, `.`, `/` and `:`. [1]
  - **Spec note.** The Base-38 alphabet itself is narrower: `0-9`, `A-Z`, `-` and `.`. The longer
    list is the QR alphanumeric character set, which also has to carry the `:` of the prefix.
- **Alphanumeric mode is mandatory.**
  - **Spec note.** §5.1.3.2: "The QR code generated, as defined in ISO/IEC 18004:2015, SHALL be of
    Version 1 or higher, using alphanumeric encoding." A byte-mode code scans, but it does not
    conform. That is why `<wa-qr-code>` was replaced (ADR 0018).

## 2. Print quality and error correction

- **Error-correction level.** Matter QR codes use Reed-Solomon error correction at level M (Medium)
  or higher. A partly scratched, smudged or obscured sticker can then still be decoded: level M
  recovers about 15% damage. [3, 4, 5]
  - **Spec note.** The specification says **SHOULD**, not SHALL: "The QR code SHOULD employ level
    M or higher ECC." Level L is allowed where it avoids moving to a larger version. Version, level,
    size and colour are otherwise the manufacturer's choice.
  - This application uses **M**, the level real labels print. A different level is a different
    pattern, and the code on screen must match the label.
- **No colour inversion.** Keep the contrast high: dark modules on a light background. Inverted
  codes (light modules on a dark surface) are strongly discouraged, because many phone cameras fail
  to decode them quickly. [6]
  - This application renders literal black on white whatever the colour scheme. A test decodes the
    code with the dark scheme switched on.

## 3. Visual layout

- **The quiet zone.** A printed QR code needs a continuous blank border on all four sides, at least
  four modules wide, so that nearby packaging text or device seams cannot confuse the scanner.
  - **Spec note.** The four-module quiet zone comes from ISO/IEC 18004, which the Matter
    specification references. It is not a separate Matter rule.
  - **Known gap.** The on-screen plate gives about 2.5 modules at the inline size.
- **Size.** On a physical product, the code must be large enough for a standard phone camera to
  resolve. General QR guidance suggests at least one inch square for print. Small hardware such as
  smart plugs or bulb bases needs high-density precision printing to stay readable at smaller
  sizes. [6]
- **Branding.**
  - **Spec note.** §5.1.2: onboarding material printed on a product or its packaging SHALL follow
    the Matter Brand Guidelines, and other representations (app, display) SHOULD. This covers the
    logo and pairing-code text around the code, not the code itself.

## 4. Multi-device codes (Matter 1.4.1 and later)

Newer specification versions extend the format to cover several devices with one code. [7, 8]

- **Bulk packs.** A manufacturer selling a multi-pack of identical devices, such as four smart
  bulbs, no longer has to print four separate QR codes. [2, 8]
- **One code on the box.** The box can carry a single multi-device QR code. A compatible app
  that scans it commissions all the devices in one onboarding sequence. [2, 8]
- **Spec note.** These codes are not yet handled by this application. The encoder caps payloads at
  255 characters (§5.1.3.2), and the scanner and payload decoder assume one device per code.

## How this application implements the rules

| Rule | Where |
|---|---|
| Alphanumeric mode only, versions 1–13 | `frontend/src/ui/qr/encode.ts` |
| Level M by default | `encodeQr(text, errorCorrection = 'M')` |
| The mask real label tooling picks | `chooseMask`, python-qrcode scoring; see ADR 0018 |
| Black on white, never themed | `frontend/src/ui/qr/render.ts`, `frontend/src/ui/pdf/qr.ts` |
| Matches a real label module for module | `frontend/test/ui/qr/encode.test.ts` |

## Sources

- [S] [Matter 1.4 Core Specification (CSA)](https://csa-iot.org/wp-content/uploads/2024/11/24-27349-006_Matter-1.4-Core-Specification.pdf), §5.1.2–5.1.3
- [1] [How does the Matter QR code work? (Matter Alpha)](https://www.matteralpha.com/explainer/how-does-matter-qr-code-work)
- [2] [Matter 1.4.1: NFC and multi-device setup (The Verge)](https://www.theverge.com/news/662266/matter-spec-update1-4-1-nfc-multi-device-setup)
- [3] [Error correction (qrcode.com)](https://www.qrcode.com/en/about/error_correction.html)
- [4] [QR code error correction (generateonlineqr.com)](https://www.generateonlineqr.com/blog/qr-code-error-correction.php)
- [5] [How does the Matter QR code work? (Matter Alpha)](https://www.matteralpha.com/explainer/how-does-matter-qr-code-work)
- [6] [Video on QR print guidelines (YouTube)](https://www.youtube.com/watch?v=I0N_xbiZut8&t=121)
- [7] [Matter version history (Matter Alpha)](https://www.matteralpha.com/explainer/matter-version-history-every-update-feature-explained)
- [8] [A smarter start: Matter 1.4.1 makes setup easier (CSA)](https://csa-iot.org/newsroom/a-smarter-start-matter-1-4-1-makes-setup-easier/)
- [9] [Lost that pairing code? (r/MatterProtocol)](https://www.reddit.com/r/MatterProtocol/comments/1mpx9hp/lost_that_pairing_code_check_this_first/)
