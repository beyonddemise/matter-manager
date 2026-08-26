# Adding a device — design

Date: 2026-08-26
Issue: [#22 M2-5](https://github.com/beyonddemise/matter-manager/issues/22)
Status: proposed

## What this joins together

Three halves have been built without ever meeting: the payload codec (M1-1…M1-4), the
conflict-aware documents and repositories (M1-6, M2-4), and the shell (M2-2, M2-3). This is
the story where a person can put something into the application and get it back out, and it
is the first one that opens a real database in a browser.

Out of scope, deliberately: camera capture (M2b-1 — this form takes text, and a camera later
becomes one more way to fill the same field), search and filter and grouping (M2-6),
editing and moving and disabling (M2-8), remarks (M2-9), photos and DCL lookup (M6).

The device list gets the smallest change that makes a save observable: it renders the devices
that exist, name and room, unsorted beyond id order. Without it, "the device is saved" is a
claim the application itself contradicts one screen later. Everything that makes a list
*usable* — search, filter, room grouping, ordering — stays in M2-6.

## A manual pairing code is not a payload, and cannot become one

The story says "paste an `MT:` payload **or** type a manual pairing code". Those two inputs do
not carry the same information, and the difference is not a detail:

| | `MT:` payload | 21-digit manual code | 11-digit manual code |
|---|---|---|---|
| passcode | yes | yes | yes |
| discriminator | all 12 bits | **top 4 bits only** | **top 4 bits only** |
| vendor / product id | yes | yes | **no** |
| discovery capabilities, custom flow, TLV extension | yes | no | no |

A manual code is sufficient to commission a device — that is what it is for — but the QR
payload cannot be reconstructed from one. The missing eight discriminator bits are not
recoverable, and a payload built by guessing them would encode as a perfectly well-formed
`MT:` string that produces a QR code which silently fails to commission. That is the worst
possible failure for this application: a catalogue whose entire purpose is to still work in
five years, handing back a code that looks right and is not.

So `DeviceDocument` loosens four fields:

```ts
readonly manualCode: string        // unchanged: always present, always sufficient
readonly payload?: string          // only when a payload was the source
readonly vendorId?: number
readonly productId?: number
readonly discriminator?: number    // the full 12 bits, only from a payload
```

`manualCode` stays required because it is always derivable: from a payload via
`deriveManualCode`, and from a typed code because it *is* the typed code. The direction that
works is recorded as a required field; the direction that does not is recorded as an absent
one. M2-7 reproduces a QR when `payload` is present and shows the manual code when it is not,
which is the honest rendering of what was captured.

These fields were added in M2-4 and nothing else consumes them yet, so this is a change to a
type, not a migration.

## `readCredential` — one field, two formats, in `core`

```ts
export interface DeviceCredential {
  readonly payload?: string
  readonly manualCode: string
  readonly vendorId?: number
  readonly productId?: number
  readonly discriminator?: number
}

export function readCredential(text: string): DeviceCredential   // throws PayloadError
```

The form has one field for the code, not two, because a person holding a device label does not
first classify what kind of string is printed on it. `readCredential` decides:

- text beginning with `MT:` → `decodePayload`, then `deriveManualCode` from the decoded fields
- text that is digits once separators are removed → `parseManualCode`
- anything else → `PayloadError` naming which two things it was not

Every error message must name what was wrong without echoing the input, because the input
contains the setup passcode. `decodePayload` and `parseManualCode` already hold that line; this
function's own messages hold it too, and a test asserts it for a real payload and a real code.

Rejecting before writing is structural rather than a matter of ordering care: nothing reaches a
repository until the credential has parsed.

## `planNewDevice` — the form's decision, without the form

The interesting part of "add a device" is not the markup. It is: which room does this belong
to, is that room new, what is the id, what defaults apply. All of that is a function over plain
data, so it lives in `core` beside the documents it builds and is tested in Node in
milliseconds:

```ts
export interface DeviceDraft {
  readonly credential: string
  readonly name: string
  readonly room: string            // a room path, typed or chosen
  readonly spot?: string
  readonly serial?: string
  readonly installedAt: string     // YYYY-MM-DD
}

export interface DeviceCreation {
  /** Write this first. Absent when an existing room matched. */
  readonly room?: Unsaved<RoomDocument>
  readonly device: Unsaved<DeviceDocument>
}

export class DraftError extends Error {
  readonly field: 'credential' | 'name' | 'room' | 'installedAt'
}

export function planNewDevice(
  draft: DeviceDraft,
  rooms: readonly RoomDocument[],
  clock: { uuid: () => string; now: () => string },
): DeviceCreation
```

Four decisions worth stating:

- **It plans, it does not write.** Returning the documents rather than saving them is what lets
  every rule here be tested without a database, and what makes "no device is created" on an
  invalid input true by construction rather than by remembering to return early.
- **`DraftError` carries the field.** A form that can only say "something is wrong" makes the
  user hunt. The field name is what lets the view attach the message to the control that caused
  it, and it is a closed union so a new field cannot be introduced without the view being a
  type error.
- **Room matching goes through `roomPathKey`.** M1-5 already decided that
  `Ground Floor/Kitchen` and `ground floor / kitchen` are the same room. Re-deciding it here
  would be a second answer to a question already answered, and the two would drift.
- **`uuid` and `now` are injected.** Same reason as the repository's clock: `core` holds no
  ambient anything, and a test that cannot pin the id cannot assert the document.

Defaults: `installedAt` defaults to today in the *view* (the form field is pre-filled, and the
user can change it), not in `planNewDevice` — a plan function that invents a date when handed a
blank one hides a bug in the caller. `addedAt` comes from `now()`, `disabled` is `false`,
`remarks` is `[]`.

## Opening a database in the browser

`packages/web/src/db/project-database.ts` is the only file in the repository that imports
`pouchdb-browser`:

```ts
export function projectDatabase(): ProjectRepositories   // memoised
```

- **Lazy and memoised.** Opening IndexedDB at module scope would do it during every test
  import, including the ones that have no interest in a database.
- **One database, named `project_local`.** There is no project concept until M5, and inventing
  a uuid now would produce a database name nobody can reproduce after clearing storage. The
  name matches the `project_<name>` convention so that M5 replaces a constant rather than a
  scheme.
- **Views take their repositories as a property**, resolving `projectDatabase()` only when
  nothing was bound. Resolved on first *update* rather than in the constructor, because that is
  when a property binding is guaranteed to be in place.
- **Tests bind a real `pouchdb-browser` database of their own**, uniquely named and destroyed
  afterwards, rather than a fake. These tests already run in a browser, and the shipping build
  is the thing worth exercising — this is the only place the application's choice of PouchDB
  build is proved to work at all. Nothing is duplicated by doing so: `packages/data`'s own
  tests cover the repository logic against the memory adapter in Node, in milliseconds. What
  is added here is the wiring.

### Two things `pouchdb-browser` brings with it

**The `uuid@8` advisory.** `npm audit --omit=dev` reports
[GHSA-w5hq-g745-h8pq](https://github.com/advisories/GHSA-w5hq-g745-h8pq), moderate: *missing
buffer bounds check in v3/v5/v6 when `buf` is provided*. Two independent reasons it is not
reachable here — the advisory covers v3, v5 and v6, and PouchDB uses only v4; and it applies
only when the caller supplies its own buffer, which PouchDB never does. Checked in the shipped
bundle rather than inferred:

```console
$ grep -n 'uuid' node_modules/pouchdb-browser/lib/index.js
6:var uuid = require('uuid');
949:    return uuid.v4().replace(/-/g, '').toLowerCase();
957:var uuid$1 = uuid.v4; // mimic old import, only v4 is ever used elsewhere
```

Recorded rather than suppressed: there is no `npm audit` exception in this repository, so the
report stays visible and this note explains it. It clears when PouchDB moves to `uuid@11`.

**`pouchdb-browser@9` needs an `events` shim, and does not say so.** Its ESM build opens with
`import EE from 'events'` — a Node builtin — which the package does not declare as a
dependency and the browser does not have. Vite externalises it, and the bundle then dies on
`TypeError: Class extends value [object Object] is not a constructor` before a single test
runs. `events@3.3.0` (MIT, zero dependencies, a direct port of Node's `EventEmitter`) is added
to `packages/web` for this and nothing else, with a policy entry saying so. It is a shim for
someone else's undeclared requirement, not a library this project chose, and it is removed the
day PouchDB stops needing it.

## The form

One view, `#/devices/new`, registered without a `label` so it does not appear in the
navigation; it is reached from a primary button on the device list. A route with no label was
already the shell's way of saying "reachable but unlisted" (M2-2), so this needs no new
machinery.

Controls, all Web Awesome, all through documented attributes:

| Field | Control | Notes |
|---|---|---|
| Setup code | `<wa-input>` | one field for both formats; the hint says so |
| Name | `<wa-input required>` | |
| Room | `<wa-combobox allow-create>` | existing rooms as `<wa-option>`s |
| Spot | `<wa-input>` | optional free text |
| Serial | `<wa-input>` | optional |
| Installed | `<wa-input type="date">` | pre-filled with today |

**Inline room creation is `allow-create`, not a second screen.** `<wa-combobox allow-create>`
shows a "Create *X*" option when what the user typed matches nothing, and fires a cancelable
`wa-create`. The handler calls `preventDefault()` and adds the path to the view's own state
instead of letting the component insert a `<wa-option>` into the DOM — Lit owns that DOM and
would discard it on the next render. The room is written when the device is written, not when
it is typed, so abandoning the form leaves no empty rooms behind.

Errors render as a `<wa-callout variant="danger">` above the form, and the offending control
gets the message through its own `hint`. Nothing is written until every field has passed.

Write order on submit: room (if new), then device. There are no transactions in PouchDB, so a
device write failing after a room write leaves an empty room — harmless, visible, and
reusable — whereas the reverse would leave a device pointing at a room that does not exist.

## What could go wrong

**A test asserts a form is saved by checking the form.** The round trip has to end at the
repository, not at a component property. Each acceptance-criteria test reads the document back
through `list()`.

**`exactOptionalPropertyTypes` and the newly optional fields.** `{ payload: undefined }` is not
assignable to `payload?: string` under this repo's settings, so `planNewDevice` builds its
result by spreading conditional fragments rather than assigning `undefined`. This is a compile
error rather than a runtime one, which is the good direction, but it is the kind of thing that
gets "fixed" with a cast.

**The combobox reports its value differently from a plain input.** Its selected value is
`value`; the text the user typed is `inputValue`. Reading the wrong one produces a form that
works when a room is picked and silently submits an empty room when one is typed. Both paths
have their own browser test.

This bit during implementation, from the *test* side. A helper that filled every control by
setting `.value` made six tests fail against a correct application: `<wa-combobox>` refuses a
`value` matching no option and leaves it `null`, which is a state no user can produce. The
tests now type into `inputValue` and select through `value`, in separate cases, because those
are the two things a person can actually do.

**A locale switch mid-form.** Every string goes through `msg()` and the view calls
`updateWhenLocaleChanges`, per M2-3. `check:i18n`'s scan enforces the first; the second is
covered by the existing locale-switch browser test, extended to this view.
