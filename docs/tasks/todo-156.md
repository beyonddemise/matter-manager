# todo-156 — Dependabot has never checked a container image

Closes #156.

## Symptom

Every `Dependabot Updates` run for the docker ecosystem has failed since the repository was
created — 2026-08-19, 2026-09-01, 2026-09-03, without exception:

```text
ERROR Error during file fetching; aborting: No Dockerfiles nor Kubernetes YAML found in /infra
```

## Cause

`directory: /infra`, and **Dependabot does not recurse**. `/infra` itself holds `Caddyfile` and
`compose.prod.yml`; the Dockerfile is a level down in `/infra/couchdb`. So the entry pointed at
a real directory that genuinely contains no Dockerfile, and aborted, every time.

Three base images were never looked at:

| file | base image |
| --- | --- |
| `infra/couchdb/Dockerfile` | `couchdb:3.5.2.1` |
| `.devcontainer/couchdb/Dockerfile` | `couchdb:3.5.2.1` |
| `packages/api/Dockerfile` | `node:24-bookworm-slim`, both stages |

Found while writing up #153, which is the same failure in a different ecosystem, and the pattern
is worth naming rather than the two instances.

The run **is** marked failed — that part is not hidden. What hides it is everything around the
mark. A `Dependabot Updates` run is not a pull request check, so it blocks nothing and notifies
nobody; each ecosystem runs as its own job, so `github_actions` succeeding sits in the same list
as `docker` failing; and the pull request list, which is where anyone actually looks, fills up
as usual from the ecosystems that did work. The reason for the failure is only in a log that
needs write access to read.

So the state to watch for is not a red mark nobody saw. It is that **nothing appearing in the
pull request list is exactly what nothing-to-update looks like** — and for three base images
over two weeks, that was indistinguishable from the truth.

## Two things beyond the path

**Compose files are a different ecosystem.** `docker` reads Dockerfiles and Kubernetes YAML and
never compose files; `docker-compose` is its own `package-ecosystem` value. `caddy:2-alpine` in
`infra/compose.prod.yml` and the devcontainer's
`mcr.microsoft.com/devcontainers/typescript-node` were unwatched for that reason and would have
stayed unwatched even with the path corrected.

**The two CouchDB pins must move together.** `infra/couchdb/Dockerfile` and
`.devcontainer/couchdb/Dockerfile` carry the same tag deliberately —
`.devcontainer/docker-compose.yml` says why:

> Replication and `validate_doc_update` behaviour differ between CouchDB minor versions, and
> those are exactly the behaviours this project depends on most, so dev/prod drift on this image
> would surface as sync bugs that reproduce nowhere.

Pointing Dependabot at both directories without grouping them would let it raise a pull request
for one and not the other. The tool meant to keep dependencies current would then be the thing
that broke the invariant. Hence `groups:` — one pull request per ecosystem, or none.

## Change

`.github/dependabot.yml`: `directories:` listing the three Dockerfile locations, a
`docker-compose` entry for `/infra` and `/.devcontainer`, and a group on each.

## Verification

The configuration parses to the expected shape, and the three paths are the three directories
that actually contain a Dockerfile — checked with `find`, not assumed.

**What is not verified from here, and what to look for on the first run after merge.** The
evidence is the next `Dependabot Updates` run, and two things in it are genuinely uncertain:

- whether `docker-compose` recognises `compose.prod.yml`, which is not one of the four default
  compose filenames;
- how either ecosystem handles `matter-manager/couchdb` and `matter-manager/couchdb-dev`, which
  are built locally by these very compose files and resolve to no registry at all.

If either misbehaves it will do so quietly, in the same way this bug did. The run log is the
place to look.
