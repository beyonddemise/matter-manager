# todo-181 — the frontend becomes one self-contained directory

Closes #181 and #182. Step two of the flattening #164 called "step one".

## What moved

```
packages/core/src   ->  frontend/src/domain      packages/core/test  ->  frontend/test/domain
packages/data/src   ->  frontend/src/data        packages/data/test  ->  frontend/test/data
packages/web/src    ->  frontend/src/ui          packages/web/test   ->  frontend/test/ui
```

`frontend/` now carries its own `package.json`, lockfile, `tsconfig`, Biome, Vitest and Vite
configuration, and its own `.npmrc`. It installs, lints, typechecks, tests and builds without
the repository root, exactly as `backend/` has since #164. `packages/` is gone.

## The decision that mattered

Merging three packages means merging three `tsconfig.json` files, and they were not the same
file:

| package | `lib` | `types` |
| --- | --- | --- |
| `core` | `ES2023` | (unrestricted) |
| `data` | `ES2023` | `node`, three pouchdb packages |
| `web` | `ES2023`, **`DOM`**, **`DOM.Iterable`** | `vite/client`, `node`, `pouchdb-browser` |

A single merged project takes the union, which hands `src/domain` the DOM. **That is the purity
guarantee being deleted, not moved.** `packages/core`'s value was never the package — it was a
compiler that refused to believe `document` existed.

So there are two typecheck passes. `tsconfig.json` builds everything; `tsconfig.domain.json`
checks `src/domain` alone with `"lib": ["ES2023"]`, `"types": []` and `"noEmit": true`. It is a
check rather than a build target, so it costs none of the project-reference machinery this move
exists to remove.

Demonstrated rather than asserted. With `document.title + String(process.pid) +
localStorage.length` planted in `src/domain/text/fold.ts`:

```
tsconfig.json         -> exit 0                    <- the merge really did dissolve it
tsconfig.domain.json  -> TS2584 Cannot find name 'document'
                         TS2591 Cannot find name 'process'
                         TS2304 Cannot find name 'localStorage'
```

**`types: []` cannot stop an import.** PouchDB, Lit and Web Awesome ship their own type
definitions, so `import { LitElement } from 'lit'` typechecks perfectly under the domain
config. `test/domain/purity.test.ts` covers that, and covers it **transitively** — which is the
point rather than thoroughness for its own sake. A direct-imports-only check reads
`src/domain/**`, sees nothing but relative paths, and misses a domain module importing
`../ui/theme.js`, which imports Web Awesome. Planting exactly that produces:

```
src/domain/text/fold.ts imports src/ui/theme.ts
src/domain/text/fold.ts -> src/ui/theme.ts imports the package '@awesome.me/webawesome-pro/...'
```

The second line is the one that explains why the first matters.

## Three checks that were pinned to a path

The same bug in three places, and #179 had just found a fourth (`directory: /` in the Dependabot
npm entry). Worth naming as a pattern, because every instance was silent and every one failed in
the direction that looks like success:

| check | was | would have |
| --- | --- | --- |
| `check-npmrc.mjs` | read `./.npmrc` | passed by having nothing to look at, once the credential moved into `frontend/.npmrc` |
| `check-dependencies.mjs` | scanned `packages/*` and the top level | quietly narrowed to nothing when `packages/` emptied |
| `.gitignore` | `packages/web/.vitest-attachments/` | un-ignored the old directory on rename — `git add -A` staged **79 stale screenshots** before this was caught |

All three now walk the tree or match unanchored, rather than being told where to look. The
`.npmrc` one is proved: planting a literal token in `frontend/.npmrc` fails the check and the
offending value is redacted from the output.

`check-npmrc.mjs` also stopped treating "no `.npmrc` anywhere" as success. This repository
installs Web Awesome Pro from a private registry, so finding none means the check has lost the
tree, not that the tree is clean.

## #182 landed here, not separately

Issue #182 asked for one command that verifies the whole repository, and for the frontend-only scripts
to move out of the root. Both are here, because neither could honestly be deferred:

- **The scripts had to move with their tests.** `packages/web/test/deploy/` holds four tests of
  `scripts/check-*.mjs`. "The frontend tests on its own" is false if its suite reaches up into
  the repository root, so the ten frontend-only scripts are now `frontend/scripts/`. The four
  genuinely repository-wide ones stay: `check-npmrc`, `check-dependencies`, `check-node-pins`,
  `dev-stack`.
