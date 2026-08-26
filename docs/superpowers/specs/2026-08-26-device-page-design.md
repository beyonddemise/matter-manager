# Showing a device and reproducing its QR — design

Date: 2026-08-26
Issue: [#24 M2-7](https://github.com/beyonddemise/matter-manager/issues/24)
Status: proposed

## The one scenario that matters

> a QR rendered from a stored payload decodes back to identical field values

Everything else on this page is convenience. If the code that comes off the screen is not the
code that went onto the label, the product has no reason to exist — and the failure is silent,
because a wrong QR looks exactly like a right one.

So the test decodes **the pixels actually rendered**, not the property that was set:

```ts
const canvas = qr.shadowRoot.querySelector('canvas')
const text = new BrowserQRCodeReader().decodeFromCanvas(canvas).getText()
expect(decodePayload(text)).toEqual(decodePayload(device.payload))
```

`expect(qr.value).toBe(device.payload)` would pass against a component that drew nothing at all.

### Why zxing rather than `BarcodeDetector`

The platform has a QR decoder, and it is the obvious choice until you check where it exists:
present in Chromium on macOS, absent on Linux. A test built on it would pass on a laptop and
fail or vanish on CI. This repository has already been bitten once by a check that meant
different things in the two places (the `check:webawesome` gap, M2-3), so `@zxing/browser` —
already allowlisted for M2b-1's camera fallback — is used instead. Same result everywhere.

It is a devDependency for now: nothing in `src` imports it until the camera arrives.

## Two things about the QR that are not cosmetic

**Colour is pinned, not themed.** `<wa-qr-code>` takes its fill from `currentColor` and leaves
the canvas transparent, so in dark mode it renders light modules over a dark page. Many
scanners will not read an inverted code at all. `fill="black"` and `background="white"`, plus a
white plate for the quiet zone, are the only colours in the application that do not come from a
`--wa-*` token — because they are not decoration, they are what makes the thing scan.

**`error-correction="H"`, in writing.** Currently the component's default too. Written down so
a change to that default cannot quietly downgrade codes destined for labels inside fuse boxes:
H recovers from roughly 30% damage against about 7% at L, and a 19-character payload stays
small either way.

### The enlarged QR must be sized, not constrained

`<wa-qr-code>` writes `min-width: <size>px` onto its canvas as an **inline style**. No CSS from
outside the shadow root can beat that, so a code too big for its container is **clipped rather
than scaled** — and a clipped QR does not scan. At 420px in a phone-width dialog, it was.

The size is therefore computed from the viewport at the moment the dialog opens, in the module
where the pixel count already lives. It does not follow a resize while the dialog is open; that
leaves a code smaller than it could be, never a clipped one, so the residual failure is
cosmetic.

**There is no lower bound on that size, and that is deliberate.** The first version had one, on
the reasoning that below some size a code is too dense to scan and overflowing was the lesser
evil. That inverted the trade-off it was trying to make: a floor above the available width is a
code wider than its container, which is clipped and therefore unscannable, whereas a small
complete code usually still scans. The floor only ever fired in the case where it did the most
damage — below roughly 308 CSS pixels, which browser zoom reaches long before any phone does.

**No test in this repository can catch that clipping**, because the decode test reads the
canvas bitmap and CSS never touches a bitmap. It was found by opening the page at 360px, and
that is how it will be found again. Both the CSS and the design note say so, in the places
someone would go to "simplify" it.

## Reloading when the route changes

The shell renders **one** `<device-view>` and updates its `uuid`; Lit reuses the element rather
than constructing a new one per route. So loading in `firstUpdated` alone leaves the page
showing the device the user navigated *away* from — with a QR belonging to a different device,
and nothing on screen looking wrong. The read is driven from `willUpdate` on a `uuid` change
instead, which also clears the previous device before it can be rendered again, and closes an
open enlargement so the dialog's contents and its title cannot disagree.

Two navigations in quick succession put two reads in flight, and the disk decides which lands
first. A monotonic request token discards all but the current one; without it, an earlier read
arriving last settles the page on the device the user has already left — the same wrong-device
failure by a different route, and just as invisible.

Testing that guard needs the reads to finish out of order, which a real IndexedDB will not do
on its own. The test injects repositories that hold one id back, through the seam the view
already has — and it must be injected at construction, because the view resolves its
repositories once and caches them. An earlier version of that test assigned afterwards and
passed against a view with no guard at all.

## A device with no payload

`payload` became optional in M2-5: a device filed from a typed pairing code has none, and none
can be invented — a manual code carries only the top four bits of the discriminator, so a
reconstructed payload would encode cleanly and produce a QR that silently fails to commission.

The page says that, in a sentence, where the QR would be. An empty space would read as a bug;
the sentence reads as a fact, and it is immediately actionable because the pairing code beside
it commissions the device on its own — which is what a pairing code is for.

## Routing by uuid

`#/devices/<uuid>`, not `#/devices/device:<uuid>`. Document ids carry their type prefix so
`_all_docs` can range over them (M2-4); a URL does not need to, and `#/devices/device:3fa8…`
reads like a mistake. `core` owns both halves of the translation (`documentId`, `uuidOf`), so
the two spellings cannot drift.

`/devices/new` is registered **before** `/devices/:id`, and that order is load-bearing:
`matchRoute` returns the first match, and `:id` would otherwise capture the literal segment
`new` and route the add form to a device that does not exist. A test asserts the order rather
than only the behaviour, because the behaviour would still look fine in the moment someone
reordered the list.

A uuid that `documentId` refuses — empty, or containing the separator — is a hand-edited or
truncated URL. "No such device" is the honest answer; letting it throw would take the page down.

## What could go wrong

**The page becomes a way to leak a passcode.** It is the opposite: this page is the *point* of
storing the payload, and its audience is the person who owns the device. The rule that still
holds is the one from M1 — no code in a log, an error message, or a network request.

**The pairing code is displayed in an invented grouping.** Printed labels group digits
differently by manufacturer, and teaching a reader a format that does not match the sticker in
their hand is worse than showing none. Digits exactly as stored, with a copy button that copies
exactly those digits.
