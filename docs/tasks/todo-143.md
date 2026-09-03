# todo-143 — SVG layouts: the spike, not the implementation

#143 was recorded as future work with four questions marked "nothing below is settled". Three of
them are measurable, and measuring them is cheap compared to discovering the answers one at a
time inside an implementation. This is that measurement. **No layout feature is built here.**

## 1. How a layout can be rendered without handing the origin away

`scripts/probe-svg-rendering.mjs` renders one hostile SVG four ways, twice: once under the
Content-Security-Policy read from `packages/web/public/_headers`, once with no policy at all.
The control run is the whole point — it separates what the *browser* refuses from what the
*policy* refuses, and those are protected by very different things.

The SVG carries every trick #143 names: an inline `<script>`, an `onload=` attribute, an
external `<image href>`, an external `<use href>`, a `@import` of an external stylesheet, a
`<foreignObject>` holding an `onerror=` image and an off-origin `<iframe>`, and a
`javascript:` link that the probe clicks.

Those external references point at a **second local origin that answers**, not at an
unresolvable host, and that origin reports what it was actually asked for. It has to: an
unreachable host fails DNS whether or not the policy blocked the request, so "the request
failed" would prove nothing — the check would pass for the wrong reason and could never fail for
the right one. A different port on 127.0.0.1 is a different origin as far as the policy is
concerned, and it serves a real PNG, stylesheet, sprite and frame, so anything that gets through
is something the probe can see.

| render mode | under the deployed policy | with no policy at all |
| --- | --- | --- |
| `<img src="blob:…">` | nothing ran, nothing fetched | **nothing ran, nothing fetched** |
| `<img src="data:…">` | nothing ran, nothing fetched | **nothing ran, nothing fetched** |
| inline in the document | nothing ran | `foreignObject onerror=`, `javascript:` href **both executed** |
| inline in a shadow root | nothing ran | `foreignObject onerror=`, `javascript:` href **both executed** |

That is the finding, and it is not a close call. **`<img>` is inert by the browser's own rules
for SVG in an image context** — no scripting, no external references, policy or no policy.
Inline SVG is inert *only because of the policy*, and the policy is a file that someone will
edit one day for an unrelated reason.

Two things the measurement contradicted that intuition would have got wrong:

- **`<svg><script>` never executed, in either run.** Assigned through `innerHTML`, a script
  element does not run — the same rule that has always applied to HTML. So the single most
  famous piece of sanitiser advice, "strip `<script>`", targets the one vector here that was
  already harmless. What actually executed was an event-handler *attribute* and a
  `javascript:` *URL*. A sanitiser allowlist written from intuition would have covered the
  wrong things.
- **An external `<use href>` never arrived at the second origin even in the control run, and
  reported no CSP violation either.** It is stopped by the same-origin rule, which no policy
  change can loosen and no policy report will ever mention. Anyone planning to monitor this
  class of thing through CSP reports would never see it attempted.

For completeness, under the policy the inline modes did produce violations for
`style-src-elem`, `img-src`, `script-src-attr`, `script-src-elem`, and `frame-src` — the last
of which is not written in the policy and falls back correctly to `default-src 'none'`. In the
control run the second origin was asked for `/hostile.css`, `/pixel.png` and `/frame`; under the
policy it was asked for nothing, in any mode.

**Recommendation: render through `<img src="blob:…">`.** `img-src 'self' data: blob:` already
permits it, so the CSP needs no change at all. The cost is that the plan is a picture: no
hit-testing inside it, no hover, no click-to-select on a shape. Device markers can still be
absolutely positioned *over* it in ordinary DOM, which is what placing a device actually needs.
Inline SVG buys interactivity *inside* the drawing, and the price is a sanitiser plus permanent
dependence on the policy staying exactly as strict as it is today.

## 2. Where the bytes live

Six real floor plans from Wikimedia Commons, chosen by size rather than by looking nice:

| plan | raw | gzip |
| --- | ---: | ---: |
| BHAK Wien 22 Grundriss | 5,731 | 1,747 |
| Padmashree Haldhar Nag Kavi Kutir | 15,721 | 3,587 |
| Beylerbeyi Palace, basement | 77,644 | 7,030 |
| Little White House | 166,563 | 16,106 |
| Orthodox temple | 212,254 | 57,797 |
| Humayun's Tomb | 907,075 | 178,551 |

So: **6 KB to 900 KB, gzipping about 9–11×.** Drawings are mostly repeated path data, which
compresses extremely well. The 900 KB case is not a straw man — it is an ordinary detailed plan.

