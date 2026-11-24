# Adding a device in steps — design

Date: 2026-11-21
Issue: [#349](https://github.com/beyonddemise/matter-manager/issues/349)
Status: approved
Builds on: [Adding a device](2026-08-26-add-device-design.md), [QR decode and DCL catalogue](2026-10-05-qr-decode-and-dcl-catalogue-design.md)

## Why

The add form is one long column of seven controls and three buttons. On a phone it runs past
the fixed footer, and nothing about it says what the job is: *read the label, decide where the
thing lives, give it a name, check it.* The form should teach that sequence instead of hiding it.

A second, smaller defect: on a device with a camera the person sees **two** "Upload an image"
buttons — one on the form, one inside the scan dialog (`scan-dialog.ts`). One is enough.

## Goals

- The add flow is four steps, shown with Web Awesome Pro's `<wa-stepper>` / `<wa-step>`:

  | # | Step (`name`) | Label | Contents |
  |---|---|---|---|
  | 1 | `scan` | Scan | Setup code, Scan *or* Upload (see below), catalogue lookup status, Serial number, Installed |
  | 2 | `place` | Place | Room, Spot |
  | 3 | `name` | Name | Name |
  | 4 | `review` | Save | Read-only summary of 1–3, catalogue names when known, an "Edit" per section, **Save device** |

- Exactly one upload control is visible at any time.
- Every behaviour the current form has survives: debounced catalogue lookup, room matching on
  save, the project-switch guard, the double-submit guard, the storage-refusal path, backfill.

## Non-goals

- The edit form (`edit-device.ts`) stays a single page. Editing is usually one field; four
  screens to rename a device is worse.
- No change to validation rules, the stored document, or `planNewDevice`.
- ~~No per-step URL.~~ Superseded by [#356](https://github.com/beyonddemise/matter-manager/issues/356):
  each step is a history entry, so browser Back moves one step back; see "History" below.

## Anti-goals (would be a failure even if it works)

- A typed value lost by moving between steps.
- A device saved with a value the person never saw on Review.
- An error at save time that names a field the person cannot see.

## Approaches considered

1. **One view, four panels, inactive panels hidden — chosen.** `AddDeviceView` keeps owning
   every control. A `<wa-stepper>` sits above four panels; only the panel matching `active` is
   shown, the others carry `hidden`. Values stay in the controls, exactly as today.
2. **One component per step, state lifted into properties.** Rejected: it reverses the
   deliberate "values are imperative so a re-render cannot revert them" design
   (`add-device.ts` `onScan`, `firstUpdated`), and rewrites well-tested code for no user gain.
3. **One route per step** (`#/devices/new/place` …). Rejected: Back would walk steps rather than
   leave the form, the lazy-view table and its tests change, and nothing asked for deep links.

## Design

### Structure

```html
<form novalidate>
  <h1>Add a device</h1>
  <wa-stepper active="scan" orientation="horizontal" clickable label="Add a device">
    <wa-step name="scan">Scan it</wa-step>
    <wa-step name="place">Place it</wa-step>
    <wa-step name="name">Name it</wa-step>
    <wa-step name="review">Review</wa-step>
  </wa-stepper>

  <section data-step-panel="scan">…</section>          <!-- hidden unless active -->
  <section data-step-panel="place" hidden>…</section>
  <section data-step-panel="name" hidden>…</section>
  <section data-step-panel="review" hidden>…</section>

  <div class="wa-cluster">Back · Next | Save device · Cancel</div>
  <scan-dialog>…</scan-dialog>
</form>
```

- `orientation="horizontal"` keeps the steps in one row; `clickable` without `linear` lets the
  person go to any step (see below).
- The panel that is shown is driven by a reactive `step` property mirrored from
  `wa-step-change`; the panels are always in the tree so their controls keep their values and
  `planNewDevice` can still read every control on submit.
- Each panel's first heading/control receives focus on step change, so keyboard and screen
  reader users land in the new step (the stepper itself announces the position).
- **Back** is absent on step 1; **Next** on steps 1–3; **Save device** only on Review.
  **Cancel** on every step.
- Enter in a field on steps 1–3 means *Next*, not submit: the form's submit handler advances
  unless the active step is Save.

### Moving between steps: checks without a gate

*Revised after the first review on #351 (owner's direction): the vertical stepper took too much
space, and validation held people on a step.*

The stepper is `orientation="horizontal"` at every width and `clickable` without `linear`, so
Next, Back and a click on any step always move - reached or not. Validation still runs on every
step, but it never refuses the move:

- **Leaving a step** checks its own fields. A pass gives it a checkmark (`completed`); a failure
  marks it `variant="danger"` with a warning icon in its marker, labelled "Check this step" for
  assistive technology (WCAG 2.2 1.4.1: shape and words, not colour alone). The message itself is
  not shown then: it would name a control on a panel about to be hidden.
- **Returning to a flagged step** shows its message beside the control, through the existing
  `renderError()` / `messageFor()`.
- **Arriving on Save** checks every step, including any jumped over or emptied since, so the
  stepper and the Save cards give one verdict on everything about to be stored.
- A step loses its flag only when it passes on being left again.

What each step found is held in one reactive record (`checked`), and the stepper renders from it
rather than being set imperatively.

Each step checks only its own fields with the validators `planNewDevice` already uses, so there
is still one definition of "valid". The view does not call those validators: `domain/index.ts`
deliberately keeps `readName` and the others off the entry point. A new domain function,
`checkDraftFields(draft, fields)`, runs the same readers for just the named fields and throws
the same `DraftError` `planNewDevice` would:

| Step | Checks |
|---|---|
| scan | `readCredential` (setup code), `readInstalledAt` |
| place | `readRoomPath` |
| name | `readName` |

A failure is recorded as that step's `DraftError` and shown, on return, through the existing
`renderError()` / `messageFor()` hints.

Room *matching* (`matchRoom`) and the re-read of rooms stay where they are: at save.

### Saving

Unchanged: `onSubmit` re-reads rooms, calls `planNewDevice`, writes, asks for backfill,
navigates to `#/devices`. If `planNewDevice` throws a `DraftError` anyway (a room another tab
renamed, a value changed and not re-checked), the stepper `goTo()`s the step that owns
`error.field`, so the message is next to the control it is about.

### Review (the Save step)

A read-only summary, one block per step, each with an "Edit" link that calls `goTo()`. Each card
carries its step's verdict: a check icon when it passed, or a warning icon and the problem itself
in a danger callout when it did not.

- Scan it — setup code (as typed), serial (if any), installed date (locale-formatted with
  `<wa-format-date>`), manufacturer / product when the lookup has answered (`renderCatalogLines`).
- Place it — room path, spot (if any).
- Name it — name.

Values are read from the controls when Review is entered, never cached elsewhere.

### One upload control

- On the form: **Scan the code** when `canScan`, otherwise **Upload an image**. Neither until
  `scanChecked` (avoids a button that swaps under the thumb on a phone).
- In the scan dialog: its existing **Upload an image** stays — it is the fallback when a camera
  exists but cannot read the label.
- The long comment above the form's upload button ("Always rendered … that asymmetry is the
  feature") is rewritten to the new rule.

### Shared fields

`DeviceFormView.renderFields()` is split into `renderNameField()`, `renderPlaceFields()`
(room + spot), `renderSerialField()`, `renderInstalledField()`. `renderFields()` remains and
composes them in today's order, so `edit-device.ts` is untouched.

### Strings

New `msg()` strings: the four step labels, Next, Back, Edit, the Review section headings, and
the stepper's accessible label. German translations added alongside (`check:i18n`).

## Constraints

- Web Awesome Pro 3.15.0 (installed) provides `wa-stepper` / `wa-step`; the project's
  `webawesome` skill does not document them yet, so the API was read from
  `@awesome.me/webawesome-pro/dist/custom-elements.json`. Both need importing where the other
  Pro components are registered.
- WCAG 2.2 AA (PRODUCT.md): focus moves into each new step; step status is not colour-only
  (the component shows a checkmark for completed steps).
- No custom CSS values: layout with `wa-stack` / `wa-cluster`, spacing with `wa-gap-*`.

## Tests

`frontend/test/ui/views/add-device.browser.test.ts` is reworked step-by-step; new cases:

- Next is refused on each step with an empty required field, with the field's message shown.
- Values survive Back / Next and a jump from Review's Edit.
- A `DraftError` at save lands on the owning step.
- Only one upload control: camera available → Scan on form, Upload only in dialog; no camera →
  Upload on form.
- Enter on steps 1–3 advances, does not save.
- Edit form still renders every field on one page (regression).

`scan-dialog.browser.test.ts` and `german-problems.browser.test.ts` are adjusted to reach the
fields through the steps. `npm run verify` clean, coverage gate met, zero warnings.

## Left to the builder

- Exact copy of step descriptions (`slot="description"`), if any are used.
- Whether the Review blocks are `wa-card`s or a definition list inside one card. Decided (Task 3):
  one `wa-card` per step, its `<h3 class="wa-heading-m">` in the header slot (under the Review panel's
  visually hidden `<h2>Review</h2>`, which receives focus on entering Review) and Edit in
  `header-actions`, the values a `dl.app-facts` like the catalogue lines - so each block reads as
  the step it returns to.
- Where the stepper's Pro imports live, following the existing registration module.
- Decided (Tasks 4-5): the form offers one upload control - Scan the code where the browser can
  scan, Upload an image where it cannot - and offers neither until the camera check finishes.
  The stepper's accessible label reuses "Add a device"; the Review card headings reuse the step
  labels; Edit names its step for assistive technology ("Edit: Place it"). German step labels:
  Scannen, Platzieren, Benennen, Prüfen; Next and Back are Weiter and Zurück.

## Deviations from the design

- Enter in the room combobox does not advance to the next step. `wa-combobox` swallows Enter
  (it selects or opens its listbox), so the form's submit handler never sees it; in the
  combobox, Next is the way forward. Verified with a real keypress.
- Enter in every other field on steps 1-3 advances as specified, because **Next** is a
  `type="submit"` button. `wa-input` handles Enter by clicking the form's first submit button;
  with none it submits only a form with exactly one field, and this form has several, since
  hidden panels stay in the tree. Covered by real-keypress tests in the setup-code and name
  fields, not by a dispatched `submit`, which would pass without the button.

## History: Back is the previous step (#356)

*Added 2026-11-24, the owner's decision on #356: browser Back moves one step back, and leaving
with unsaved input asks first.* Approach 3 above was rejected for making Back walk the steps;
that is now the point, and it is met without changing the route table.

- **Address.** One route still: `#/devices/new` is step 1, and later steps add a query:
  `?step=place`, `?step=name`, `?step=review`. `matchRoute` ignores the query, so the shell keeps
  the same element and its controls keep their values. Each entry carries
  `history.state = { addDevice: <form id>, step }`.
- **One source of truth.** The stepper decides what is on screen; `StepNavigation` reconciles the
  history to it: an entry pushed per step forward, one `history.go(-n)` back to the step wanted.
  The form's n-th entry is always the n-th step, so the Previous button and browser Back are the
  same move, and Forward after Back is the step that was left. Browser Back and Forward move the
  stepper through `goTo`, so the step left is checked as on Next: Forward never skips a check.
- **Jumps.** A click on a later step pushes an entry for each step passed; an Edit link or a
  save-time error walks back. Back is always the previous step in the stepper's order.
- **Reload or deep link** onto a later step lands on step 1, because the values are gone. An entry
  this form stamped before the reload is adopted and walked back to its first entry, so Back then
  leaves the form; an unstamped one (a deep link) is replaced with `#/devices/new`.
- **Save** (and a project switch) walks back to the form's first entry and *replaces* it with
  `#/devices`: Back from the list never returns into a finished form.
- **Leaving with input.** Input is any field with text, or a date changed from today. The shell
  asks the view (`leave-guard.ts`) before a `hashchange` to another route (Back from step 1, an
  address typed) and before an in-app link click (header navigation, Cancel); `beforeunload`
  covers a reload and a closed tab. A `hashchange` has already moved the address, so the shell
  keeps the form on screen while it asks. Navigations while the question is open are set aside,
  and the answer is acted on for wherever the browser is *then* (`AppShell.settleLeave`):
  - On another page: Discard follows it; Stay has the form go back to its own entry, which is
    still in the history - behind a typed address, ahead of the page Back reached. The
    Navigation API's entry index says how far. Without that API, a change in `history.length`
    marks a typed address (the entry is the one behind); otherwise every step up to the current
    one is pushed again, so Back from it is still the previous step.
  - On the form's own page (Forward came back while asking): nothing happens, and nothing is let
    go. The form is *released* - stops guarding and saving - only when the shell actually
    leaves it (`LeaveGuard.release`).
  - If the form lets go on its own while asking (a project switch, a Save landing), it withdraws
    the question, and the shell follows the form's own navigation to the list.

  A link click is stopped before it navigates, so it leaves no entry behind. Nothing is asked
  when nothing would be lost.

  **Known limit, without the Navigation API only.** A typed address that leaves
  `history.length` unchanged is taken for a
  traversal: one typed when exactly one entry was ahead of the form's current one (Back a step,
  then an address), or once the browser's history is at its cap (50 entries in Chromium). Stay
  then pushes the entries again, and Back from step 1 lands on the typed address and asks once
  more. Nothing is lost, only a second question; the History API cannot tell the two apart.
- **The question** is `leave-dialog.ts`: a `wa-dialog` with **Stay** (focused, and what Escape
  means) and **Discard**. Its `LeaveChoice` type is the seam for drafts (#358), which adds
  **Save as draft** as a third choice without touching the shell or the history.

## Drafts (#358)

*Added 2026-11-24, after the owner's decision on #358.* A draft is a device with
`"status": "draft"` (DATA-MODEL, "Drafts"); this is how the stepper makes and finishes one.

- **Save as draft on every step.** An outlined button beside Next / Save device. It plans with
  `planDraftDevice`: at least one of setup code, name, room, spot and serial, and every value
  present must pass its reader. A refusal is shown on the step that owns the field, as Save's is.
  A stored draft is kept on the form (`stored`), so saving again updates the same document.
  Saved from the button, the form then leaves for the list as Save device does.
- **In the leave question.** The dialog asks the draft planner first (`draftOption`). When it
  would accept, **Save as draft** sits between Stay and Discard. When it would refuse (a code
  that does not read, say), the dialog says why in a neutral callout instead of offering a button
  that would fail. Choosing it saves, then answers "leave"; if storage refuses, it answers
  "stay" and the form shows the storage callout. The shell still only hears leave or stay.
- **Reopening.** `#/devices/<uuid>/finish` renders `<finish-device-view draft-id=…>`, the add
  form under the name the route convention needs, keyed by the uuid so another draft is a new
  form. The draft's values go into the controls (an absent date stays empty), every step is
  checked, and the form goes to the first step that fails, or to Save when none does. The
  heading reads "Finish a draft". A draft finished elsewhere meanwhile sends the form to its
  device page; a missing one says "Draft not found".
- **Leaving a reopened draft** asks only when a control differs from what the draft holds: the
  form compares against its *baseline* (empty controls and today for a new device, the draft's
  values for a reopened one). Its Discard reads "Discard changes", because the draft stays.
- **Finishing.** Save device on a reopened draft plans with `planFinishedDevice`: the full
  `planNewDevice` checks, on the draft's own id and revision, its status removed. A refused
  write re-reads the draft, so a retry is not stuck on a revision that moved on elsewhere.
- **Writes are refused, and say why, while unsafe.** These were added after review on #369.
  - The form is `inert` while a reopened draft is read, and an obsolete read (after a project
    switch, or the form being left) does nothing.
  - A draft finished elsewhere is shown in a callout with a link to the device, and the form
    saves no more.
  - A draft read while the project was locked is never saved: the form says so, and the next
    sync re-reads it and puts its setup code back.
  - The baseline is what was planned, so an edit made during the write stays guarded, and the
    form does not leave.
  - A failed room read says "storage" rather than rejecting.
  - A conflict on Save as draft or Save device (a teammate's remark, a catalogue backfill)
    re-reads the draft and retries once, keeping the other side's remarks and catalogue block.
    A second conflict says "changed somewhere else, save again". A draft deleted elsewhere is
    said on the form, and the next save files the input again under the draft's own id (so its
    address and history entries still lead to it) rather than conflicting forever. The notice
    goes once a save lands. A late Discard (released form) stops any write, retries included.
- **Discarding a draft** is the delete on its device page, confirmed in a dialog that says what
  goes with it. The edit route sends a draft to the finish route: `planDeviceEdit` takes only a
  complete device.
- **The shell's stopped link.** `AppShell.settleLeave` follows a link on `leave` alone. Its
  former `holdsInput()` check (#368 review) would now swallow the click, because a draft saved
  from the question leaves nothing unsaved.