- **Root `verify` had to cover both halves**, or this change would have shipped a `main` where
  the command the pull-request checklist names covers less than it did before.

Root `package.json` keeps `workspaces: ["e2e"]`. #182 said "no npm workspaces", but `e2e` is a
genuine workspace of the root — it drives the built site and belongs to neither half.

One acceptance criterion in #181 was simply wrong and is worth recording rather than quietly
satisfying: it said root `biome.json` would "no longer need to exclude `backend`". It does.
Biome discovers nested root configurations while walking, independently of `files.includes`, and
errors with "Found a nested root configuration". Verified by removing the exclusions and reading
the failure. The root's includes are now narrowed to what it owns anyway — 13 files: `scripts`,
`e2e`, `infra`, `.devcontainer`, `.github` and the root JSON.

## The cost this change carries, demonstrated within the hour

`frontend` depends on `playwright` for its browser-mode tests; the root `e2e` workspace depends
on `@playwright/test`. The root workspace used to hoist those to **one** copy. Splitting the
installs let them diverge immediately — **1.63.0 against 1.62.1**, which are different browser
builds (1243 and 1234) — so installing Chromium for one left the other trying to launch a binary
that had never been fetched.

Local runs could not see it: one machine, one `~/.cache/ms-playwright`, both builds present from
earlier work. **CI caught it on the first run**, with all 8 journeys failing on
`Executable doesn't exist`.

Three layers, because one would have been a patch rather than a fix:

1. **The versions are realigned** — the root lockfile now resolves `@playwright/test` to 1.63.0.
2. **Dependabot keeps them in step.** The `dev-tooling` group matched `@playwright/*` and **not**
   bare `playwright`, so the updater would have bumped one and not the other — which is exactly
   how they came to disagree. Both names are now in the pattern list, grouped by
   `dependency-name`.
3. **CI no longer depends on them agreeing.** It reads both versions, keys the browser cache on
   both, and installs from each directory. A future divergence costs a second download instead
   of a broken job.

This is the "shared tooling versions can drift" consequence ADR 0017 names, arriving as a real
failure on the change that introduced it rather than as a hypothetical.

## Found by re-reading the diff, not by any check

Three things the move left behind, none of which failed anything — which is the point:

- **`vitest.config.ts` was still at the repository root**, describing four projects under
  `packages/*` that no longer exist. Nothing referenced it: the root has no `vitest`
  dependency and no `test` script, so it was a dead file that read like live configuration.
  Deleted. Exactly the failure mode L36 is about, in the one form a *check* cannot catch —
  there is no check for "this configuration file is describing nothing".
- **`backend/src/security/cors.ts` and its test pointed at `packages/web/src/projects.ts`** to
  explain *why* the CORS allowlist admits an `authorization` header. The file is now
  `frontend/src/ui/projects.ts`. A comment citing a path that does not exist is worse than no
  citation: the next reader concludes the reasoning is stale and stops trusting it.
- **`check-dependencies.mjs`'s docblock** described `packages/web` as the bundled package while
  the code beneath it had already been changed to `frontend`.

Everything else naming `packages/` is deliberate: historical records under `docs/adr`,
`docs/backlog`, `docs/tasks` and `CHANGELOG.md`, plus prose in this change that is explicitly
*about* what `packages/core` used to be.

## Verified

- **`npm run verify` from the root — exit 0**, covering the whole repository for the first time:
  dependency policy (4 manifests), both `.npmrc` files, 7 Node declarations, root Biome (13
  files), then the frontend's full verify, then the backend's.
- **Frontend**: Web Awesome present, i18n catalogue current, deploy headers, module graph (79
  modules all reachable), Biome over 186 files, both typecheck passes, **1516 tests in 86 files**.
  Against 1512 in 85 on `main` — the difference is exactly `purity.test.ts` and its 4 tests.
- **Backend**: unchanged, **787 tests in 33 files**.
- **`vite build`** succeeds from the new tree, and the post-build checks pass against it:
  `check:lazy` (fallback reached only by dynamic import) and `check:offline` (nothing fetched
  from a third party).
- **`npm run e2e` — 8 passed**, driving the built site through `npm --prefix frontend run
  preview`.

## Not here

- Superseding ADR 0004 — #184, deliberately its own change, as #164 said.
- The `ProjectRole` duplication — #183, recorded for a decision rather than assumed.
