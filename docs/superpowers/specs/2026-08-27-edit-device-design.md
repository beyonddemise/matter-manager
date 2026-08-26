# Editing, moving, disabling and deleting a device — design

Date: 2026-08-27
Issue: [#25 M2-8](https://github.com/beyonddemise/matter-manager/issues/25)
Status: proposed

## What changes, and what deliberately cannot

Four actions on a device that already exists: **edit** its description, **move** it to another
room (which is one field of the edit), **disable** it, and **delete** it.

**The setup code is not editable, and that is a correctness decision rather than a scoping
one.** `payload`, `vendorId`, `productId` and `discriminator` are all derived from the
credential. A form that let someone change the pairing code without re-deriving the other four
would produce a record whose parts disagree — and the failure is the silent one this product
exists to prevent: a QR built from a payload that no longer matches its device encodes
cleanly, renders cleanly, and does not commission. Re-deriving them is precisely what
`readCredential` and `planNewDevice` already do, so the honest fix for a code captured from the
wrong label is to delete the record and add it again. That is what the delete confirmation is
for, and the code being deleted is by definition the wrong one.

## One set of fields, one set of rules

Adding and editing differ in one input (the credential) and one output (`addedAt`). Everything
else — the name must be non-empty, the room path must be well-formed, the date must be a real
calendar date, an existing room is matched by `roomPathKey` rather than created twice — is the
same decision in both flows.

So the shared half moves to `core/documents/draft.ts`:

```ts
export interface DeviceFields {
  readonly name: string
  readonly room: string
  readonly spot?: string
  readonly serial?: string
  readonly installedAt: string
}
```

`DeviceDraft` becomes `DeviceFields & { credential }`, `planNewDevice` keeps its signature, and
`planDeviceEdit` takes `DeviceFields` directly. Two callers, one answer.

Having two answers is the specific thing to avoid here, and it has a name in this codebase
already: if the edit form matched rooms by comparing paths while the add form matched by
`roomPathKey`, then moving a device into `ground floor / kitchen` would create a **second**
`Ground Floor/Kitchen` — the exact duplicate M2-5 was built to prevent, reintroduced through
the door nobody was watching.

## `planDeviceEdit` preserves more than it changes

```ts
export function planDeviceEdit(
  device: DeviceDocument,
  fields: DeviceFields,
  rooms: readonly RoomDocument[],
  uuid: () => string,
): DeviceUpdate
```

It returns `{ room?, device }` exactly as `planNewDevice` does, for the same reason: the room
must reach the database before the device that points at it, and a planner that returns
documents cannot half-write them.

What it carries through untouched is the load-bearing part: `_id`, `_rev`, the whole credential
(`manualCode`, `payload`, `vendorId`, `productId`, `discriminator`), `addedAt`, `remarks`, and
`disabled`/`disabledAt`. Editing a disabled device's name must not quietly bring it back into
service, and a test says so.

`updatedAt` is stripped rather than passed through, because `Unsaved<T>` omits it and the
repository owns that stamp — it is half of the total order the conflict merge depends on
(ADR 0010), and a caller-supplied one is a document that loses every future conflict.

Clearing `spot` or `serial` **removes** the field rather than storing `''`. Under
`exactOptionalPropertyTypes` those are different documents, and "absent" is the true one: an
empty string would read back as a spot that exists and says nothing.

Only `uuid` is injected here, not the whole `DraftClock`. An edit has no `addedAt` to stamp, so
asking for a wall clock it never reads would be a lie about what the function depends on.

## Disable, and why not delete

```ts
export function setDeviceDisabled(
  device: DeviceDocument,
  disabled: boolean,
  now: () => string,
): Unsaved<DeviceDocument>
```

A disabled device keeps everything, including its payload, so its QR stays reproducible — that
is the entire point. A device that comes off a wall may go back up somewhere else, and its
setup code is the one thing that cannot be recreated.

Re-enabling **removes** `disabledAt` rather than leaving it behind. A timestamp saying "this was
disabled at 14:02" on a device that is currently in service is not history, it is a false
statement about the present; history belongs in remarks (M2-9) and the audit log (M7).

## Deleting, and the warning that has to be specific

`repositories.devices.remove(device)` is enough — there is no decision for `core` to own. What
needs care is the confirmation, and specifically that it names the irreversible part. "Are you
sure?" trains people to click through. The dialog says that the commissioning code goes with
the record and cannot be recovered, because that is the sentence that makes someone stop.

Deleting the last device in a room leaves the room behind. That is deliberate: `browseDevices`
does not produce empty groups, so an empty room is invisible and costs nothing, whereas
deleting rooms as a side effect of deleting devices would silently destroy a hierarchy someone
built. Room management is its own story.

## The web side: a base class, not a second form

`add-device.ts` and an edit form share five controls, an error callout, the room combobox's
`wa-create` handling — including the `preventDefault` that stops the component appending an
option into DOM Lit owns and re-renders — and the rule that values are written to controls
**imperatively, once**, never bound. Binding `value` in the template means the first validation
error silently reverts every field the user had filled in.

So `views/device-form.ts` holds a `DeviceFormView` base class with all of that, and both views
extend it. It defines no custom element; it is a base, not a component.

The edit view has one extra ordering constraint the add view does not: values can only be
written after both the device has loaded **and** Lit has rendered the controls — and, for the
room, only after the matching `<wa-option>` exists. That is the same await-then-assign dance
`onCreateRoom` already performs, which is a second reason for it to live in one place.

## Route and actions

`#/devices/:id/edit`. Route order is irrelevant against `/devices/:id` because `matchRoute`
compares segment counts first, and it is irrelevant against `/devices/new` for the same reason
— but `/devices/new` still has to precede `/devices/:id`, and that is unchanged.

The device page grows an action row: Edit, Disable (or Enable), Delete. Disable and Delete act
where the user already is when they decide, and neither is on the list — a destructive control
on every row of a list is a control that gets hit by accident on a phone.

After a delete the view navigates to the list, because the page it was showing no longer
exists. After a disable it stays, because the device does.

## What could go wrong

**The edit resurrects a disabled device, or drops its payload.** Both are single assertions on
the planned document, and both are in the test file rather than only in this note.

**A move leaves the device pointing at a room that was never written.** The room is returned
first and written first, exactly as in M2-5; a failure between the two writes leaves an empty
room, which is harmless and reusable.

**The base class turns into a place where things are put.** It holds what both forms need and
nothing else. The credential field, the date default, and everything about loading an existing
device stay in the views that own them.
