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

```mermaid
flowchart LR
  subgraph B["Browser — Cloudflare Pages"]
    UI["Lit + Web Awesome SPA<br/>@lit/localize · PWA<br/>QR scan / render · pdf-lib"]
    LOCAL[("PouchDB / IndexedDB")]
    UI --- LOCAL
  end

  subgraph D["DigitalOcean droplet"]
    CADDY["Caddy — TLS, sole ingress"]
    API["Fastify (TypeScript)<br/>OIDC · token issuance<br/>project provisioning"]
    subgraph CDB["CouchDB 3.5"]
      USERS[("_users — profiles")]
      REG[("projects — registry")]
      PROJ[("project_uuid × N")]
    end
    CADDY --> API
    CADDY --> CDB
    API -->|admin only| USERS
    API -->|admin only| REG
  end

  UI -->|"REST + Bearer JWT"| CADDY
  LOCAL <-->|"replication, Bearer JWT"| CADDY

  classDef store fill:#eef,stroke:#557
  class LOCAL,USERS,REG,PROJ store
```

**One CouchDB database per project.** CouchDB has no row-level read permission, so
per-project databases are the only way "share this house but not that one" can actually be
enforced. See [ADR 0003](docs/adr/0003-database-per-project.md).

**Only `project_<uuid>` is ever replicated to a browser.** The profile store and the project
registry are reachable through the API alone — a single readable registry would disclose
every project's address and participant list to every user
([ADR 0012](docs/adr/0012-central-project-registry.md)).

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
| `npm run verify` | Dependency policy, `.npmrc` guard, Biome, typecheck, tests. CI additionally runs coverage gates and the CouchDB contract checks, which need a live CouchDB. |
| `npm test` | Unit and integration tests |
| `npm run test:watch` | Test watcher for red-green-refactor |
| `npm run check:fix` | Auto-fix formatting and lint |
| `npm run e2e` | Playwright end-to-end suite |

---

## Deployment

The web application is a static bundle, deployed to **Cloudflare Pages by direct upload** from
GitHub Actions: a push to `main` goes to production, and every pull request from this
repository gets a preview at `<branch>.matter-manager.pages.dev`. Forks get no deployment,
for the same reason they cannot run `npm ci` — GitHub does not give fork workflows secrets.

Full rationale, including the caching contract and why it is enforced by a checker, in
[ADR 0014](docs/adr/0014-cloudflare-pages-deployment.md).

### Repository secrets

| Secret | What | Where |
|---|---|---|
| `WEBAWESOME_NPM_TOKEN` | Web Awesome Pro registry token | CI and deploy |
| `CLOUDFLARE_API_TOKEN` | API token with **Account → Cloudflare Pages → Edit**, and nothing else | deploy |
| `CLOUDFLARE_ACCOUNT_ID` | The account the Pages project lives in | deploy |

### One-time setup

The Pages project has to exist before the first deploy: `wrangler pages deploy` can create one
interactively, and an Actions runner is not a TTY, so it errors instead of prompting.

```bash
npx wrangler pages project create matter-manager --production-branch=main
```

`--production-branch` matters and is awkward to correct: a Direct Upload project's production
branch cannot be changed from the dashboard, only through the Update Project API. Set wrongly,
every deployment is a preview and nothing is ever live — which presents as a broken workflow
rather than as a wrong setting.

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
