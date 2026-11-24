# 23. Layouts: inline SVG behind a sanitiser, drawings fetched on demand

Date: 2026-11-24

## Status

Proposed (amends [0013](0013-minimal-runtime-dependencies.md),
[0021](0021-room-is-a-device-property.md) and [0022](0022-field-encryption-with-key-escrow.md)).
Design: spec 2026-11-24, "SVG layouts". Issue #143, spike #155.

## Context

#143 lets a writer import an SVG floor plan for a room path and place devices on it. The
product owner decided on 2026-10-28 that a layout attaches to a room-path segment, that no
per-device placement documents exist, that the layout holds the original SVG plus a woven copy
with device positions and links, and that it renders as inline SVG behind a sanitiser.

The #155 spike measured what constrains the rest:

- A plan is 6 KB to 900 KB. An attachment keeps it out of `allDocs` reads, but CouchDB
  replicates a document with its attachments, so replicating the layout document replicates
  the plan.
- A `_selector` filter is evaluated by CouchDB, so a document it excludes never crosses the
  wire. A function filter on a pull runs after the bytes have arrived.
- Inline SVG is inert *only* because `script-src` has no `'unsafe-inline'`. Without the policy,
  a `foreignObject onerror=` and a `javascript:` href both execute in this origin.

Three tensions follow. A single layout document cannot both be listed offline by every phone
and stay off every phone. A room path in an id breaks on rename, and a rename may happen
offline on a device that does not have the plan. And a sanitiser is a runtime dependency, which
ADR 0013 admits only when the platform is genuinely insufficient.

## Decision

1. **A layout is two documents sharing a UUID.** `layout:<uuid>` is the head: `room`, `title`,
   `viewBox`, the plan's size and digest, and an embedded `placements` map in SVG user units.
   It replicates like a device. `drawing:<uuid>` holds two attachments: `plan.svg`, the
   original as sanitised at import and never rewritten, and `woven.svg`, generated from the
   plan and the head.
2. **The room is a field, not part of the id**, exactly as on a device. Several layouts may
   cover one room path. A rename rewrites `room` on heads in the subtree alongside the devices,
   offline included.
3. **Rooms are derived from devices and layout heads** (amends 0021), so a floor plan can exist
   before the floor's first device.
4. **The live pull excludes drawings** with
   `{"_id": {"$not": {"$regex": "^drawing:"}}}`. The selector names the id, not the type, so a
   deletion tombstone, which has no type, can never be filtered by accident. The push is
   unfiltered. A client fetches a drawing by `doc_ids` when a layout is opened, or all of a
   project's drawings on request, and keeps it.
5. **Placements merge like remarks** (ADR 0010): a union by device, last-write-wins per entry,
   with removal tombstones. `woven.svg` is derived. A writer regenerates it at save, and lazily
   when its input hash (`wovenFrom`) is stale. It is never rewritten because a device changed,
   and a conflict over it is resolved by regenerating.
6. **The woven copy carries only non-secret identity**: the device UUID, name, room, type, draft
   status, position, and a `#/devices/<uuid>` link built by one validating function. Never a
   setup code. It is built through DOM APIs and `XMLSerializer`, never by string concatenation.
7. **Plans render inline, sanitised by DOMPurify, in a dedicated shadow root** (amends 0013:
   DOMPurify joins the accepted dependencies, lazily loaded with the layout view). A plan is
   sanitised at import and again at every render, because a replicated drawing is untrusted.
   The tree is inserted as nodes, never re-parsed as HTML. Device markers are DOM outside that
   shadow root, drawn from live data, so the in-app view never shows a stale woven copy.
8. **`script-src` without `'unsafe-inline'` is now load-bearing.** `check:deploy` already
   refuses it. `probe:svg` runs in CI, with a mode that renders sanitised output under no
   policy at all, so the sanitiser and the policy are each proven without the other.
9. **A locked project may export a layout** (amends 0022's "nothing exports a locked
   project"). That rule exists because a locked read lacks the codes. A layout never holds
   them.

## Consequences

- The device list and a phone's routine sync never pay for a plan. A phone that never opens a
  plan never downloads one, and one that has opened it can show it offline.
- Rename, merge, listing and placements all work offline, because heads are local. Only the
  picture needs the network, once per device.
- Two documents per layout must be kept in step. The import writes the drawing first and rolls
  it back if the head fails. A deletion deletes the drawing first. A head that outlives its
  drawing through a delete-versus-edit conflict says so and offers Delete.
- The first sync after the selector ships walks each project's changes feed once more, because
  the replication id changes. Nothing is re-downloaded.
- A server-side conflict between two `woven.svg` revisions waits until a client fetches that
  drawing. Until then it costs one stored attachment.
- One more runtime dependency, on the most security-sensitive path in the browser. It is
  pinned, policed by `dependency-policy.json`, lazy, behind one function, and replaceable by
  the native Sanitizer API once Safari ships it.
- Plans and placements are plaintext, like the rest of the inventory. A plan with devices on it
  is a sensitive picture of a home. It is no more exposed than the device list and room names,
  and ADR 0005's controls cover it.
- There is no cache eviction. A local delete would replicate as a real one, so a fetched drawing
  stays until the project is removed from the device.

Revisit if plans must be encrypted (AES-GCM over the attachment bytes with the project DEK is
the contained change), if the native Sanitizer API reaches every target browser, or if anyone
proposes relaxing `script-src`.
