# Todo — #28 · M2b-1 Scan a QR code with the native detector

Branch: `28-scan-native-detector` (stacked on `27-cloudflare-pages`)

## Acceptance criteria (from the issue)

```gherkin
Scenario: a code is scanned
  Given a browser supporting BarcodeDetector
  When a Matter QR code is in view
  Then the payload is decoded and the add-device form is prefilled

Scenario: a non-Matter code is scanned
  Then the error names what was wrong
  And scanning continues rather than dropping out of the flow

Scenario: camera permission is refused
  Then manual entry is offered with an explanation
  And the app does not appear broken

Scenario: no camera is present
  Then the scan option is absent rather than failing when pressed
```

> Decoding is `core`'s job. This issue is camera plumbing and the failure paths — which are
> most of the work.

## Shape

**The scanner fills the field the form already has.** `add-device.ts` says so in as many
words: "the camera in M2b-1 becomes one more way to fill the same field rather than a second
flow." So this is a dialog on the add form, not a route.

That also settles a question the issue does not raise: a scanned payload **never goes into the
URL**. It is a setup passcode, and a hash fragment lands in browser history. The decoded text
goes from the dialog to the field in a custom event and nowhere else.

**One seam, three implementations.** `ScanSource` is what the view talks to: the real camera,
the fakes the tests drive, and — at M2b-2 (#29) — the ZXing fallback, which becomes a second
implementation rather than a branch inside the view.

## Plan

- [x] Confirm the `getUserMedia` rejection names against the spec rather than recalling them
      (lesson L1). The four failure paths are the deliverable; getting the names wrong makes
      every one of them say "unknown".
- [x] `scan/problem.ts` — pure: a rejection to a reason. Node-tested.
- [x] `scan/source.ts` — the `ScanSource` interface, and the camera implementation.
- [x] `views/scan-dialog.ts` — preview, decode loop, the four messages, and releasing the
      camera on close.
- [x] `views/add-device.ts` — the button, hidden entirely when nothing can scan.
- [x] Strings through `msg()`, German written.

### Tests (each observed failing first)
- [x] a Matter payload in view fills the setup-code field and closes the dialog
- [x] a non-Matter code names what was wrong **and the loop keeps reading**
- [x] a refused permission explains and offers manual entry
- [x] no camera means no button, rather than a button that fails
- [x] the camera is released when the dialog closes — the failure here is a light left on
- [x] every `getUserMedia` rejection name maps to the message it deserves

## Review

**All four scenarios met.** The one addition to the plan is a fifth failure path the issue does
not name and the spec does: a code read from a frame that finished decoding *after* the dialog
closed. Reporting it would fill the setup-code field from a scan the user cancelled.

### Checking the spec changed the code

Two of the mappings written from memory were wrong, and both would have shipped as plausible:

- **`AbortError` is not "camera in use".** The specification defines it as the catch-all —
  "if device access fails for any reason other than those listed above". Mapping it to the
  busy-camera message would have told people to close a video call that was not running.
- **`SecurityError` is not in the specification at all** — zero occurrences in the published
  REC. MDN still documents it, so it is kept as a legacy path, but labelled as one rather than
  treated as the answer.

Two further findings shaped the design rather than a line:

- **`BarcodeDetector` does not exist in Chromium on Linux.** It delegates to platform-native
  detection that Linux does not provide, so it ships on Android, ChromeOS and macOS only — and
  CI runs Linux Chromium. Every browser test here therefore drives an injected `ScanSource`.
  Had this been discovered after the view called `new BarcodeDetector()` directly, the failure
  paths — which are most of the work — would have been untestable.
- **A missing camera is reported as `NotAllowedError` before permission is granted**, by
  design, as anti-fingerprinting. So the permission message had to be written to stay true for
  someone who has no camera at all: it says what to do rather than asserting a camera is there.

### The mutation probe found a design flaw, not just a test gap

`while (true)` survived the entire suite. The reason was worth the chase: **three independent
mechanisms stopped the read loop** — the `scanning` flag, the cleared interval, and the
`<video>` being unmounted on close. Any one of them could be deleted with nothing observable
changing, which is another way of saying none of them was tested and none was load-bearing.

Collapsing to one — a self-terminating `while (this.scanning)` loop, with the `<video>` kept
mounted and merely hidden — removed a timer handle, a re-entrancy flag and a leak class
(a `setInterval` never cleared on close, accumulating one per open), and made the remaining
mechanism provable. 10/10 mutations caught afterwards; 7/9 before.

A second, smaller finding: the first version of the tests only passed because the loop waited
one frame interval before its first read, so a listener attached after the fixture resolved
still caught the event. A test that depends on the implementation being slow breaks when it
stops being — the listener is now attached at creation.

### Two things deliberately not done

**The payload never goes into the URL.** The obvious shape for this would be a `/scan` route
handing off to `#/devices/new?payload=…`. That is a setup passcode written into browser
history. The dialog hands the text to the field through a custom event and nowhere else.

**`facingMode` is not `{ exact: 'environment' }`.** Exact makes it a required constraint, which
a laptop with only a front camera cannot satisfy — it would reject with `OverconstrainedError`
on a machine that can scan perfectly well.
