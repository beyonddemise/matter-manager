# M2 — Local catalogue

**Goal:** a usable application. Scan a code, file a device, find it again — entirely in the
browser, with no server, no account and no connectivity.

At the end of M2 this is already worth using for your own house.

---

## M2-1 · Confirm Web Awesome licensing and coverage

`type:spike` `area:web` `size:S` **← do this first**

Before any UI is built on it, confirm the licence permits this use, and that the components
actually needed exist and behave: button, input, select, dialog, drawer, card, tab group,
menu, tooltip, form validation, dark mode.

**Done when:** findings recorded in an ADR amendment, and either Web Awesome is confirmed or
an alternative is chosen. Exposure is contained — its components are Lit-based — but
discovering a gap halfway through M2 is much more expensive than discovering it now.

---

## M2-2 · Application shell and routing

`type:story` `area:web` `size:M`

```gherkin
Scenario: the app loads and shows the device list
  When the app is opened
  Then the device list is shown
  And navigation works on phone, tablet and desktop widths

Scenario: an unknown route is handled
  When an unknown path is opened
  Then a not-found view offers a way back
```

**Out of scope:** authentication, projects (M4/M5). M2 operates on a single implicit local
project.

---

## M2-3 · i18n scaffolding with English and German

`type:story` `area:i18n` `size:M`

**Story:** as a German-speaking user, I want the app in my language automatically, and I
want to be able to override it.

```gherkin
Scenario: locale follows the browser
  Given the browser reports de-DE
  When the app loads
  Then the interface is German

Scenario: an unsupported browser language falls back
  Given the browser reports fr-FR
  Then the interface is English

Scenario: an explicit preference overrides the browser
  Given the profile locale is "en"
  And the browser reports de-DE
  Then the interface is English
  And switching locale does not reload the page
```

**Done when:** `@lit/localize` runtime mode is configured, en/de XLIFF catalogues exist, and
**no user-visible string literal appears in any component.**

**Why now and not later:** retrofitting `msg()` across a built UI is miserable and never
quite finished. Wrapping strings from the first component costs nothing.

---

## M2-4 · PouchDB repositories

`type:chore` `area:data` `size:M`

Device and room repositories over PouchDB, with typed documents from `core`.

```gherkin
Scenario: a device round-trips
  When a device is saved and read back
  Then every field is preserved, including remarks

Scenario: documents are keyed by type prefix
  Then devices can be listed via a ranged _all_docs query without a view
```

**Test plan:** `pouchdb-adapter-memory`, never a live CouchDB.

---

## M2-5 · Scan a QR code

`type:story` `area:web` `area:qr` `size:L`

**Story:** as a user standing in front of a device, I want to scan its code with my phone.

```gherkin
Scenario: a code is scanned with the native detector
  Given a browser supporting BarcodeDetector
  When a Matter QR code is in view
  Then the payload is decoded and the add-device form is prefilled

Scenario: a browser without BarcodeDetector still works
  Given iOS Safari, which does not support BarcodeDetector
  Then the ZXing fallback is used and scanning still succeeds

Scenario: camera permission is refused
  When camera access is denied
  Then manual entry is offered with an explanation
  And the app does not appear broken

Scenario: a non-Matter code is scanned
  When a QR code that is not a Matter payload is scanned
  Then the error names what was wrong
  And scanning continues rather than dropping out of the flow
```

**Out of scope:** NFC; scanning multiple codes in one pass.

**Note:** iOS Safari lacking `BarcodeDetector` is a certainty, not a risk. The fallback is
part of the story, not a follow-up.

---

## M2-6 · Add a device with metadata

`type:story` `area:web` `size:M`

```gherkin
Scenario: a scanned device is filed
  Given a successful scan
  When I enter a name and choose a room
  Then the device is saved
  And the installation date defaults to today
  And vendor and product ids from the payload are stored

Scenario: a room is created without leaving the flow
  When I type a room name that does not exist
  Then I can create it inline and continue

Scenario: a payload can be entered by hand
  When I paste an "MT:" string or type a manual pairing code
  Then the device is created exactly as if it had been scanned
```

**Why inline room creation:** the alternative is abandoning the add-device flow to go and
set up a room, then starting again. Nobody does that; they type the room into the name field
instead and the structure never happens.

---

## M2-7 · List, search and filter devices

`type:story` `area:web` `size:M`

```gherkin
Scenario: devices are grouped by room
  Then the list groups by room path and shows a count per room

Scenario: search matches name, room, serial and product
  When I search for "kitchen"
  Then devices in any room whose path contains "kitchen" are shown
  And devices whose name contains "kitchen" are shown

Scenario: disabled devices are separated
  Then disabled devices are visually distinct and can be filtered out
```

---

## M2-8 · Show a device and reproduce its QR

`type:story` `area:web` `area:qr` `size:M`

```gherkin
Scenario: a device's QR is reproduced
  When I open a device
  Then a scannable QR code of its stored payload is displayed
  And the manual pairing code is shown beside it
  And the QR can be enlarged for scanning from another screen

Scenario: the reproduced code actually works
  Then a QR rendered from a stored payload decodes back to identical field values
```

**That last scenario is the one that matters.** Everything else in this milestone is
convenience; if the reproduced code does not scan, the product has no reason to exist.

---

## M2-9 · Edit, disable and move a device

`type:story` `area:web` `size:M`

```gherkin
Scenario: a device is moved to another room
  When I change its room
  Then it appears under the new room and the old room's count decreases

Scenario: a device is disabled rather than deleted
  When I disable a device
  Then it is retained with a disabled flag and timestamp
  And its QR code is still reproducible

Scenario: deletion is confirmed
  When I delete a device
  Then I am warned that its commissioning code cannot be recovered
```

**Why disable and not delete:** a removed device may be reinstalled elsewhere, and its code
is the thing that cannot be recreated once lost.

---

## M2-10 · Timestamped remarks

`type:story` `area:web` `size:S`

```gherkin
Scenario: a remark is added
  When I add a remark
  Then it is stored in the device record with a timestamp and author
  And existing remarks are never modified

Scenario: remarks read newest first
  Then remarks display in reverse chronological order
```

**Out of scope:** editing or deleting remarks. They are an append-only log; mutability would
defeat both the audit value and the conflict-free merge.

---

## M2-11 · Offline-capable PWA

`type:story` `area:web` `size:M`

```gherkin
Scenario: the app works with no connectivity
  Given the app has been loaded once
  When the device goes offline
  Then the app opens, lists devices, and accepts new ones

Scenario: it can be installed
  Then the app is installable on Android and iOS with an icon and splash screen

Scenario: offline state is visible but not alarming
  When offline
  Then an unobtrusive indicator is shown
  And no action is blocked except those genuinely requiring a server
```

---

## M2-12 · Deploy to Cloudflare Pages

`type:chore` `area:infra` `size:S`

**Done when:** pushes to `main` deploy automatically, PRs get preview deployments, and the
service worker updates without users having to clear storage.

**Watch for:** a stale service worker serving an old bundle indefinitely is the classic PWA
deployment failure, and it is invisible to whoever deployed it.
