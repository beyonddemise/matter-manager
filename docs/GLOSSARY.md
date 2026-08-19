# Glossary

Terms used throughout the code and documentation. Matter's vocabulary overlaps confusingly
with ordinary English, so precision here saves arguments later.

## Matter

**Commissioning** — Adding a device to a network so it can be controlled. What scanning a QR
code accomplishes. Matter Manager never commissions anything; it catalogues the codes that
would let you.

**Discriminator** — A 12-bit value distinguishing devices during commissioning, so a
controller can tell which of several nearby devices it is talking to. Not a secret.

**Fabric** — A set of devices sharing a trust domain, controlled by one or more admins.
Roughly "your smart home".

**Manual pairing code** — The numeric fallback for the QR code, 11 or 21 digits, derived
from the same underlying data. Printed alongside every QR in generated PDFs, because a phone
camera cannot always focus on a small code on a curled label.

**Matter** — The smart-home interoperability standard from the Connectivity Standards
Alliance.

**Onboarding payload** — The data encoded in a Matter QR code: version, Vendor ID, Product
ID, custom flow, discovery capabilities, discriminator and setup passcode, packed into 88
bits. Text-encoded as `MT:` followed by Base38.

**Multi-admin** — Sharing an already-commissioned device with a second fabric. Uses a
*newly generated* passcode, not the printed one. This is why the printed passcode remains
sensitive: a factory reset restores it.

**Setup passcode** — A 27-bit secret in the payload, used to establish the commissioning
session. **The sensitive part of everything this application stores.**

**Vendor ID / Product ID** — 16-bit identifiers for the manufacturer and model. Not secret,
and the basis for the DCL lookup that auto-fills manufacturer and product names.

**DCL** — The Distributed Compliance Ledger, the Alliance's public registry mapping Vendor
and Product IDs to certified product information.

**Base38** — The encoding used for QR payloads: digits, uppercase letters, `-` and `.`.
Chosen because QR codes have an *alphanumeric* mode restricted to that character set, which
produces a physically smaller and more readable code than binary mode would.

## This application

**Project** — One house or apartment. The unit of sharing and of the CouchDB database
boundary. Creating one is the only operation requiring connectivity.

**Room** — A location within a project, named with a materialised path such as
`Ground Floor/Kitchen`. Hierarchy is derived by splitting on `/`; there is no parent link.

**Spot** — Free text on a device for what a room name cannot capture: "ceiling, north end",
"behind the panel".

**Remark** — A timestamped, attributed note on a device, stored in the device document.
Merged by union on conflict so concurrent offline notes all survive.

**Principal** — A polymorphic owner reference, `{ ownerType, ownerId }`. Only `user` exists
today; `org` is the seam that lets organisations arrive without a migration.

**Entitlement seam** — The single `can(principal, action, project)` service every gated
action calls. Returns `true` for everything today; becomes the subscription check later.

## CouchDB

**`_security`** — The per-database document listing `admins` and `members`. Matter Manager
adds a non-standard `writers` key, which CouchDB preserves and passes to validation
functions.

**`validate_doc_update` (VDU)** — A JavaScript function stored in a design document, run on
every write. Where read-only enforcement, required-field validation and audit immutability
actually live.

**Replication** — CouchDB's synchronisation protocol. Bidirectional, resumable, and
conflict-aware. The reason PouchDB was chosen at all.

**Conflict** — Two revisions of a document, created independently, that replication cannot
order. CouchDB picks a deterministic winner but **does not merge**; merging is the
application's responsibility.

**Design document** — A document whose id begins `_design/`, holding views and validation
functions. Matter Manager installs `_design/access` into every project database.

## Storage terms

**Registry** — the central `projects` database. One document per project with a
`participants` array. Server-side only; the API reads it to answer `GET /projects`. Never
replicated to a browser, because CouchDB has no row-level read permission and one readable
registry would disclose every project's address and participant list to every user.

**Profile store** — CouchDB's built-in `_users` database, used here to hold display name,
email, locale and theme. **Not an authentication store**: under JWT auth CouchDB never
consults it, and a browser cannot read even its own document. Profiles come from
`GET /profile`.

**`mm-local`** — a PouchDB database that exists only in the browser and is never given a
remote counterpart. Caches `GET /projects` and `GET /profile` so project discovery and locale
work offline. A cache, never an authorisation input.

**`localState`** — on a cached project: `not-downloaded`, `syncing` or `downloaded`. Distinct
from having access. The registry says what you *may* open; `localState` says what is
*actually on this device*.
