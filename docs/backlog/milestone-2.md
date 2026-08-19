# M2 — Local catalogue

**Goal:** a working catalogue — file a device, find it again, reproduce its code — entirely in
the browser, with no server and no account.

Camera scanning and the offline service worker are **[M2b](milestone-2b.md)**. The split is
deliberate: everything here is ordinary application work, while M2b holds the platform risk
(`BarcodeDetector` absent on iOS, service worker update semantics). Devices are added by
pasting an `MT:` payload or typing a manual pairing code, which is a path that must work
anyway — a camera cannot always reach a mounted device.

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
  And <wa-data-grid> renders, which exists only in the Pro build
```

**Why that second assertion earns its place:** the free and Pro packages carry the *same
version number*, and the free one is on public npm. A misconfigured registry would install
something plausible with no error at all. Assert on a Pro-only capability, not on a version
string — and name a specific one, or the assertion cannot be written.

**The 17 Pro-only components**, established by diffing `@awesome.me/webawesome@3.11.0`
against `@awesome.me/webawesome-pro@3.11.0` (70 components vs 87):

```text
bar-chart  bubble-chart  chart  combobox  data-grid  date-input  date-picker
doughnut-chart  file-input  line-chart  pie-chart  polar-area-chart  radar-chart
scatter-chart  sparkline  video  video-playlist
```

Four are directly useful here: **`data-grid`** for the device list, **`combobox`** for room
selection with inline creation, **`date-picker`** for the installation date, and
**`file-input`** for photos in M6. Everything else this milestone needs is in the free build.

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

**But the Pro-only list changes the calculation.** Of 87 Pro components, 17 are absent from
the free build, and four of those are ones this UI would naturally reach for: `data-grid`
(device list), `combobox` (room selection with inline creation), `date-picker` (installation
date) and `file-input` (photos, M6).

So a free-build fallback is viable only if the UI deliberately avoids those four. That is a
real design constraint rather than a packaging detail, and it is worth deciding on purpose
instead of discovering it when a fork PR fails. Substituting `<wa-input>` with a datalist for
`combobox` is cheap; replacing `data-grid` is not.

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

## M2-5 · Add a device with metadata

`type:story` `area:web` `size:M`

```gherkin
Scenario: a device is filed from a pasted payload
  Given I paste an "MT:" payload or type a manual pairing code
  When I enter a name and choose a room
  Then the device is saved
  And the installation date defaults to today
  And vendor and product ids decoded from the payload are stored

Scenario: a room is created without leaving the flow
  When I type a room name that does not exist
  Then I can create it inline and continue

Scenario: an invalid payload is refused before anything is saved
  When I paste text that is not a Matter payload
  Then the error names what was wrong
  And no device is created
```

**The form takes a payload, not a scanner.** Camera capture ([M2b-1](milestone-2b.md)) becomes
one more way to populate the same field. Building it this way round is not a workaround for
the split — manual entry has to work regardless, because a camera cannot always reach a device
already mounted behind a panel, and it is also what makes this flow testable without a camera.

**Why inline room creation:** the alternative is abandoning the add-device flow to go and
set up a room, then starting again. Nobody does that; they type the room into the name field
instead and the structure never happens.

---

## M2-6 · List, search and filter devices

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

## M2-7 · Show a device and reproduce its QR

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

**Set `errorCorrection="H"`.** Level H recovers from roughly 30% damage against about 7% at
the default L. These codes end up on adhesive labels inside fuse boxes, behind panels and on
devices that get handled — scuffing, dust and partial obstruction are the normal case here,
not the exception. The cost is a denser code, which barely matters: a Matter payload is a
fixed 19 characters, so even at H it stays small enough to print on a label and scan.

---

## M2-8 · Edit, disable and move a device

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

## M2-9 · Timestamped remarks

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

## M2-10 · Deploy to Cloudflare Pages

`type:chore` `area:infra` `size:S`

**Done when:** pushes to `main` deploy automatically, PRs get preview deployments, and the
service worker updates without users having to clear storage.

**Watch for:** a stale service worker serving an old bundle indefinitely is the classic PWA
deployment failure, and it is invisible to whoever deployed it.