Then the question that matters. A layout can live *in* the document as base64, or as an
attachment. Base64 costs a flat 4/3 in size, which is the boring part. The interesting part is
what every **other** read has to carry. Measured with a project of ten devices plus one layout,
`allDocs({ include_docs: true })` — which is what listing devices does:

| plan | inline in the document | as an attachment |
| --- | ---: | ---: |
| 5,731 B | 9,848 | 2,333 |
| 77,644 B | 105,765 | 2,367 |
| 212,254 B | 285,222 | 2,345 |
| 907,075 B | **1,211,661** | **2,356** |

The attachment column does not move. An attachment leaves a stub in the document —
`{"content_type":"image/svg+xml","length":907075,"digest":"md5-…","stub":true}` — so listing
devices costs the same whether the project has a plan or not. Inline, opening the device list
deserialises a megabyte that the device list has no use for.

**Recommendation: attachment.** Not for disk, for the read path.

## 3. What replication costs, which is the ADR 0002 question

An attachment does **not** make replication cheaper. Verified against the real dev CouchDB
(3.5.2, the same image tag as production): pulling the layout document with attachments is
**1,209,642 bytes**; the stub alone is **224**. Replicate the document and you replicate the
plan. #143's worry — "an offline-first application that quietly pulls a megabyte per building is
a different application on a phone" — is exactly right and attachments do not answer it.

What answers it is not replicating the document. Both halves were measured:

- **PouchDB → PouchDB, function filter** `doc.kind !== 'layout'`: 11 documents and 1,211,477
  bytes becomes 10 documents and **1,731 bytes**.
- **Against real CouchDB**, `POST /_changes?filter=_selector` with
  `{"selector":{"kind":{"$ne":"layout"}}}` returns the ten devices and **omits `layout:ground`
  entirely**. The replicator never learns the document exists, so it never asks for it and the
  attachment never crosses the wire.

That second measurement is the one that matters and it is why the container was worth starting.
A *function* filter runs on the client for a pull — the bytes arrive and are then discarded,
which is no saving at all. A `_selector` filter runs inside CouchDB. If layouts are ever made
optional per device, it has to be the second kind.

## What is still undecided, because no measurement decides it

The two remaining questions from #143 are product decisions, and this spike deliberately does
not answer them:

- **Where a layout belongs** — per project, per floor, per room path segment. ADR 0006's
  materialised paths make "per path segment" the obvious shape, and #143 already notes that
  obvious is not the same as right.
- **How a device gets a position** — coordinates on the device document, or a separate
  placement document per layout. The first is simplest and couples every device to a layout it
  may outlive; the second keeps them independent and adds a second thing to keep in step.

## Recommendation, in one place

1. Render with `<img src="blob:…">`. No CSP change, no sanitiser, safe by the browser's rules
   rather than by configuration. Position device markers over it in ordinary DOM.
2. Store the plan as a CouchDB attachment on a layout document, never inline in a body.
3. Give the layout document a `kind` that a `_selector` filter can exclude, so a phone can sync
   a project without pulling its plans — and treat that as part of the first implementation
   rather than a later optimisation, because the document shape has to allow it from the start.
4. Decide the two product questions above before writing code.

## The probe is also an assertion

`npm run probe:svg` exits non-zero if anything executes or reaches off-origin under the deployed
policy. That invariant is about the **policy**, not about any layout feature — it is true today
and would be worth knowing about the day someone adds `'unsafe-inline'` to `script-src` for an
unrelated reason.

It is deliberately **not** wired into CI in this change. Nothing in the application renders an
uploaded SVG yet, so a gate here would guard a door that is not built; it belongs in the
implementation's pull request, where it has something to protect.

It was observed failing before being trusted. Pointed at the control run instead of the policy
run, it exits 1 and names every vector:

```
A hostile SVG got through the deployed policy:
  - inline in document: executed foreignObject onerror=
  - inline in document: executed javascript: href
  - inline in document: reached the other origin for /hostile.css
  - inline in document: reached the other origin for /pixel.png
  - inline in document: reached the other origin for /frame
  - inline in shadow root: … the same four
```

It also fails if the control run reaches the second origin **not at all** — because then
"nothing got through" would be equally true of a probe that was never wired up. A check whose
silence cannot be distinguished from a check that is not running is not a check.

## Verification

Every number here is reproducible: `npm run probe:svg` for the rendering table, and the
measurement scripts recorded in the pull request for the rest. The CouchDB numbers came from
`docker compose -f .devcontainer/docker-compose.yml up -d couchdb` and were taken against
CouchDB 3.5.2; the spike database was removed and the container stopped afterwards.
