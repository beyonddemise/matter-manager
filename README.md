# Matter Manager

**Never lose a Matter commissioning QR code again.**

Matter smart-home devices are commissioned by scanning a QR code printed on the device or
its packaging. That code is routinely lost — the box is discarded, or the device ends up
mounted somewhere the label can no longer be read. Recovering from that means a factory
reset, and without the code, often a support call or a replacement device.

Matter Manager captures those codes once, enriches them with the metadata that makes them
findable later (room, type, name, installation date), and reproduces them on demand — on
screen or as a printable PDF you can file with the house documents.

> **Not a hub.** Matter Manager does not commission, control or monitor devices. It is a
> catalogue. It never talks to your devices, your network, or your fabric.

---

## Why this works: a Matter QR code is a string, not a picture

The code encodes a text payload — `MT:` followed by a Base38-encoded, bit-packed struct
holding a version, Vendor ID, Product ID, custom flow, discovery capabilities, a 12-bit
discriminator and a 27-bit setup passcode.

Two consequences shape the whole application:

1. **Storage is trivial and reproduction is exact.** Keep ~20 characters and the QR can be
   regenerated forever, at any size, on any medium.
2. **Metadata comes for free.** Decoding yields Vendor ID and Product ID, so manufacturer
   and product name can be filled in for you instead of typed.

---

## Features

| | |
|---|---|
| **Scan** | Camera capture with a manual-entry fallback for codes a camera cannot reach |
| **Catalogue** | Name, room, device type, installation date, serial, photos, timestamped remarks |
| **Rooms** | Hierarchical paths like `Ground Floor/Kitchen`, created inline while adding a device |
| **Reproduce** | On-screen QR plus the numeric manual pairing code |
| **PDF** | Label sheets or a full inventory, grouped by room, all or selected devices |
| **Offline-first** | Everything works with no connectivity — the basement is exactly where you need this |
| **Projects** | One per house or apartment, shared read-only or read-write with others |
| **Multilingual** | English and German, following browser language, overridable in your profile |

---

## Status

**Pre-alpha — under active development.** Release 1.0 covers milestones M0–M5. See
[`docs/backlog/`](docs/backlog/) for the tracked breakdown and
[the design document](docs/superpowers/specs/2026-08-19-matter-manager-design.md) for the
full rationale.

---

## Architecture at a glance

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
│        └─ replication ───────┼───────►│ CouchDB 3.x              │
│                              │  JWT   │   user_<sub>             │
└──────────────────────────────┘        │   project_<uuid> × N     │
                                        └──────────────────────────┘
```

**One CouchDB database per project.** CouchDB has no row-level read permission, so
per-project databases are the only way "share this house but not that one" can actually be
enforced. See [ADR 0003](docs/adr/0003-database-per-project.md).

### Packages

| Package | Contains | Depends on |
|---|---|---|
| `packages/core` | Pure domain: Matter codec, room paths, entitlements, conflict merge | nothing |
| `packages/data` | PouchDB repositories, sync manager | `core` |
| `packages/web` | Lit SPA | `core`, `data` |
| `packages/api` | Fastify backend | `core` |

`core` has no I/O, no DOM and no network — it is where almost all the logic that can be
*wrong* lives, and it runs in milliseconds with zero setup. If something needs a browser or
a database to test, that is a signal it belongs elsewhere.

---

## Getting started

### Prerequisite: a Web Awesome Pro token

The UI uses [Web Awesome Pro](https://webawesome.com), which is published only to Web
Awesome's own registry. Export your token before installing — `.npmrc` reads it from the
environment, and `npm ci` fails without it:

```bash
export WEBAWESOME_NPM_TOKEN=...   # from your Web Awesome account
```

Put it in your shell profile rather than in `.env`, so plain `npm ci`, the devcontainer and
your editor all see it. **Never write it into `.npmrc`** — this repository is public, and CI
fails the build if it finds a literal token there.

### Then

**With the devcontainer (recommended)** — VS Code will offer "Reopen in Container". CouchDB
comes up alongside, already configured, and your token is forwarded from the host shell.

**Without:**

```bash
npm ci
docker compose -f .devcontainer/docker-compose.yml up -d couchdb  # optional until M4
npm run verify        # lint + typecheck + tests
```

| Command | Does |
|---|---|
| `npm run verify` | Everything CI runs: Biome, typecheck, tests |
| `npm test` | Unit and integration tests |
| `npm run test:watch` | Test watcher for red-green-refactor |
| `npm run check:fix` | Auto-fix formatting and lint |
| `npm run e2e` | Playwright end-to-end suite |

---

## Contributing

This project is developed test-first. Read [CONTRIBUTING.md](CONTRIBUTING.md) before opening
a PR — in particular the rule that **every test must be observed failing before the code
that makes it pass is written**.

## Security

Setup passcodes are stored unencrypted, protected by database isolation and transport
security. This is a deliberate, documented trade-off — read
[SECURITY.md](SECURITY.md) and [ADR 0005](docs/adr/0005-plaintext-payload-storage.md)
before deploying an instance that holds anyone's data but your own.

## License

[Apache-2.0](LICENSE)
