# M2 — Local catalogue

**Goal:** a usable application. Scan a code, file a device, find it again — entirely in the
browser, with no server, no account and no connectivity.

At the end of M2 this is already worth using for your own house.

---

## M2-1 · Confirm Web Awesome component coverage

`type:spike` `area:web` `size:S` **← do this first**

**Licensing is resolved** — the project owner holds a Web Awesome Pro licence, and registry
access is configured (`.npmrc` + `WEBAWESOME_NPM_TOKEN`, mirrored as a repository secret).
See [ADR 0008](../adr/0008-lit-and-web-awesome.md).

What remains is whether the components actually needed exist and behave: button, input,
select, dialog, drawer, card, tab group, menu, tooltip, form validation, dark mode.

```gherkin
Scenario: the Pro build is what actually installed
  When dependencies are installed
  Then @awesome.me/webawesome-pro resolves from npm.webawesome.com
  And a Pro-only component renders, proving it is not the free build
```

**Why that second assertion earns its place:** the free and Pro packages carry the *same
version number*, and the free one is on public npm. A misconfigured registry would install
something plausible with no error at all. Assert on a Pro-only capability, not on a version
string.

---

## M2-1b · Decide the fork pull request story

`type:chore` `area:infra` `size:S`

The repository is public and now has a private dependency. GitHub does not expose secrets to
workflows triggered by pull requests from forks, so an outside contributor's PR will fail at
`npm ci`.

**Decide between:** accepting it and documenting that fork PRs are reviewed locally; or
keeping Pro usage isolated enough that a free-build fallback compiles.

**Helpful datum:** `<wa-qr-code>` is in the FREE Web Awesome build as well as Pro — verified
against both `@awesome.me/webawesome@3.11.0` and `@awesome.me/webawesome-pro@3.11.0`. The core
product feature therefore does not depend on Pro at all, which keeps the free-build fallback
genuinely viable rather than nominally so.

The answer still depends on how much Pro the rest of the UI uses, so decide after M2-1.

**Do not** reach for `pull_request_target` to solve this. It runs untrusted code with access
to secrets, which trades an inconvenience for a credential compromise.

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

## M2-4b · The `mm-local` cache

`type:story` `area:data` `size:M`

**Story:** as a user on a train, I want to see which projects I have on this device, so the
app is usable without a connection.

`mm-local` is a PouchDB database that exists **only in the browser and is never given a
remote counterpart**. It caches `GET /projects` and `GET /profile`, because both are
server-only and everything else in the app works offline
([ADR 0012](../adr/0012-central-project-registry.md)).

```gherkin
Scenario: the project list survives going offline
  Given I have signed in and the project list was fetched
  When I go offline and reload the app
  Then my projects are still listed
  And each shows whether it is available offline on this device

Scenario: what I may access and what I have are tracked separately
  Given a project I have access to but have never opened on this device
  Then it is listed with localState "not-downloaded"
  And a project whose replica is present shows "downloaded"

Scenario: my locale survives going offline
  Given my profile locale is German and was fetched once
  When I go offline and reload
  Then the interface is still German

Scenario: revoked access is reported, not hidden
  Given my access to a project was revoked while I was offline
  When I reconnect and replication returns 403
  Then the project is shown as "access removed"
  And the app does not appear broken
```

**Out of scope:** any authorisation decision. The cache decides what the client *attempts*;
CouchDB's `_security` decides what succeeds. **A permission check that reads `mm-local` is a
defect** — treat it as one in review.

**Why `localState` is not redundant with the server list:** the server says what you *may*
access; `localState` says what you *actually have here*. They diverge constantly — a project
granted on your phone is not downloaded on your laptop — and only the second answers "what
can I open right now". It also gives an honest indicator: *3 of 5 available offline*.

**Test plan:** `pouchdb-adapter-memory`; assert the cache is never handed to a replication
target (a test that fails if anything calls `sync()` on it).

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

**Load `@zxing/browser` lazily**, only when `BarcodeDetector` is absent. Browsers with the
native API must never download it ([ADR 0013](../adr/0013-minimal-runtime-dependencies.md)).

**Run the fallback decode loop in a web worker** if it makes the camera preview stutter —
decoding every frame on the main thread is the classic cause. Measure before adding the
worker; the native `BarcodeDetector` path is off-thread already and needs nothing.

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

**Use `<wa-qr-code>`.** Web Awesome ships it — verified present in
`@awesome.me/webawesome-pro@3.11.0` — rendering client-side to a canvas, with `value`, `size`,
`fill`, `background`, `radius` and `errorCorrection`. No QR generation library, and no
hand-rolled encoder.

Set `errorCorrection` deliberately rather than leaving the default. Higher correction survives
a scuffed or partly obscured printed label at the cost of a denser code; this is a decision
about where these codes end up, which is inside fuse boxes and behind panels.

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

Remarks are stored in the device document as JSON array

**Out of scope:** editing or deleting remarks. They are an append-only log; mutability would
defeat both the audit value and the conflict-free merge.

---

## M2-11 · Offline-capable PWA

`type:story` `area:web` `size:M`

**The service worker is hand-written, not generated**
([ADR 0013](../adr/0013-minimal-runtime-dependencies.md)). What this app needs — precache the
shell, cache-first for hashed assets, never intercept API or replication requests — is a short
file we can read in one sitting. A generated worker ships a runtime library to do the same
job, and a service worker is the last place to want code nobody has read: it sits in front of
every request and outlives the page that installed it.

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
