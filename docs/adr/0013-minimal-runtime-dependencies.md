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
| Sign / verify JWT | `node:crypto` | `jose`, `jsonwebtoken` |
| Import a provider's JWKS key | `createPublicKey({ key, format: 'jwk' })` | `jwk-to-pem`, `jose` |
| Identifiers | `crypto.randomUUID()` | `uuid`, `nanoid` |
| Dates and formatting | `Intl`, `Temporal` where available | `moment`, `date-fns` |
| Deep equality, cloning | `structuredClone`, plain code | `lodash`, `ramda` |

**Verified before adopting** — the whole authentication and database path runs with zero
runtime dependencies. Confirmed on Node 24 against CouchDB 3.5.2: ES256 signing and
verification, rejection of expired and wrongly-signed tokens, import of both EC and RSA
provider keys from JWK form, and CouchDB create / read / write / `_security` / `_changes`
over `fetch`. This is not an aspiration; it was measured.

**Adding a runtime dependency** means adding it to `dependency-policy.json` with a one-line
reason. CI fails otherwise. The file is the review gate: the question at review time is not
"does this work" but "is the platform genuinely insufficient here".

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

### Deliberately still open

**QR *generation*.** Encoding a Matter payload needs only alphanumeric mode, which is a
well-specified and testable few hundred lines — a plausible zero-dependency candidate, and
`core` already owns the payload codec. But a QR that scans slightly worse defeats the product,
so this needs measurement against real scanners before choosing. Decide in M2-8.

**Fastify.** ADR 0004 chose it before this policy existed. It is one well-scoped dependency,
and `node:http` plus a small router would replace it. Not reversed here — reopening a settled
ADR for a single server-side dependency is not obviously worth it — but noted so the tension
is visible rather than forgotten. Revisit if the API stays as thin as currently planned.
