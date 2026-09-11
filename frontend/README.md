# @matter-manager/frontend

The browser application: the Lit + Web Awesome single-page app, the offline catalogue beneath
it, and the pure domain logic beneath that. Built with Vite, deployed to Cloudflare Pages, and
self-contained — it installs, lints, typechecks, tests and builds without the repository root.

**Created in M2 as three packages (`core`, `data`, `web`); merged into one directory in #181.**

## The three directories

| directory | what it is | may depend on |
| --- | --- | --- |
| `src/domain` | Pure logic: Matter codec, room paths, document drafts, conflict merge | **nothing** |
| `src/data` | PouchDB repositories, sync manager, conflict detection | `src/domain` |
| `src/ui` | Lit components, routing, views, PDF and QR | both |

They were separate npm packages until #181. The packaging was ceremony — `core` had exactly
one consumer — but the *boundaries* are real and are enforced rather than described:

- **`src/domain` depends on nothing**, and two mechanisms say so. `tsconfig.domain.json`
  typechecks it with no `lib` beyond ES2023 and no `types` at all, so `document`, `window` and
  `process` do not exist for those files. `test/domain/purity.test.ts` walks the import graph
  transitively and fails on any package import or any file outside `src/domain` — which is the
  half the compiler cannot see, because Lit and PouchDB ship their own type definitions.
- **Coverage gates differ per directory**, unchanged from the packages they came from:
  `src/domain` and `src/data` at 90%, `src/ui` at 70%.

## It constructs no database

A repository is handed an open `PouchDB.Database`; `src/data` imports no PouchDB
implementation and opens nothing. That is forced rather than chosen: `pouchdb-browser`, the
allowlisted runtime build, references `self` at module scope and **cannot be imported in Node
at all**, so any code depending on it could only be tested in a browser.

Inverting it means `src/ui` supplies the browser build, the tests supply `pouchdb-core` plus
`pouchdb-adapter-memory`, and those tests run in Node in milliseconds like the domain's. The
only PouchDB name in `src/data` is the *type* `PouchDB.Database`, which is erased at compile
time — asserted by `test/data/no-pouchdb-import.test.ts`, which is what makes the `allowedDev`
claim in `dependency-policy.json` a proof rather than a promise.

## Documents are keyed by type

Ids are `device:<uuid>` and `room:<uuid>`, so each type is a contiguous key range and `list()`
is a ranged `_all_docs` query with no view to define, index, replicate or find stale. The cost
is that the only free query is by id prefix, which is why a device's `roomId` is a full
document id rather than a bare uuid.

## The repository owns `updatedAt`

`Unsaved<T>` removes it, so a caller cannot supply one. It is half of the total order the
conflict merge depends on (ADR 0010), and a document written without it does not fail — it
quietly loses every future conflict. The clock is injected, so tests are deterministic.

Merge *logic* itself lives in `src/domain`: deciding how two conflicting remark arrays combine
is a pure function over plain data, testable exhaustively without a database. `src/data` finds
the conflicts and applies the decision; it does not make it.

## What belongs here

- Lit components and the router
- `@lit/localize` setup and the `en`/`de` XLIFF catalogues
- The PWA service worker (`vite-plugin-pwa`)
- QR scanning (`BarcodeDetector` with a `@zxing/browser` fallback) and QR rendering
- PDF generation with `pdf-lib` (M3) — client-side, so it works with no connectivity

## House rules

- **Every user-visible string goes through `msg()`**, and every component that renders one
  calls `updateWhenLocaleChanges(this)`. `npm run check:i18n` enforces the first and fails on
  a catalogue that has gone stale; see CONTRIBUTING for what to run after adding a string.
- Components render and handle input. Decisions belong in `src/domain`; persistence in `src/data`.
- Must work at phone, tablet and desktop widths. The scan-and-file flow is used one-handed,
  standing in front of a device, which is the case to design for first.

## Web Awesome

**Web Awesome Pro**, confirmed in M2-1 and settled: Pro-only components are in scope, and a
contributor who forks the repository needs their own licence to install and build
([issue #18](https://github.com/beyonddemise/matter-manager/issues/18)). Fork pull requests
fail `npm ci` because GitHub does not expose secrets to them, and that is accepted rather
than designed around.

## Dependencies and workers

Runtime dependencies are allowlisted in `dependency-policy.json` and enforced by
`npm run check:deps` ([ADR 0013](../docs/adr/0013-minimal-runtime-dependencies.md)). Use
`fetch`, `crypto.randomUUID()`, `structuredClone` and `Intl` before reaching for a package.

`@zxing/browser` must be **lazily loaded**, only when `BarcodeDetector` is missing. Browsers
with the native API should never download it.

**The service worker is hand-written.** Precache the shell, cache-first for hashed assets,
and never intercept API or replication requests. A service worker sits in front of every
request and outlives the page that installed it, which makes it the last place to want
generated code nobody has read.

**Web workers** are for the QR decode loop (only on the ZXing fallback path) and large PDF
generation. Measure before adding one — a worker's message-passing is not free, and the
native detector is already off-thread.

## Testing

`pouchdb-adapter-memory`, never a real CouchDB. Tests that need a live CouchDB belong in
`backend` or in `infra/couchdb/verify-access-model.sh`.

Four Vitest projects: `domain`, `data` and `ui-node` in Node, `ui` in a real Chromium. The
first three stay in a `node` environment deliberately — if a DOM ever became available to
them, depending on one by accident would become possible, and the promise that the domain
layer is testable anywhere would erode with nothing failing.
