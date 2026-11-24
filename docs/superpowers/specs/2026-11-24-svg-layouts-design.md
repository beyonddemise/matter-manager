# SVG layouts: import a plan for a room, place devices on it — design

Date: 2026-11-24
Issue: [#143](https://github.com/beyonddemise/matter-manager/issues/143)
Status: proposed (awaiting product-owner approval of the two deviations below)
Builds on: the #155 spike ([todo-143](../../tasks/todo-143.md)), the product-owner decision of
2026-10-28 on #143, [ADR 0006](../../adr/0006-materialised-path-rooms.md),
[ADR 0021](../../adr/0021-room-is-a-device-property.md),
[ADR 0022](../../adr/0022-field-encryption-with-key-escrow.md)
Decision record: [ADR 0023](../../adr/0023-layouts-inline-svg-drawings-on-demand.md)

## Why

A device list tells you *what* is installed and *which room* it is in. It does not tell you
*where in the room*: which of three ceiling spots is the hall sensor, which socket behind the
sofa is the plug. People already have that picture, as an architect's plan or a sketch drawn in
Inkscape. Let them import it as an SVG for a room path, place the devices on it, and take the
result away as a file that still makes sense outside the app.

## What is already decided

| Question | Answer | Source |
|---|---|---|
| Where a layout belongs | A room-path segment: a plan per floor, a detail plan per room | PO, 2026-10-28 (1) |
| How a device gets a position | No per-device placement documents. The layout holds the original SVG and a second copy with device positions and metadata woven in, each device linking to its page | PO, 2026-10-28 (2) |
| How it renders | **Inline SVG with a sanitiser**, so shapes in the drawing are interactive. Accepts a sanitiser dependency and a permanent dependence on `script-src` without `'unsafe-inline'` | PO, 2026-10-28 (3) |
| Where the bytes live | CouchDB attachments, never inline in a body | spike #155 (2) |
| What keeps phones light | A `_selector` filter, which CouchDB evaluates, keeps plans out of the routine pull | spike #155 (3) |
| What the woven copy may hold | Non-secret identity only. Never `payload`, `manualCode` or anything else ADR 0022 protects | PO, 2026-10-28, constraints |
| When the woven copy is written | On save, not per marker move. A plan can be 1 MB, and every revision stores it again | PO, 2026-10-28, constraints |
| Draft devices (#358) | Shown everywhere with a draft marker, not filtered out | PO, 2026-11-24 |

The spike recommended `<img src="blob:">` rendering. The product owner chose inline SVG after
reading that recommendation, for room-outline selection and working links. This design follows
the product owner and carries the spike's warning forward as a CI gate (see *CSP and probes*).

## Deviations to confirm

Two choices below go past the letter of the 2026-10-28 decision. Both are argued in place, and
both need the product owner's yes before the first implementation PR.

1. **A layout is two documents, not one** (see *Document shape*). A small head that always
   replicates, and a drawing that holds both SVGs and replicates only on demand. One document
   cannot do both jobs: CouchDB replicates a document together with its attachments, so a layout
   that every phone can list offline is also a layout every phone downloads. This is a split
   forced by replication, one-to-one, not a relational placement table.
2. **Positions are also kept as data in the head**, as an embedded map keyed by device (the
   ADR 0010 pattern), and the woven SVG is generated from it. The woven copy stays the
   self-contained artifact the product owner asked for. It is not the merge input, because two
   offline edits of a 1 MB SVG cannot be merged, while two edits of a map can be.

## Goals

- A writer imports an SVG for a room path. The app validates it, sanitises it and shows what it
  removed.
- Anyone with access opens the plan, sees every placed device as a marker linking to its page,
  and sees drafts marked as drafts.
- A writer places, moves and removes devices with a pointer **or with the keyboard alone**, and
  saves.
- Anyone exports the woven SVG, or the original, as a file.
- Opening the device list never pays for a plan, and a phone that never opens a plan never
  downloads one.
- Renaming or merging a room carries its plans with it, offline included.

## Non-goals

- Drawing or editing the plan in the app. The plan is imported as it is and never modified.
- Replacing a layout's drawing in place. To change the drawing, import a new layout and delete
  the old one. This keeps the plan attachment immutable, so it can never conflict.
- Tagging shapes in the drawing as room outlines. Inline rendering makes it possible, and it is
  the last PR in the sequence, but nothing before it depends on it.
- Placements in the PDF inventory or the label sheet.
- `.svgz`, PDF, DWG or raster plans. SVG only, as UTF-8 text.

## Anti-goals (would be a failure even if it works)

- Script running, or a request leaving the origin, from anything inside a plan.
- A setup code, in any form, inside a woven SVG.
- The device list, or the first sync of a project, getting slower because a project has plans.
- A plan that silently stops showing a device's marker after the device is renamed or moved
  within the layout's room.
- Placing that only works with a mouse.

## Approaches considered

### Document shape

1. **One layout document holding both attachments, id derived from the room path.**
   Closest to the decision's wording. Rejected for two reasons. A phone that has not fetched it
   cannot know it exists, so the Rooms page cannot say "this floor has a plan" offline. And a
   path in the id means a rename becomes "create a new id, copy 2 MB of attachments, delete the
   old one", which needs the drawing on the renaming device. Offline, the rename would leave the
   plan behind.
2. **A head document and a drawing document — chosen.** The head is a few hundred bytes plus
   about 100 bytes per placed device, and replicates like a device. The drawing holds
   `plan.svg` and `woven.svg` and is excluded from the live pull. A rename is a scalar write to
   the head, in the same loop that already rewrites devices. Discovery, listing and placements
   work offline. Only the picture needs the network, once.
3. **Coordinates on the device document.** Rejected by the product owner, and it couples
   every device to a plan it may outlive.

### Rendering

1. **`<img src="blob:">`** (the spike's recommendation). Inert by the browser's rules. It does
   not allow selecting a shape in the drawing, which the product owner wants. Rejected by the
   decision.
2. **Inline SVG behind a sanitiser, in its own shadow root — chosen.** See *Sanitising*.
3. **Inline SVG relying on the CSP alone.** Rejected. The spike measured that without the
   policy a `foreignObject onerror=` and a `javascript:` href both execute. A policy is a file
   someone will edit one day.

### Sanitiser

1. **DOMPurify — chosen.** Maintained, audited, zero dependencies, and it has a named SVG
   profile. ADR 0013 asks whether the platform is genuinely insufficient. It is: the HTML
   Sanitizer API is not in Safari, and iOS Safari is a primary target. Writing a sanitiser is
   the same kind of "hard part" ADR 0002 refused to write for replication. Loaded lazily with
   the layout view, so the main bundle does not grow.
2. **Our own allow-list walker over `DOMParser` output.** Small and dependency-free, but every
   known sanitiser bypass (namespace confusion, `<animate>` rewriting `href`, mutation XSS) is
   something we would have to rediscover. Rejected.
3. **The native Sanitizer API.** The right answer once every target browser ships it. The
   sanitiser sits behind one function (`sanitisePlan`), so swapping it later is one module.

## Design

### Document shape

Two documents per layout, sharing a UUID. A project may have **any number of layouts for one
room path**: a floor plan and an electrical plan of the same floor are both reasonable. Allowing
several removes the only conflict a room-keyed uniqueness rule would create (two people
importing a plan for the same room offline, or a merge of two rooms that each have one).

#### `layout:<uuid>` — the head (always replicated)

```jsonc
{
  "_id": "layout:3b0c6f0e-6c1d-4c84-9a5e-2f9d8f3e7a10",
  "type": "layout",
  "room": "Ground Floor",            // ADR 0006 grammar; the subtree this plan covers
  "title": "Ground floor plan",      // plain text, 1-120 characters
  "viewBox": [0, 0, 1200, 800],      // minX, minY, width, height of the sanitised plan, user units
  "plan": { "bytes": 412337, "digest": "sha256-<base64>" },  // of the stored plan.svg
  "placements": {
    // keyed by the device UUID (the part after "device:"), coordinates in SVG user units
    "6ba7b810-9dad-11d1-80b4-00c04fd430c8": { "x": 412.5, "y": 220, "at": "2026-11-24T10:00:00.000Z" },
    "1f0e4d1a-0000-4000-8000-000000000001": { "removed": true, "at": "2026-11-24T10:05:00.000Z" }
  },
  "roomAt": "2026-11-24T09:58:00.000Z",    // when `room` was last set (import, rename, merge)
  "titleAt": "2026-11-24T09:58:00.000Z",   // when `title` was last set
  "createdAt": "2026-11-24T09:58:00.000Z",
  "updatedAt": "2026-11-24T10:05:00.000Z"
}
```

- **The room is a field, not part of the id.** This is how the design is "keyed to the room
  path": the head carries the path, exactly as a device does (ADR 0021), and layouts are found
  by the room's folded key (`roomPathKey`, `isWithinRoom`), in memory. An id derived from the
  path would break on the first rename, and ADR 0021 already identifies a room by its key, not
  its text.
- **The covered subtree is the room and everything under it.** A layout for `Ground Floor`
  lists `Ground Floor/Kitchen` and `Ground Floor/Hall` devices as candidates.
- **Coordinates are SVG user units of the plan's `viewBox`**, the centre of the marker, rounded
  to two decimals and clamped into the `viewBox`. User units survive any rendering size, and
  they are what a reader of the exported file expects to find.
- **`removed` is a tombstone, kept.** Without it, an older replica that still has the placement
  would bring a removed device back in a merge. One entry per device at most, so it costs
  nothing. It is pruned only when the device itself is deleted.
- **The head is untrusted on read.** Any member's client, or a direct CouchDB write, may have
  produced it. A read validates: `room` against `roomPathProblem`, `title` length, `viewBox`
  four finite numbers with positive width and height, each placement key a device id part (letters, digits, `-` and `_`, as `deviceHref` checks), each `x`/`y`
  finite. An invalid entry is dropped from the read, never "repaired" on disk. An invalid head
  is listed as "This plan cannot be shown" with Delete.

#### `drawing:<uuid>` — the drawing (fetched on demand)

```jsonc
{
  "_id": "drawing:3b0c6f0e-6c1d-4c84-9a5e-2f9d8f3e7a10",
  "type": "layoutDrawing",
  "layoutId": "layout:3b0c6f0e-6c1d-4c84-9a5e-2f9d8f3e7a10",
  "wovenFrom": "sha256-<base64>",    // hash of everything woven.svg was generated from
  "_attachments": {
    "plan.svg":  { "content_type": "image/svg+xml", "data": "…" },  // sanitised at import; never changes
    "woven.svg": { "content_type": "image/svg+xml", "data": "…" }   // generated; rewritten on save
  }
}
```

- **`plan.svg` is the original, as sanitised at import.** The bytes the user uploaded are never
  stored unsanitised, so no replica, backup or export ever holds the hostile version. Apart
  from what the sanitiser removed, it is the user's file, unmodified.
- **`plan.svg` is immutable.** Nothing rewrites it after import, so it cannot conflict.
- **`woven.svg` is derived.** It is `plan.svg` plus one generated group (see *The woven copy*).
  The head is the truth for positions; `woven.svg` is the artifact. A missing or stale
  `woven.svg` is regenerated, never treated as data loss.
- **`drawing:` sorts outside `device:` and `layout:`**, so no existing ranged read sees it, and
  the replication selector can name it by prefix.

### Replication: the routine pull leaves drawings out

The live sync (`replicateProject`, `local.sync(remote, …)`) gets a pull-only selector:

```js
local.sync(remote, {
  live: true,
  retry: true,
  pull: { selector: { _id: { $not: { $regex: '^drawing:' } } } },
})
```

- **It filters on `_id`, not on `type`.** A deletion tombstone is `{_id, _rev, _deleted}` with
  no `type`. A `type`-based selector such as the spike's `{"kind": {"$ne": "layout"}}` risks
  filtering out *every* tombstone, device deletions included, if Mango's `$ne` does not match a
  missing field. Nobody would notice until a deleted device came back. The `_id` form has no
  such case. PR 2 measures both against CouchDB 3.5.2 and pins the result in a test.
- **The push stays unfiltered.** A writer's new or regenerated drawing must reach the server.
- **Changing the filter changes the replication id**, so each client's first sync after PR 2
  walks the changes feed again from zero. Nothing is re-downloaded (`revs_diff` answers "have
  it"), but the walk costs time once per project. Accepted.
- **This is not a security boundary.** ADR 0003 holds: a member who can read the database can
  read the drawings. The filter is about bandwidth, nothing else.

#### Fetching a drawing on demand

- **Opening a layout** whose drawing is not local runs a one-shot pull with
  `doc_ids: ['drawing:<uuid>']` (the existing `pullOnce`, extended with `doc_ids`). The page
  shows the head straight away (title, room, placed devices as a list) and
  "Downloading the plan (412 KB)…" from `plan.bytes`.
- **Offline, not yet fetched:** the same page, with "The plan downloads the next time this
  device is online." The device list beside it still works, because placements live in the
  head.
- **Once fetched, it stays.** It is an ordinary local document from then on, available offline.
  There is no eviction: a local delete would replicate as a real deletion. Clearing space means
  removing the project from the device, as today.
- **"Download plans for offline use"** on the Rooms page pulls every drawing of the project in
  one one-shot pull. It is for the person about to walk into a basement.
- **A local drawing is not refreshed on open.** `plan.svg` never changes, and the in-app view
  never renders `woven.svg` (see *Viewing*), so a refresh would buy nothing. It is refreshed
  before a save regenerates `woven.svg` (when online, best effort), and before an export.
- **A head deleted elsewhere** leaves a local drawing nobody can reach. The conflict watcher sees
  the head's deletion arrive and deletes the local drawing too. If the server already deleted
  it, the result is two deletions, which do not conflict in any way that matters.

### Who writes what, and how conflicts resolve

| Event | Head | `woven.svg` |
|---|---|---|
| Import | Created | Created: the plan plus an empty device group |
| Save in the placing view | Placements written | Regenerated in the same save, drawing first |
| Device renamed, moved within the subtree, made a draft or completed | Nothing | Stale; regenerated lazily (below) |
| Device moved out of the subtree | Nothing | Stale; the marker disappears from the view at once, the entry is pruned at the next save |
| Device deleted | Nothing | Stale; the entry is pruned at the next save |
| Room renamed or merged | `room` rewritten, as part of the rename | Not touched; the room is not in the woven ids |
| Layout deleted | Deleted | The drawing is deleted first |

**Nobody rewrites a 1 MB attachment because a device changed.** A device edit happens on
devices that may not have the drawing, and it would fan one rename out into one plan revision
per layout. Instead:

- **`wovenFrom` says whether `woven.svg` is current.** It is the SHA-256 (WebCrypto) of the
  weave format version, `plan.digest`, and, for every visible placement sorted by device id,
  the coordinates and the woven device fields. The same inputs give the same hash and, because
  generation is deterministic (sorted, fixed number formatting), the same bytes.
- **A writer regenerates lazily** when it opens a layout, has the drawing, is unlocked, and
  computes a `wovenFrom` that differs from the stored one. It also does so at every save.
  Read-only members, locked projects and devices without the drawing never write it.
- **An export never uses stored bytes as they are.** Export always weaves in memory from the
  re-sanitised plan, the head and the live devices (see *Export*). It writes the result back
  only if this device would regenerate it anyway.
- **This converges.** Two writers with different, not yet synced device data may each write a
  `woven.svg`. Once their devices sync, both compute the same hash, and one of them stops
  writing.

**Conflicts:**

- **Head:** merged by the conflict watcher (`data/conflicts.ts`, strategies in
  `domain/sync/merge.ts`), like a device. `room` and `title` are last-write-wins **per field**, by
  their own timestamps `roomAt` and `titleAt`, not by `updatedAt`. A placement save never
  touches either timestamp. Otherwise a placement save made on a replica that still had the old
  room would carry a newer `updatedAt` than an offline rename, win the merge, and silently move
  the plan back to the old room. `placements` is a union by device id, and each entry, including a
  `removed` tombstone, is last-write-wins by `at`. **A tie is broken by the entry itself,**
  never by the head that carries it: a merged head keeps the `updatedAt` of its newest input,
  so a key taken from the head would change under an unrelated merge, and two replicas could
  keep different positions for one device. A tombstone beats a placement at the same `at`;
  between two placements, the larger `x`, then the larger `y`, wins. `room` and `title` ties
  likewise go to the larger value by code-point order. Every rule depends only on the values
  compared, so the merge is commutative and associative. Losing revisions are deleted.
- **Drawing:** `plan.svg` cannot conflict. A `woven.svg` conflict is a conflict between two
  derived values. The watcher keeps CouchDB's winner, deletes the losers and, if the winner's
  `wovenFrom` is stale, regenerates as above. Drawings are not pulled live, so a server-side
  drawing conflict waits until some client fetches that drawing. Until then it costs one extra
  stored attachment and nothing else.
- **Head deleted on one device, edited on another:** CouchDB lets the edit win, so the head
  comes back, but its drawing may be gone. The view then says "The drawing of this plan was
  deleted on another device" and offers Delete.

### Rooms

- **A room exists through its devices and its layouts.** `roomsOf` also reads layout heads, so
  a writer can import a floor plan before any device is filed under that floor, and a room keeps
  existing while a plan points at it. This amends ADR 0021's "derived from its devices"
  (recorded in ADR 0023). The heads are local, so this stays an in-memory derivation.
- **Rename and merge rewrite heads too.** `renameRoom` plans device writes for the subtree. It
  now also plans head writes (`room` only). Heads are always local, so a rename works offline
  and does not touch the drawing. The rename stays planned from what was read and safe to retry
  after a partial failure.
- **There is still no room delete.** A room with only a plan in it goes away when the plan is
  deleted.

### Import

Reached from the Rooms page: each room's menu gets **Add a plan**. A `<wa-dialog>` holds a file
input (`accept=".svg,image/svg+xml"`), the title (default: the room's last segment + " plan"),
and the room (preset, changeable with the existing room input and its spelling reuse).

Checks, in this order, each with its own message:

| # | Check | Rejected when |
|---|---|---|
| 1 | Size, before reading | The file is over **2 MiB** (2,097,152 bytes). The spike's largest ordinary detailed plan was 907 KB. 2 MiB leaves room for that. Both attachments base64-encoded in one replicated document come to about 5.6 MB, under CouchDB's default `max_document_size` of 8 MB. |
| 2 | Encoding | Not valid UTF-8 (`TextDecoder` with `fatal: true`), or an XML declaration naming another encoding |
| 3 | Well-formed | `DOMParser` (`image/svg+xml`) yields a `parsererror` |
| 4 | Root | The document element is not `svg` in the SVG namespace |
| 5 | No DTD | Any `<!DOCTYPE>`. It is the vehicle for entity expansion and external entities, and a plan does not need one |
| 6 | Size of the tree | More than 100,000 elements, or nesting deeper than 64. After sanitising, also more than 100,000 instances with every `<use>` expanded, or a `<use>` cycle: 61 nested uses can expand to a million instances |
| 7 | Geometry | No usable `viewBox`, and `width`/`height` cannot supply one (unitless or `px` only). A width or height that is zero, negative or not finite |
| 8 | Sanitise | See below. **Stripping is not rejection**: a CAD export with metadata the sanitiser removes still imports |
| 9 | Something left | The sanitised tree has no drawable element |

- **The dialog previews the sanitised plan** and says what was removed, as counts ("Removed: 2
  scripts, 1 external image, 14 event handlers"), so a person whose plan looks different knows
  why.
- **The `viewBox` is normalised** onto the root: synthesised from `width`/`height` when absent.
  `width`/`height` are then removed and `preserveAspectRatio` is set to `xMidYMid meet`, so the
  plan scales to its container.
- **Saving writes the drawing, then the head.** If the head write fails, the drawing is deleted
  again, so no drawing exists without a head (the archive import's "all or nothing" rule). A
  refused write (quota, locked project) uses the existing storage-refusal messages.
- After saving, the app opens the new layout in placing mode.
- **Writers only.** The action is hidden for read-only members, and the repository refuses
  anyway.

### Sanitising

Sanitised **at import, and again at every render**. The PO decision says "once at import", and
that is not enough on its own: a drawing that arrives by replication was written by *some*
member's client, or by a direct CouchDB write, and must be treated as untrusted. Sanitising a
1 MB plan takes milliseconds, and a render happens once per view.

`ui/layouts/sanitise.ts` exposes one function, `sanitisePlan(bytes): SanitisedPlan`: either
`{ ok: true, svg: SVGSVGElement, viewBox, removed: RemovedCounts }` or `{ ok: false, problem }`
naming the import check (1–7, 9) that failed. It takes bytes, not text, because checks 1 and 2
are about bytes, and refuses with a value, not an exception, so the dialog can say which check.
It runs the DOCTYPE check (5) on the text before parsing, since parsing is what a DTD attacks.
Until PR 6 imports it, `frontend/scripts/awaiting-consumer.json` lists it, so `check:graph`
does not report it and `check:lazy-svg` asserts DOMPurify is in no chunk at all.
DOMPurify does the work, configured with its SVG and SVG-filter profiles and XML parsing of the
input. On top of the profile:

- **Removed elements:** `script`, `foreignObject`, `iframe`, `embed`, `object`, `audio`,
  `video`, `animate`, `animateMotion`, `animateTransform`, `set`, `discard`, `a`'s link (the
  element is unwrapped, its children kept), and any element outside the SVG namespace.
- **Removed attributes:** every `on*` handler, and any attribute whose value contains
  `javascript:`, `vbscript:` or `data:` other than an allowed raster image.
- **`href` and `xlink:href`** keep only a local fragment (`#id`). On `<image>` they also keep
  `data:image/png`, `data:image/jpeg`, `data:image/webp` and `data:image/gif`. Never
  `data:image/svg+xml`, which would be a plan inside the plan, unsanitised.
- **`<style>` elements and `style` attributes are kept**, because Illustrator and Inkscape
  exports style by class and a plan without them renders as black shapes. Their CSS is filtered:
  every at-rule is dropped (`@import`, `@font-face`, `@namespace` …), and any declaration with a
  `url(` that is not `url(#…)` is dropped. So are `expression(`, `behavior` and `-moz-binding`.
- **Reserved names are ours.** Any `id` or `class` beginning with `mm-`, and any `data-mm-*`
  attribute, is removed from an imported plan, so the woven group's names cannot be forged by
  the plan or collide with it.

The sanitised tree is **inserted as nodes** (`importNode`), never serialised and parsed again as
HTML. That avoids the mutation-XSS class entirely. It goes into its own shadow root, inside a
`<mm-plan-canvas>` element that holds nothing else. An SVG `<style>` in an HTML document is
otherwise global: a plan's `rect { display: none }` would hide the application. The shadow root
scopes its CSS to the drawing and its ids to the drawing. The markers live outside that shadow
root, so the plan's CSS cannot reach them.

A shadow root scopes selectors, not layout. A plan's `svg { position: fixed; z-index: … }` would
still lay the drawing over the whole application, and `:host { … }` would style the element
around it, which is enough to draw markers that are not ours (security review of #367). Two
layers stop it:

- **The sanitiser** drops every rule with a `:host`, `:host()`, `:host-context()`, `::slotted` or
  `::part` selector, and keeps only an allow-list of paint, text and geometry properties.
  `position`, `z-index`, `inset`, `top`/`left`/`right`/`bottom`, `width`, `height` and `overflow`
  are not on it, and no value may use viewport units. The same applies to the root's own `style`.
- **`<mm-plan-canvas>`** (PR 6) contains whatever gets through: the host has
  `contain: strict; overflow: clip; isolation: isolate`, and its shadow stylesheet carries
  `:host > svg { position: static !important }`.

**Serialising a plan** (the stored `plan.svg`, the woven copy, the downloads) uses
`XMLSerializer` only, never `outerHTML` or `innerHTML`. Those serialise as HTML, and HTML
serialisation of foreign content is where mutation XSS comes from.

**A stored `woven.svg` is never trusted, rendered or exported as it is.** Any member can write a
drawing whose device group is forged: links elsewhere, markers that lie. So the device group is
something only `weave` produces, and only from trusted inputs:

- **`sanitisePlan` removes the whole device group**, like any other `mm-` name, together with
  every `<a>` link. A stored `woven.svg` that passes through it comes out as the plan without
  markers. Forged or genuine, the stored group carries no weight.
- **Markers come only from `weave(sanitisePlan(plan.svg), head, live devices)`.** Wherever a
  woven SVG is shown (any future "show the file" view) or downloaded, it is woven again in
  memory from those inputs. The stored copy is for readers outside the app, such as someone
  reading CouchDB directly.
- **`weave` checks its own output** before returning it (`checkWovenGroup`, defence in depth).
  The group may contain only `g`, `a`, `title`, `desc` and `circle`, only the attributes listed
  in *The woven copy*, and every `href` must equal `deviceHref` of its `data-mm-device`.
  Anything else is a generator bug and throws.
- Tests pin both halves: `sanitisePlan(weave(p))` equals `sanitisePlan(p)` for every fixture (the
  sanitiser removes the group completely), and a hand-forged group with a `javascript:` link
  and an `onclick` inside a drawing is removed by the sanitiser.

### The woven copy

`ui/layouts/weave.ts`, `weave(planText, devices, placements): string`. It parses `plan.svg`,
appends one group as the root's last child (so it paints on top), and serialises with
`XMLSerializer`.

```xml
<g id="mm-devices" data-mm-format="1" data-mm-layout="3b0c6f0e-…">
  <a href="#/devices/6ba7b810-9dad-11d1-80b4-00c04fd430c8"
     data-mm-device="6ba7b810-9dad-11d1-80b4-00c04fd430c8"
     data-mm-room="Ground Floor/Kitchen" data-mm-device-type="266">
    <title>Kitchen ceiling light</title>
    <desc>Extended Color Light · Ground Floor/Kitchen</desc>
    <circle cx="412.5" cy="220" r="8" fill="#1f6feb" stroke="#ffffff" stroke-width="2"/>
  </a>
  <a href="#/devices/1f0e…" data-mm-device="1f0e…" data-mm-status="draft" …>
    <title>Hall sensor (draft)</title>
    …
    <circle … stroke-dasharray="4 2"/>
  </a>
</g>
```

- **Woven fields, and only these:** the device UUID, `name`, `room`, `deviceTypeId` and the
  catalogue's product name when known (as the `<desc>` label), the draft status, and the
  position. The input is a dedicated type, `WovenDevice`, built by a projection that names its
  fields (a `Pick`, not a spread). A new device field therefore never reaches the woven copy by
  accident.
- **Nothing encrypted, ever.** `payload` and `manualCode` are not in `WovenDevice` and cannot be
  added without changing the type. `serial` and remarks are left out too: they are plaintext
  in the database, but the woven copy is made to travel, and they are not needed to find a
  device on a plan. A test weaves a fixture device whose every field is set and asserts the
  output contains neither code, in any form (`MT:` payload, 11- or 21-digit manual code, with
  or without dashes), nor the serial.
- **Markup is never built from strings.** Every element comes from `createElementNS`, every
  attribute from `setAttribute`, every text from `textContent`, so `XMLSerializer` does the
  escaping. Names are cleaned first: characters XML 1.0 forbids (C0 controls other than tab,
  newline and carriage return, U+FFFE, U+FFFF, lone surrogates) are removed, because
  `XMLSerializer` would otherwise write a file no XML parser accepts. Names are capped at 200
  characters.
- **Links are same-origin fragments, built by one function.** `deviceHref(uuid)` returns
  `#/devices/<uuid>` (the route the device list links to) and throws unless the UUID matches
  `^[A-Za-z0-9_-]+$` (DATA-MODEL, *A device id holds only letters, digits, `-` and `_`*). The
  generator has no other way to write an `href`. A device whose id fails the check is left out
  of the weave and logged by id, never by name.
- **The exported file keeps those relative links.** Inside the app they open the device. Outside
  it they go nowhere, harmlessly, and the file is still useful: every marker carries its name in
  `<title>` (a tooltip in every viewer), its room and type in `<desc>`, and machine-readable
  `data-mm-*` attributes. An absolute link would also need a project in the URL, and the route
  has none.
- **Self-contained, and immune to the plan's CSS.** No `<style>` and no class. The plan's own
  `<style>` stays in the file, since the plan needs it, and a rule such as `g { display: none }`
  or `* { fill: none !important }` would otherwise reach the markers too. So the group, every
  `a` and every `circle` carry an inline `style` that sets every property the markers depend on
  with `!important`: `display`, `visibility`, `opacity`, `fill`, `stroke`, `stroke-width`,
  `stroke-dasharray`, `transform` and `pointer-events`. In the cascade, an inline `!important`
  declaration beats any `!important` declaration from a stylesheet. Presentation attributes
  carry the same values, for viewers that ignore CSS.
- **The marker radius** is 1 % of the shorter `viewBox` side, so markers scale with the plan.
- **Drafts are woven**, with `data-mm-status="draft"`, "(draft)" in the title and a dashed
  outline, following the 2026-11-24 decision that drafts are shown everywhere. If #358's final
  design keeps drafts out of exports, the weave uses the same predicate as the other exports.
  There is one place to decide it, not two.

### Viewing

Route `#/layouts/:id` (the UUID), view `layout`, lazily loaded like every non-landing view
(`check:lazy`, `check:routes`). The Rooms page lists each room's plans, and a device page lists
the plans it is placed on.

- **The view renders `plan.svg`, never `woven.svg`.** Markers come from the head and the live
  device documents, so a rename or a draft completed elsewhere shows at once, whether or not
  anyone has regenerated `woven.svg` yet. The woven copy is the artifact for leaving the app;
  in the app, the data is fresher than any file.
- **Markers are DOM, over the plan.** A layer is absolutely positioned over
  `<mm-plan-canvas>`, whose box has `aspect-ratio: <viewBox width> / <viewBox height>`. With
  `xMidYMid meet` and that box, user units map linearly to percentages:
  `left = (x − minX) / width × 100 %`. No transform matrix, and the markers stay right at any
  size.
- **In view mode a marker is a link** (`<a href="#/devices/<uuid>">`), at least 24 × 24 CSS px
  (WCAG 2.5.8). Its accessible name is the device name, with ", draft" for a draft. Markers come
  in name order in the DOM, so Tab walks them predictably rather than in drawing order.
- **The plan itself** is `role="img"` with the layout title as its label. Beside it, or below it
  on a phone, the same devices are listed as ordinary links. Anyone who cannot use the picture
  loses nothing.
- **A draft marker** uses Web Awesome's warning tokens, has a dashed outline and carries a
  "Draft" `<wa-tag>` in the side list. It is never marked by colour alone (WCAG 1.4.1). Marker
  colours meet 3:1 against their halo (WCAG 1.4.11), and the halo keeps them visible on any plan.
- **Devices in the subtree without a placement** are listed under "Not on the plan".

### Placing

**Place devices** switches the same view into placing mode (writers only, unlocked only). The
working set is in memory. Nothing is written until **Save**, which writes the drawing
(`woven.svg` regenerated), then the head. Leaving with unsaved changes asks first.

Pointer:

- **Drag a marker** to move it.
- **Single-pointer alternative** (WCAG 2.5.7 Dragging Movements): select a device in the list,
  or a marker, and then click or tap a point on the plan. Placing never *requires* a drag.

Keyboard (WCAG 2.1.1, 2.4.7, 2.4.11):

- Every device in the subtree is a button in the side list: **Place**, or **Move** if placed.
  Activating it selects the device. An unplaced device appears at the plan's centre.
- With a marker selected (it has focus, and a visible ring that the plan cannot cover):
  - **Arrow keys** move it by 1 % of the `viewBox`, **Shift + arrow** by 10 %.
  - **Enter** confirms, **Escape** returns it to where it was.
  - **Delete** or **Backspace** removes it from the plan (a `removed` tombstone on save).
- **Every move is announced** in a polite live region (WCAG 4.1.3): "Kitchen ceiling light,
  40 % across, 25 % down". When the room-outline PR has landed, the announcement also names the
  outline under the marker ("in Kitchen").
- Markers in placing mode are `<button>`s with the same 24 px minimum target, so Tab, Enter and
  Space behave as people expect.
- Zoom in v1 is the browser's own. Pan and zoom controls are a later issue, not part of this
  feature.

**Pointer to user units:** `x = minX + (clientX − box.left) / box.width × width`, the same
linear map in reverse, rounded to two decimals and clamped into the `viewBox`.

### Export

The layout's ⋯ menu:

- **Download plan with devices**: always woven in memory as
  `weave(sanitisePlan(plan.svg), head, live devices)`, as `<project> – <title>.svg`. The stored
  `woven.svg` is never downloaded as it is: its bytes may come from a member's direct CouchDB
  write.
- **Download original plan**: `plan.svg` passed through `sanitisePlan` again and serialised.
  The stored bytes were sanitised at import, but by *some* client, so the export does not take
  that on trust any more than the view does.

Both are built as a `Blob` and downloaded through an object URL, as the existing exports are.

- **A locked project may export a layout.** ADR 0022's "nothing exports a locked project"
  exists because a locked read lacks the setup codes, so an export would be silently
  incomplete. A layout never contains codes, so the reason does not apply. ADR 0023 records the
  exception.
- **The project archive** (zip export) **does not include layouts in v1.** Adding them is a
  format version 2 (PR 9): `layouts/<uuid>.json` (the head) and `layouts/<uuid>/plan.svg`.
  `woven.svg` is left out, since it is derived. The import re-runs the full import checks on
  each plan, and the export applies the same limits first (lesson L46). Until PR 9, the export
  dialog says that plans are not in the archive.

### Encryption and privacy

- **Heads and drawings are plaintext.** This is consistent with ADR 0022, which encrypts the
  two code fields and leaves the inventory readable. A floor plan with the devices on it is a
  sensitive picture of a home. It is exactly as exposed as the device list, room names
  included, already is, and ADR 0005's controls (TLS, encrypted volumes and backups, Fauxton
  blocked) apply. If plans ever need encrypting, AES-GCM over the attachment bytes with the
  project DEK is a contained change. ADR 0023 names that as its revisit condition.
- Locked and keyless projects can view layouts, since nothing in them is encrypted. Every write
  is refused, as for any document (`ProjectLockedError`).
- A plan's content, title and device names are never logged. Logging uses ids.

### CSP and probes

- **The Content-Security-Policy does not change.**
  - `img-src 'self' data: blob:` covers raster `data:` images inside a plan.
  - `style-src 'unsafe-inline'` already allows the plan's `<style>`, which the CSS filter and
    the shadow root contain.
  - Nothing a plan could reference is cross-origin once sanitised, and `default-src 'none'`
    catches what the sanitiser might miss.
- **`script-src` without `'unsafe-inline'` becomes load-bearing**, as the PO decision accepted.
  `check:deploy` already refuses `'unsafe-inline'`, `'unsafe-eval'` and `*` in `script-src`.
  The comment above that list in `frontend/scripts/check-deploy-headers.mjs`, and the CSP comment in
  `frontend/public/_headers`, gain one line naming layouts as the second reason. The next person who
  wants to relax it then learns what it protects.
- **`probe:svg` goes into CI** in PR 5, as the spike said it should once something renders a
  plan.
  - It gains a fifth render mode: **inline after `sanitisePlan`, with no policy at all**. That
    row must show nothing ran and nothing was fetched. It is the sanitiser's own proof,
    independent of the CSP.
  - The four existing rows stay: the policy's proof, independent of the sanitiser.
  - Both must hold. The probe fails if either does not, and if the control run reaches the
    second origin not at all.
- **`probe:runtime`** gains a step that opens a fixture layout. The layout view must make zero
  cross-origin requests.

## Test plan

| Layer | What | Where |
|---|---|---|
| Domain (node) | Head validation: every malformed field dropped, a valid head unchanged | `test/domain/layouts/head.test.ts` |
| Domain | Placement merge: union, last-write-wins per entry, tombstone beats an older placement, idempotent and commutative. Two placements with equal `at` merged in both orders, with an unrelated head merged in between, end at the same position. A room renamed offline on one replica survives a later placement save on another replica that still had the old room (`roomAt` decides, not `updatedAt`); the same for `title` | `test/domain/sync/merge.test.ts` |
| Domain | `WovenDevice` projection: a device with every field set yields exactly the allowed fields | `test/domain/layouts/project.test.ts` |
| Domain | `roomsOf` with heads; `renameRoom` plans head writes for the subtree and nothing outside it; retry after a partial rename | `test/domain/rooms/*.test.ts` |
| Data (node, memory PouchDB) | Layout repository: create drawing then head, rollback on head failure, refused when locked; on-demand pull by `doc_ids`; local drawing deleted when the head's deletion arrives | `test/data/layouts.test.ts` |
| Data | Pull selector with PouchDB→PouchDB: devices, heads and **device tombstones** replicate, drawings do not | `test/data/replication-selector.test.ts` |
| CouchDB contract | The same selector against real CouchDB 3.5.2 `_changes?filter=_selector`, tombstones included, and the measured result for a `type`-based selector | CI couch-smoke job, or the backend contract suite |
| Browser | Sanitiser: the spike's hostile SVG plus a corpus (event handlers, `javascript:` and `data:text/html` hrefs, `<animate>`/`<set>` rewriting `href`, `foreignObject`, external `<use>`/`<image>`, `@import`, `url()` in style, nested `data:image/svg+xml`, `mm-` names, DOCTYPE entities). Each is removed and counted | `test/ui/layouts/sanitise.browser.test.ts` |
| Browser | Sanitiser keeps real plans intact: the six spike plans render with the same element count, minus what is listed as removed | same |
| Browser | Weave: a name with `</title><script>`, `"&<>`, a C0 control, 300 characters, right-to-left text; the output parses as XML, round-trips the name, and passes `checkWovenGroup`; `sanitisePlan(weave(p))` equals `sanitisePlan(p)`; a forged group in a stored drawing is removed; deterministic bytes; no code or serial in the output. A plan whose `<style>` holds `g, a, circle { display: none !important; fill: none !important }` still shows every marker in the woven file, measured with `getComputedStyle` and `getBBox` | `test/ui/layouts/weave.browser.test.ts` |
| Browser | Export: both downloads are produced from `sanitisePlan` output; a stored drawing with a hostile `plan.svg` and a forged `woven.svg` downloads clean | `test/ui/layouts/export.browser.test.ts` |
| Browser | Import checks 1–9, each with its message | `test/ui/layouts/import.browser.test.ts` |
| Browser | Coordinate maps both ways, at three container sizes and a non-zero `viewBox` origin | `test/ui/layouts/geometry.browser.test.ts` |
| Browser | Placing by keyboard: select, arrows, Shift+arrows, Enter, Escape, Delete; live-region text; Tab order is name order | `test/ui/views/layout.browser.test.ts` |
| Browser | Draft marker: dashed, labelled, listed with a tag | same |
| Probe | `probe:svg` five modes; `probe:runtime` with a layout | CI |
| E2E | Import a fixture plan → place two devices by keyboard → save → reload offline → markers still there → export → the downloaded file has two `<a>` with `#/devices/` links and no code | `e2e/layouts.spec.ts` |
| Manual, once per PR 6 and PR 7 | VoiceOver on iOS Safari and NVDA on Firefox: open a plan, find a device, place one, hear the announcement | PR description |

## PR sequence

Each PR leaves `main` releasable and is verifiable on its own.

1. **This spec and ADR 0023.** Docs only.
2. **Replication selector.** The pull selector, `pullOnce` with `doc_ids`, and the selector
   tests, including the CouchDB contract measurement of tombstones. No layout code. Verified by:
   devices, heads and deletions still sync; a hand-made `drawing:` document does not.
3. **Domain: heads, merge, projection.** `domain/layouts/`, the head validation, the placement
   merge in `domain/sync/merge.ts`, `WovenDevice`, and `roomsOf`/`renameRoom` reading heads.
   Pure functions, node tests only.
4. **Data: layout repository.** Head and drawing reads and writes with attachments, the
   import's write order and rollback, on-demand fetch, the conflict watcher for `layout:` and
   `drawing:`, and Rooms-page rename writing heads. No UI beyond the rename already present.
5. **Sanitiser.** DOMPurify added (`dependency-policy.json`, ADR 0013's table),
   `ui/layouts/sanitise.ts` and its corpus, `probe:svg`'s fifth mode, `probe:svg` wired into
   CI, the CSP comment lines. Verified by the corpus and the probe. Nothing renders a plan yet.
6. **Import and view.** The Rooms-page action and dialog, import checks, `#/layouts/:id` with
   `<mm-plan-canvas>`, view-mode markers, the side list, drafts marked, the "downloading" and
   "offline" states, "Download plans for offline use", the device page's list of plans it is on. `probe:runtime`
   with a fixture layout. `<mm-plan-canvas>` contains the plan (`contain: strict; overflow: clip;
   isolation: isolate`, and `:host > svg { position: static !important }` in its shadow
   stylesheet; see *Sanitising*). `probe:svg`'s sanitised mode then renders through it. This PR
   removes `layouts/sanitise.ts` from `frontend/scripts/awaiting-consumer.json`.
7. **Placing and the woven copy.** `weave.ts`, placing mode (pointer, single-pointer,
   keyboard, live region), save writing drawing then head, lazy regeneration, the e2e journey
   up to "reload offline".
8. **Export.** Both downloads, the stale-in-memory regeneration, the locked-project exception,
   the e2e journey's export step.
9. **Project archive v2 with layouts.** Optional, after 8.
10. **Room outlines.** Tag a shape in the plan as a room's outline (an `outlines` map in the
    head, `data-mm-room` in the woven copy), select a room by tapping it, name the outline in
    placing announcements. A separate issue, opened when 8 merges.

## Left to the builder

- The exact DOMPurify configuration and hook code, provided the corpus in the test plan passes
  and the probe's fifth mode is clean.
- Whether the CSS filter is a small tokenizer or DOMPurify's own hooks, under the same tests.
- Marker visuals within the design system (`--wa-*` tokens, `DESIGN.md`). Load the
  `webawesome-design` and `webawesome` skills first.
- The wording of every message, through `@lit/localize`.
