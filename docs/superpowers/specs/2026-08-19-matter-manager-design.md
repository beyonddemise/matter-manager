# Matter Manager — Design

Date: 2026-08-19
Status: Approved

## Problem

Matter devices are commissioned by scanning a QR code printed on the device or its
packaging. That code is routinely lost — the box is discarded, or the device is mounted
where the label cannot be read. Recovery means a factory reset, and without the code, a
support call or a replacement.

There is no good place to keep these codes. A photo album is unsearchable, a spreadsheet
means transcribing a 19-character string by hand, and neither reproduces a scannable code.

## Solution

Capture each code once, enrich it with metadata that makes it findable (room, type, name,
installation date), and reproduce it on demand — on screen or as a printable PDF.

**Not a hub.** Matter Manager never commissions, controls or monitors devices, and never
talks to a fabric. It is a catalogue.

### The insight that shapes everything

A Matter QR code is **a string, not a picture**: `MT:` followed by a Base38-encoded,
bit-packed struct (version, Vendor ID, Product ID, custom flow, discovery capabilities,
12-bit discriminator, 27-bit setup passcode).

Two consequences drive the architecture:

1. **Storage is ~20 characters and reproduction is exact.** The QR can be regenerated
   forever, at any size.
2. **Metadata is derivable.** Decoding yields Vendor and Product IDs, so manufacturer and
   product name can be looked up rather than typed.

It also means the highest-value, highest-risk code is a **pure codec** — no infrastructure,
exhaustively testable, and therefore the right place to start.

## Users

- **Homeowner** — one or two projects, shared with a partner. The primary user.
- **Installer** — commissions houses professionally, hands finished projects to homeowners,
  may keep read access for support.
- **Operator** — runs the service: accounts, support, subscriptions.

## Requirements

### Must

- Scan a Matter QR code, with manual entry as a fallback
- Decode the payload; auto-fill vendor and product where possible
- Record name, room, device type, installation date (defaulting to the scan date), serial
- Reproduce the QR on screen and as PDF, with the manual pairing code alongside
- Disable a device, move it between rooms, add timestamped remarks stored in the device record
- Export PDF: all devices or a selection, grouped by room
- Google sign-in (Facebook later)
- Projects (a house or apartment) with read or write sharing
- English and German, following browser language, overridable in the profile
- **Work offline except for creating a project**
- Operator administration and an audit trail
- A subscription seam, with the model chosen later

### Must not

- Commission, control or monitor devices
- Require connectivity for anything except project creation
- Log or transmit setup passcodes

## Architecture

Detailed in [ARCHITECTURE.md](../../ARCHITECTURE.md), [DATA-MODEL.md](../../DATA-MODEL.md)
and [SECURITY-MODEL.md](../../SECURITY-MODEL.md). Summary:

- **Frontend** — Lit + Web Awesome, Vite, PWA, deployed to Cloudflare Pages
- **Local store** — PouchDB over IndexedDB; the client's source of truth
- **Sync** — direct browser-to-CouchDB replication, JWT-authenticated
- **Backend** — Fastify/TypeScript behind an OpenAPI contract; identity and provisioning only
- **Database** — CouchDB 3.5 on a DigitalOcean droplet, one database per project

Four packages: `core` (pure domain), `data` (PouchDB), `web` (Lit), `api` (Fastify).
`core` has no I/O and is shared by browser and server, so the Matter codec exists once.

**Runtime dependencies are allowlisted and enforced in CI**
([ADR 0013](../../adr/0013-minimal-runtime-dependencies.md)). Native `fetch` rather than
`axios` or `nano`; `node:crypto` rather than `jose`. The whole authentication and CouchDB path
was verified to need no dependencies at all. Workers are used where they earn it: a
hand-written service worker for the offline shell, and web workers for large PDF generation
and the ZXing decode loop.

### Decisions

