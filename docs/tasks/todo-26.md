# Todo — #26 · M2-9 Timestamped remarks

Branch: `26-timestamped-remarks`

## Acceptance criteria (from the issue)

```gherkin
Scenario: a remark is added
  When I add a remark
  Then it is stored in the device record with a timestamp and author
  And existing remarks are never modified

Scenario: remarks read newest first
  Then remarks display in reverse chronological order
```

Out of scope: editing or deleting a remark. Append-only.

## What already exists

`Remark`, `RemarkBearing` and `mergeRemarks` were written at M1 for the conflict merge
(ADR 0010). The document field is in place and the merge unions by id. Missing is the
operation that appends one, and the UI that shows them.

## Plan

### core
- [x] `documents/remark.ts`
  - [x] `RemarkAuthor` — `{ sub, name }`, the two identity fields a `Remark` stores
  - [x] `addRemark(device, text, author, clock)` → `Unsaved<DeviceDocument>`; appends, carries
        every existing remark through by reference, throws `DraftError('remark', …)` on blank
  - [x] `remarksNewestFirst(remarks)` — display order, separate from the merge's storage order
- [x] `DraftField` gains `'remark'`
- [x] Export from `index.ts`, extend `public-api.test.ts`

### web
- [x] `identity.ts` — `currentAuthor()`, the single seam M4 replaces with the signed-in user
- [x] Device view: remark composer (textarea + button) and the list, newest first
- [x] Storage refusal reported beside the composer, text kept so it is not lost
- [x] Strings through `msg()`, German written, `npm run i18n`

### Tests (each observed failing first)
- [x] core: appends with the injected timestamp, uuid and author
- [x] core: existing remarks are identical objects afterwards (never modified)
- [x] core: blank / whitespace-only text rejected, field named
- [x] core: `updatedAt` not supplied by the planner (repository owns the stamp)
- [x] core: `remarksNewestFirst` reverses chronologically and breaks ties deterministically
- [x] web: typing a remark and pressing add stores it and renders it at the top
- [x] web: a second remark appears above the first
- [x] web: a refused write says so and keeps the typed text
- [x] web: navigating between devices does not carry a composer's text or a stale list

## Review

**Both scenarios met.** A remark is stored with `createdAt`, `authorSub` and `authorName`;
existing remarks are carried through by reference and asserted identical afterwards; the list
renders reverse-chronologically.

**Two decisions worth recording.**

*The author's name is stored, not resolved.* `Remark` carries both `authorSub` and
`authorName`, which looks like duplication and is not: the subject claim is the stable
identity, and the display name is what a reader needs years later when the person has left the
project and no lookup resolves the claim to anything. Until M4 there is no signed-in user, so
`currentAuthor()` returns `{ sub: 'local', name: '' }` — an empty name rather than a
translated "You", because `authorName` is stored verbatim and never re-resolved, and a
translated string would put one reader's language permanently into another reader's document.
The view says "Recorded on this device" in the reader's own language instead.

*Display order is a second function, not a reversed store.* `mergeRemarks` sorts oldest-first
because that is the order two replicas must agree on. `remarksNewestFirst` is the exact
reverse of it, tie-break included, so the page is a reversal of storage rather than an order
of its own.

**One dead line found by the mutation probe.** `willUpdate` originally cleared the composer on
a route change. The probe reported it SURVIVED, and it was right: `willUpdate` runs before the
render, so it cleared a control that was about to be discarded anyway — clearing `loaded`
unmounts the composer and the next device renders a fresh, empty one. The line was removed and
replaced with a comment saying why nothing is needed there. The test stays: it asserts the
behaviour, which still has to hold whatever the mechanism.

Probes: 10/10 caught in `core/documents/remark.ts`, 4/4 in the web view (the fifth mutation
no longer has a line to mutate).
