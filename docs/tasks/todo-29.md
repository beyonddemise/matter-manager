# Todo — #29 · M2b-2 ZXing fallback where BarcodeDetector is missing

Branch: `29-zxing-fallback` (stacked on `28-scan-native-detector`)

## Acceptance criteria (from the issue)

```gherkin
Scenario: a browser without BarcodeDetector still scans
  Given iOS Safari, which does not implement BarcodeDetector
  Then the ZXing fallback decodes it
  And the behaviour is indistinguishable from the native path

Scenario: browsers with the native API never download the fallback
  Then @zxing/browser is not requested
```

> **This is a certainty, not a risk.** iOS Safari has no `BarcodeDetector`, so without this
> issue the product does not work on iPhones.

The reach is wider than the issue says. Verified against MDN's compat data: `BarcodeDetector`
is absent from **Firefox everywhere, Chrome and Edge on Windows and Linux, and Safari on both
platforms** (behind a disabled-by-default preference). Chrome ships it on Android, ChromeOS and
macOS. So the fallback is not the exception — it is the path most desktop users take, and the
only path on iPhone.

## Shape

M2b-1 left the seam this needs. What differs between the two paths is **only how a frame is
read**, not how the camera is opened, released, or how failures are reported. So the split is a
`Detector`, chosen once, rather than two `ScanSource`s that would duplicate the camera half —
and duplicating it is how the two paths would stop being indistinguishable.

The second scenario is the one that keeps this honest, and it is a *decision*, not a bundling
accident: `chooseDetector` must not call the loader at all when the native API is present.

## Plan

- [x] `Detector` — one method, `read(source)`, accepting a canvas as well as a video so the
      ZXing path can be tested against a genuinely rendered QR code
- [x] `nativeDetector()` — the platform's, or `undefined`
- [x] `zxingDetector(load)` — dynamic `import('@zxing/browser')`, injectable
- [x] `chooseDetector(native, zxing)` — native wins; the loader is untouched when it does
- [x] `cameraSource` composes rather than branches
- [x] `@zxing/browser` moves from `devDependencies` to `dependencies` in `packages/web`, and
      out of `allowedDev` in the dependency policy — which already anticipated this move
- [x] `scripts/check-lazy-fallback.mjs` — the bundling half of scenario 2, which no unit test
      can reach

### Tests (each observed failing first)
- [x] the ZXing detector reads a real rendered QR back to its payload, on Linux CI
- [x] the loader is never called when the native API is present
- [x] the loader is called when it is not, and its detector is used
- [x] the decoder is not in the bundle every visitor downloads — checked against the real
      built output, and the checker itself watched failing against a deliberately eager build

## Not doing: a web worker

The issue says to consider one and to measure first. The read loop is serial and throttled to
one frame every 120ms, so a decode has 120ms of headroom before it delays anything, and the
loop cannot queue up behind itself. Adding a worker now would cost message-passing and frame
serialisation to solve a problem not yet observed — and the issue's own advice is not to.

## Review

**Both scenarios met**, and the second one needed two different kinds of check.

### "Never downloads the fallback" is two claims, not one

A unit test can prove the **decision** — that `chooseDetector` does not so much as call the
loader when the platform has its own detector — and one does. It cannot prove the **bundling**:
a bundler that inlined the dynamic import would satisfy that test exactly. Only the built
output can answer that, so `scripts/check-lazy-fallback.mjs` reads the built output, and CI now
builds the site so it can.

The first version of that checker **reported a failure that was not one**. It looked for
`BrowserQRCodeReader`, which the entry chunk legitimately contains — the code destructures it
out of the dynamic import, so the name sits directly beside the `import()` that proves it is
lazy. A marker appearing at the call site cannot tell "the library is here" from "the library
is referred to here". It now looks for names from inside `@zxing/library` that this repository
never mentions, and follows *static* imports transitively rather than matching text.

Then the checker was **watched failing**: the import was temporarily made static, the site
rebuilt, and the check reported the entry chunk. Reverted, rebuilt, green. A checker nobody has
seen fail is a checker nobody knows works — and this one had already produced one false verdict.

### The split is a detector, not a source

What differs between the two paths is only how a frame is read. Opening the camera, releasing
it, and the four failure messages do not vary — so `ScanSource` stayed single and the decode
was extracted. Two `ScanSource` implementations would have duplicated the camera half, and
duplicating it is exactly how the two paths would stop being "indistinguishable".

`Detector.read` takes a canvas as well as a video. That is what makes the fallback testable at
all: CI has no camera **and** no `BarcodeDetector`, so the test renders a real `<wa-qr-code>`,
copies its pixels, and checks ZXing reads the payload back out.

### Numbers worth recording

The entry bundle is 511kB; the ZXing chunk is 436kB in its own file. Shipping it eagerly would
have been the single largest thing in the download, for a decoder most visitors' browsers make
unnecessary — and every one of them would have paid for it silently.

### Not doing: a web worker

The issue says to consider one and to measure first. The read loop is serial and throttled to
one frame every 120ms, so a decode has 120ms of headroom before it delays anything and cannot
queue up behind itself. A worker would cost message-passing and frame serialisation to solve a
problem not yet observed.