| Decision | ADR |
|---|---|
| Offline-first via PouchDB/CouchDB | [0002](../../adr/0002-offline-first-pouchdb-couchdb.md) |
| One database per project | [0003](../../adr/0003-database-per-project.md) |
| TypeScript backend, OpenAPI contract | [0004](../../adr/0004-typescript-backend-openapi-contract.md) |
| Payloads stored unencrypted | [0005](../../adr/0005-plaintext-payload-storage.md) |
| Rooms as materialised paths | [0006](../../adr/0006-materialised-path-rooms.md) |
| Client-side PDF | [0007](../../adr/0007-client-side-pdf.md) |
| Lit + Web Awesome | [0008](../../adr/0008-lit-and-web-awesome.md) |
| Entitlement seam, billing deferred | [0009](../../adr/0009-entitlement-seam-billing-deferred.md) |
| Embedded remarks, deterministic merge | [0010](../../adr/0010-embedded-remarks-conflict-merge.md) |
| User-owned, org-ready tenancy | [0011](../../adr/0011-user-owned-org-ready-tenancy.md) |
| Central project registry + local cache | [0012](../../adr/0012-central-project-registry.md) |
| Minimal runtime dependencies | [0013](../../adr/0013-minimal-runtime-dependencies.md) |

## Milestones

Release 1.0 is **M0–M5**. Later milestones are planned and tracked but do not block it.

| # | Milestone | Delivers |
|---|---|---|
| M0 | Foundations | Monorepo, devcontainer, CI, docs, ADRs, backlog, Base38 codec |
| M1 | Domain core | Payload encode/decode, manual pairing code, validation, room paths |
| M2 | Local catalogue | PouchDB repositories, device and room CRUD, remarks, scanner, Lit shell, i18n, PWA |
| M3 | PDF export | Label sheet and inventory layouts, grouping, selection, manual codes |
| M4 | Auth + backend | Google OIDC, ES256 JWT, `_users` profile store, OpenAPI drift check, entitlement seam |
| M5 | Projects + sync | Provisioning, `_security`, roles, invitations, transfer, live sync, conflict resolution |
| M6 | Enrichment | DCL lookup, photos, CSV/JSON import-export |
| M7 | Admin + audit | Operator console, audit log |
| M8 | Billing | Provider and model, behind the existing seam |
| M9 | Production | Droplet, Caddy, backups, monitoring, restore drill |

**i18n lands in M2, not later.** Retrofitting `msg()` across a built UI is miserable and
never quite complete; wrapping strings from the first component costs nothing.

## Development method

Test-first throughout. Every issue is a vertical slice with Given/When/Then acceptance
criteria that become the tests. **Every test is observed failing before the implementation
exists** — a test that has never failed has never been shown to test anything.

Most assertions live in `core`, where they are exhaustive and run in milliseconds. E2E
covers only what genuinely crosses layers: offline creation and reconnection, and concurrent
conflicting edits.

## Risks

| Risk | Status |
|---|---|
| CouchDB `_security` extra keys unsupported | **Retired.** Verified against 3.5.2; 8/8 assertions pass. Guarded in CI by `verify-access-model.sh`. |
| iOS Safari lacks `BarcodeDetector` | `@zxing/browser` WASM fallback plus manual entry. Decided in M2. |
| Web Awesome licensing | **Resolved.** Pro licence held; registry access configured and verified in CI. |
| Web Awesome component coverage | **Open.** First task of M2. Contained: components are Lit-based. |
| Fork pull requests cannot install a private dependency | **Open** (M2-1b). Fork workflows get no secrets. |
| Plaintext passcodes in an installer's instance | Accepted in ADR 0005; compensating controls are M9 issues. |
| Silent remark loss on conflict | Merge strategy designed in M2, e2e-tested in M5. |
| Scope creep across nine milestones | Release 1.0 fixed at M0–M5. |

## Verified during design

Two assumptions were tested rather than trusted, and one was wrong:

**CouchDB access model** — confirmed against 3.5.2 before any code depended on it. All eight
assertions pass, including that a reader can read but not write or delete, and that audit
entries reject their second revision.

**The Matter test vector** — the reference payload `MT:Y.K9042C00KA0648G00` was checked
against two independent anchors: the documented field values of the standard SDK test device,
and the manual pairing code `34970112332` derived through an unrelated algorithm. This
**corrected** an assumption: the payload's Product ID is `0x8000`, not the `0x8001`
originally written down. Had it gone unchecked it would have become a permanently wrong
constant protected by a passing test.

## Deliberately excluded

Device commissioning and control, Thread/BLE interaction, telemetry, native mobile apps,
Facebook login at launch (a later provider in an already-pluggable OIDC layer), and
organisations as first-class entities (the schema is ready; the subsystem is not built).
