# 13. Minimal runtime dependencies

Date: 2026-08-19

## Status

Accepted

## Context

This application stores commissioning secrets, is maintained by a very small team, and is
expected to run for years with light attention. Every runtime dependency is code that ships
to users, must be kept patched, and can be compromised upstream. A supply-chain compromise in
a transitive dependency of the browser bundle would have access to Matter payloads.

Node and the browser have also absorbed most of what these libraries were originally for.
`fetch` is global in Node 18+. `node:crypto` signs and verifies JOSE algorithms and imports
JWKs directly. `Intl` handles formatting. `crypto.randomUUID()` exists everywhere.

Two specific packages prompted this. **`nano` / `couchdb` predate native `fetch`** and carry
their own HTTP stack for a job that is now four lines of `fetch`. **`axios`** is the same
argument in the browser.

## Decision

Runtime dependencies are opt-in, justified individually, and enforced by CI.

**Use the platform first:**

| Need | Use | Not |
|---|---|---|
| HTTP requests, client and server | native `fetch` | `axios`, `node-fetch`, `got`, `request` |
| CouchDB access from the API | native `fetch` | `nano`, `couchdb` |
| Sign / verify JWT (**server only**) | `node:crypto` | `jose`, `jsonwebtoken` |
| Import a provider's JWKS key | `createPublicKey({ key, format: 'jwk' })` | `jwk-to-pem`, `jose` |
| Crypto in **shared or browser** code | `@noble/*` | hand-rolled, or assuming parity |
| Identifiers | `crypto.randomUUID()` | `uuid`, `nanoid` |
| Dates and formatting | `Intl`, `Temporal` where available | `moment`, `date-fns` |
| Deep equality, cloning | `structuredClone`, plain code | `lodash`, `ramda` |

### The one place "use the platform" is the wrong instinct

`node:crypto` and the browser's `SubtleCrypto` are **not the same API**, and where they
overlap they differ in the fine print: which curves and algorithms are available, whether an
operation is synchronous or promise-returning, how keys are imported, and which signature
encodings are produced. ES256 is a good example — Node emits DER unless told
`dsaEncoding: 'ieee-p1363'`, while WebCrypto emits raw R‖S. Same algorithm, different bytes,
and nothing warns you.

That divergence is fine where code is runtime-specific: the API signs tokens on the server
and can use `node:crypto` directly, which is verified working. It is a problem the moment
anything crypto-related lands in `packages/core`, which by design runs in both, or in the
browser at all.

So **`@noble/hashes`, `@noble/curves` and `@noble/ciphers` are allowed** for shared and
browser-side crypto. They are audited, dependency-free (bar `curves` needing `hashes`), and —
the property that matters — behave identically in both runtimes. Correctness that depends on
which runtime the code happens to be executing in is not correctness.

The rule, then: `node:crypto` where the code is server-only and stays server-only; `@noble/*`
where it is shared, browser-side, or might move.

**Verified before adopting** — the whole authentication and database path runs with zero
runtime dependencies. Confirmed on Node 24 against CouchDB 3.5.2: ES256 signing and
verification, rejection of expired and wrongly-signed tokens, import of both EC and RSA
provider keys from JWK form, and CouchDB create / read / write / `_security` / `_changes`
over `fetch`. This is not an aspiration; it was measured.

**Adding a runtime dependency** means adding it to `dependency-policy.json` with a one-line
reason. CI fails otherwise. The file is the review gate: the question at review time is not
"does this work" but "is the platform genuinely insufficient here".

**Only direct dependencies are policed**, deliberately. A package we choose is a decision; its
transitive tree is a consequence of that decision, and banning transitively would mean
rejecting almost everything — `openapi-backend`, for instance, pulls in `lodash`, which this
policy bans directly. The right response is to weigh the whole tree when admitting a package,
not to pretend we can forbid what it depends on. Judge a candidate by `npm ls` after
installing it, not by its own `dependencies` list.

**Use workers where they earn their place:**

- **Service worker** — the offline app shell. Hand-written rather than generated, because
  what this application needs (precache the shell, cache-first for assets) is a short,
  auditable file, while a generated one ships a runtime library to do the same job.
- **Web worker** — for work that would otherwise block the interface: generating a large PDF,
  and the QR decode loop when the ZXing fallback is in use. **Measure first.** A worker adds
  message-passing and serialisation, which is a real cost if the work was never slow enough
  to notice.

## Consequences

- A small bundle, which matters for a PWA loaded over poor connections, and a small audit
  surface for something holding commissioning secrets.
- Fewer upgrade treadmills and fewer transitive advisories.
- **More code we own.** Writing four lines of `fetch` instead of importing `nano` means those
  four lines are ours to test. This is the trade being made deliberately: the code is small
  and boring, and `core` is where the difficult logic lives anyway.
- Some genuine friction. When a task really does want a library, it must be argued for rather
  than installed. That is the point, and it will occasionally be annoying.

### Dependencies accepted so far

| Package | Why the platform is not enough |
|---|---|
| `lit` | The component model itself (ADR 0008). |
| `@awesome.me/webawesome-pro` | Component library (ADR 0008). |
| `@lit/localize` | Runtime locale switching with extraction tooling. |
| `pouchdb-browser` | **The largest exception.** It is the CouchDB replication protocol — revision trees, conflict detection, resumable sync. ADR 0002 rejected writing this precisely because it is the hard part. |
| `pdf-lib` | PDF writing, including font embedding. Not reasonable to hand-roll. |
| `@zxing/browser` | QR decoding where `BarcodeDetector` is unavailable, which is every iOS Safari. Loaded lazily so browsers with the native API never pay for it. |
| `@noble/hashes`, `@noble/curves`, `@noble/ciphers` | Identical crypto in both runtimes, for anything shared or browser-side. See above. |

**QR *generation* needs nothing at all.** Web Awesome ships `<wa-qr-code>`, which renders
client-side to a canvas and takes `value`, `size`, `fill`, `background`, `radius` and
`errorCorrection`. Verified present in `@awesome.me/webawesome-pro@3.11.0`. Hand-rolling an
encoder was briefly considered — a Matter payload needs only alphanumeric mode — and is now
moot. Note for M3: the encoder is bundled inside the component and is not separately
importable, so PDF embedding goes through the rendered canvas.

### Deliberately still open

**Fastify.** ADR 0004 chose it before this policy existed, and it does **not** read OpenAPI
natively — its model is JSON Schema per route, and `@fastify/swagger` *generates* a spec from
those, which is the opposite direction to what ADR 0004 wants. Spec-first would mean
`fastify-openapi-glue` or `openapi-backend`, both runtime dependencies.

The approach that satisfies both ADRs uses **build-time tooling only**: generate types from
the spec with `openapi-typescript` (a devDependency), derive Fastify's route schemas from the
spec's own JSON Schema components with a small script, and fail CI when the generated output
differs from what is committed. Zero runtime cost, and drift becomes a compile error.

That leaves Fastify providing the HTTP server and plugin ecosystem, and little else. Not
reversed here — reopening a settled ADR for one server-side dependency is not obviously worth
it — but the tension is now sharper than when this ADR was written. Revisit if the API stays
as thin as planned.
