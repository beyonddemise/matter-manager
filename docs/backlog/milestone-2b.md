# M2b — Scanning and offline

**Goal:** point a phone at a code and have it filed; open the app on a train and have it work.

Split out of [M2](milestone-2.md) because these four issues carry the platform risk of the
whole release. Everything in M2 is ordinary application work that behaves the same
everywhere. Here, `BarcodeDetector` does not exist on iOS Safari, camera permissions fail in
several distinct ways, and service workers have update semantics that produce the classic
failure of users pinned to a stale bundle with no way to know.

Concentrating that in one milestone means it gets estimated honestly instead of hiding inside
"add the scanner".

**Depends on:** M2-5 (the add-device form), which takes a payload. Scanning becomes another
way to populate that field.

---

## M2b-1 · Scan a QR code with the native detector

`type:story` `area:web` `area:qr` `size:M`

**Story:** as a user standing in front of a device, I want to scan its code with my phone
rather than typing nineteen characters.

```gherkin
Scenario: a code is scanned
  Given a browser supporting BarcodeDetector
  When a Matter QR code is in view
  Then the payload is decoded and the add-device form is prefilled

Scenario: a non-Matter code is scanned
  When a QR code that is not a Matter payload is scanned
  Then the error names what was wrong
  And scanning continues rather than dropping out of the flow

Scenario: camera permission is refused
  When camera access is denied
  Then manual entry is offered with an explanation
  And the app does not appear broken

Scenario: no camera is present
  Given a desktop browser with no camera
  Then the scan option is absent rather than failing when pressed
```

**Out of scope:** the ZXing fallback (M2b-2); NFC; scanning several codes in one pass.

**Note:** decoding is `core`'s job. This issue is camera plumbing and the failure paths —
which are most of the work. Permission denied, no camera, camera in use by another
application, and non-Matter codes are four different messages, and getting them wrong makes
the app look broken when it is behaving correctly.

---

## M2b-2 · ZXing fallback where BarcodeDetector is missing

`type:story` `area:web` `area:qr` `size:M`

**Story:** as an iPhone user, I want scanning to work at all.

```gherkin
Scenario: a browser without BarcodeDetector still scans
  Given iOS Safari, which does not implement BarcodeDetector
  When a Matter QR code is in view
  Then the ZXing fallback decodes it
  And the behaviour is indistinguishable from the native path

Scenario: browsers with the native API never download the fallback
  Given a browser supporting BarcodeDetector
  Then @zxing/browser is not requested
```

**This is a certainty, not a risk.** iOS Safari has no `BarcodeDetector`, so without this
issue the product does not work on iPhones — which is most of the phones that will ever point
at a device.

**Load `@zxing/browser` lazily**, only when the native API is absent
([ADR 0013](../adr/0013-minimal-runtime-dependencies.md)). That second scenario is the one
that keeps it honest; a static import satisfies the first scenario and quietly ships a WASM
bundle to everyone.

**Consider a web worker** if decoding every frame makes the camera preview stutter — the
classic cause. Measure first; the native path is already off-thread and needs nothing.

---

## M2b-3 · Offline-capable PWA

`type:story` `area:web` `size:M`

```gherkin
Scenario: the app works with no connectivity
  Given the app has been loaded once
  When the device goes offline
  Then the app opens, lists devices, and accepts new ones

Scenario: it can be installed
  Then the app is installable on Android and iOS with an icon and splash screen
```

**The service worker is hand-written, not generated**
([ADR 0013](../adr/0013-minimal-runtime-dependencies.md)). What this app needs — precache the
shell, cache-first for hashed assets, and **never** intercept API or replication requests — is
a short file that can be read in one sitting. A service worker sits in front of every request
and outlives the page that installed it, which makes it the last place to want code nobody has
read.

That "never intercept replication" clause is not stylistic. A service worker that caches
CouchDB `_changes` responses would corrupt sync in ways that are extremely hard to diagnose,
because the replication protocol would be reasoning about stale sequence data.

---

## M2b-4 · Service worker updates and offline UX

`type:story` `area:web` `size:M`

```gherkin
Scenario: a new version is picked up
  Given a new build has been deployed
  When I next open the app
  Then I am told an update is available and can take it
  And I am never stuck on an old bundle with no way forward

Scenario: offline state is visible but not alarming
  When offline
  Then an unobtrusive indicator is shown
  And no action is blocked except those genuinely requiring a server
```

**Its own issue on purpose.** A stale service worker serving an old bundle indefinitely is
*the* classic PWA production failure, and it is invisible to whoever deployed it — the deploy
succeeded, the CDN is correct, and users are simply pinned to yesterday's code. Folding this
into "build a PWA" is how it gets skipped.

**Test plan:** deploy twice and confirm the second version is actually reached, in a browser
that already installed the first. This cannot be verified locally against a single build.
