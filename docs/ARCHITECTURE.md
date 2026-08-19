# Architecture

How Matter Manager is put together, and why. Decisions are recorded individually in
[`adr/`](adr/); this document is the map that connects them.

## The shape of the system

```
Browser (Cloudflare Pages)              DigitalOcean droplet
┌──────────────────────────────┐        ┌──────────────────────────┐
│ Lit + Web Awesome SPA        │        │ Caddy (TLS)              │
│  ├── @lit/localize (en/de)   │        │   ├── api.* → Fastify    │
│  ├── PWA service worker      │        │   └── db.*  → CouchDB    │
│  ├── QR scan / QR render     │  HTTPS │                          │
│  ├── pdf-lib (client-side)   │◄──────►│ Fastify (TypeScript)     │
│  └── PouchDB (IndexedDB)     │  REST  │   Google OIDC → JWT      │
│        │                     │        │   project provisioning   │
│        └─ replication ───────┼───────►│ CouchDB 3.5              │
│                              │  JWT   │   user_<sub>             │
└──────────────────────────────┘        │   project_<uuid> × N     │
                                        └──────────────────────────┘
```

## The two paths, and why they are separate

Notice that data flows to the server by **two independent routes**, and that this is the
single most important structural fact about the system.

**Device data replicates browser-to-CouchDB directly.** It never touches the API. The
browser authenticates to CouchDB with a JWT that CouchDB validates itself using a public
key. Putting the API on that path would place it in front of every document write, make it
a failure point for synchronisation, and gain nothing — CouchDB already enforces
authorisation through `_security` and `validate_doc_update`.

**The API handles only what replication cannot**: proving who someone is, and creating
databases the browser has no rights to create.

This is why the OpenAPI contract has no device endpoints. Their absence is the design.

## Packages

| Package | Contains | May depend on |
|---|---|---|
| `core` | Matter codec, room paths, entitlements, conflict merge, validation, types | nothing |
| `data` | PouchDB repositories, sync manager, conflict detection | `core` |
| `web` | Lit SPA, i18n, scanning, PDF | `core`, `data` |
| `api` | Fastify, OIDC, provisioning | `core` |

### Why `core` is the keystone

`core` has no I/O, no DOM, no network and no database. That constraint is load-bearing, for
three reasons.

**It is where the bugs live.** Bit-unpacking an 88-bit payload, deciding how two conflicting
remark arrays combine, determining whether someone may invite a member — this is the logic
that can be subtly, silently wrong. Wrapping it in infrastructure would make it slow to test
and therefore under-tested, exactly inverting where test effort should go.

**It is needed on both sides.** The browser decodes payloads when scanning; the API validates
them when provisioning. Written once, it cannot drift.

**It is a design forcing-function.** If something seems to need a database to test, it is
almost always two things tangled together: a pure decision and an impure action. Separating
them and putting the decision in `core` improves the design independently of testing.

## Offline-first

The local PouchDB replica is the client's source of truth. Writes go there and return
immediately; replication happens in the background and may fail without the user noticing.

**Exactly one operation requires connectivity: creating a project.** It needs a CouchDB
database created, a `_security` document written and a design document installed — all
admin operations. Everything else works with no network: adding devices, editing, moving,
adding remarks, generating PDFs.

Consequences that must be designed for, not discovered:

- **Conflicts are inevitable.** Anything append-shaped needs an explicit merge (ADR 0010).
- **JWTs expire while offline.** That is fine, because sync only matters online. Refresh on
  reconnect. A local write must never block on token freshness.
- **Revocation does not recall data.** Whatever replicated stays replicated (SECURITY.md).

## Authorisation

One CouchDB database per project (ADR 0003). CouchDB has no row-level read permission, and
filtered replication is not a security boundary — the filter runs after the read, so a
client talking to `_changes` directly bypasses it.

Read access is `_security.members.names`. Write access is a custom `writers.names` key
enforced by `validate_doc_update`. This was verified against CouchDB 3.5.2 before anything
was built on it, and the verification runs in CI
(`infra/couchdb/verify-access-model.sh`).

Clients never enumerate databases. `_all_dbs` is blocked at Caddy; users discover projects
through pointer documents in their own `user_<sub>` database.

## Deployment

The SPA is static and deploys to Cloudflare Pages. The droplet runs Caddy, Fastify and
CouchDB under Docker Compose, with Caddy terminating TLS and acting as the only ingress.

CouchDB configuration is **baked into a derived image, never bind-mounted**. The upstream
entrypoint chowns everything under `/opt/couchdb` as root under `set -e`; a bind-mounted
file cannot be chowned, so the entrypoint exits 1 with no log output at all. This cost real
debugging time once and is documented in both Dockerfiles so it does not cost it again.

## Testing

| Layer | Tool | Gate |
|---|---|---|
| `core` | Vitest, node | 90% |
| `data` | Vitest + `pouchdb-adapter-memory` | 70% |
| `web` | Vitest browser mode + `@open-wc/testing-helpers` | 70% |
| `api` | Vitest + Fastify `.inject()`, live CouchDB | 70% |
| e2e | Playwright, including offline and conflict scenarios | — |
| CouchDB contract | `verify-access-model.sh` in CI | must pass |

The distribution is deliberate: most assertions live in `core`, where they are exhaustive
and run in milliseconds. E2E covers journeys that genuinely cross layers — offline creation
and reconnection, concurrent conflicting edits — and nothing that a unit test could cover
better.
