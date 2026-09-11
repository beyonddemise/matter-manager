# todo-179 — the compiler was told about a Node that does not run here

Closes #179.

## Symptom

Five files declared which Node this project uses. Four of those declarations disagreed with
the one that decides.

| declares | said | should say |
| --- | --- | --- |
| `.nvmrc` — the runtime | 24 | 24 |
| root `package.json` engines | `>=24` | `>=24` |
| `backend/package.json` engines | **`>=22`** | `>=24` |
| `@types/node` in `backend`, `packages/data`, `packages/web` | **`^26.2.0`** | `^24.13.4` |

Nothing failed. That is the whole problem: `@types/node` majors track Node majors, so `^26`
hands the compiler the Node 26 API surface while production runs Node 24. Every API added in
Node 25 or 26 typechecked cleanly and would have thrown at runtime — a type checker certifying
a crash. Dependabot #152 was proposing to widen the gap to 26.4.

`backend`'s `>=22` was not a deliberately looser floor. It is what `packages/api/package.json`
said before #164 moved it, and no Node 22 has been tested here since.

## What was done

**The check came first, and it failed.** `scripts/check-node-pins.mjs` reads `.nvmrc` as the one
declaration that means something, then holds every other declaration against it. Run against
`main` before anything was fixed, it named exactly the four disagreements above and exited 1.

It replaces the thirty-line `run:` block added by #173, for two reasons. That block lived inside
`ci.yml`, so it could only fail *after* a push; this runs in `npm run verify`. And the two new
checks read `package.json`, which in YAML shell would have meant parsing JSON with `sed`.

Three properties worth naming, because each one is a way this kind of check usually fails:

- **An empty match is a failure, not a pass.** If a `FROM` line is rewritten so the pattern stops
  matching, a naive check finds nothing, compares nothing, and reports success — it passes
  precisely when it has stopped working. Demonstrated: rewriting `FROM node:24-bookworm-slim` to
  `FROM docker.io/node:24-bookworm-slim` produces `found nothing to check`, not `ok`.
- **Every disagreement is reported**, not just the first. A version bump usually misses several
  files at once, and the alternative is one round trip through CI per file.
- **A floor and a pin are held to the same major.** `>=22` against a Node 24 runtime claims
  support for something nothing here tests. The repository has one runtime; leniency here is
  what let `>=22` survive a move.
- **Every alternative in a range is checked, and an unreadable range is refused.** The first
  version of `majorsOf` read only the leading number, so `^24.13.4 || ^26.0.0` reported `24`
  and passed while the declaration went on permitting Node 26 — the check saying yes to exactly
  the drift it exists to catch. Found in review on #185. Each `||` alternative is now read
  separately, and an alternative naming more than one version (`>=20 <25`) is reported as
  unverifiable rather than reduced to a guess: picking one end of a range and calling it the
  answer is how a check comes to certify something nobody checked.

**Then the versions were fixed** — and npm made that harder than it should have been. `npm install`
updated the manifests to `^24.13.4` but left the *nested* lockfile entries at 26.3.0, so
`npm ci` cheerfully installed 26.3.0 against a manifest asking for `^24`. `npm ls` reported the
tree as `invalid` and `npm install` still would not repair it; the entries had to be deleted
before npm would re-resolve. This is the same failure class `backend/.npmrc` already records:
`npm ci` replays a lockfile without re-resolving. Left alone, the bump would have looked applied
and changed nothing.

**The typecheck fallout was nil.** #179 was sized M because dropping two majors of type
definitions can reveal real uses of APIs that do not exist on Node 24, each one a latent
production bug. `tsc --build --force` is clean on both halves. Nothing in this repository was
using a Node 25 or 26 API — so the drift had not yet cost anything, and the check is what stops
it costing something later.

## Also here: nine dependencies nobody was watching

Found while adding the `@types/node` ignore rule, which had to be attached to an ecosystem entry
that actually covers the packages declaring it. The npm entry said `directory: /`, and
**Dependabot does not recurse** — the same fact that made every docker run fail in #156, arriving
through a different door.

Issue #164 gave `backend/` its own `package.json` and lockfile. From that merge until this change,
Fastify, pino, TypeScript, Vitest, Biome, `@types/node`, `@vitest/coverage-v8`, `openapi-typescript`
and `yaml` were watched by nothing at all — including for security advisories.

Nothing announced it. The updater kept succeeding, because the directory it was pointed at still
existed and still had updates to offer. **A workspace stops being covered the moment it stops
being a workspace**, and that is worth carrying into #181, which does the same thing to the
frontend.

The `dev-tooling` group gains `group-by: dependency-name` for the reason the container-images
group already gives: with `directories:`, Dependabot's default is one pull request per directory,
and Biome, TypeScript and Vitest are installed in both halves. Ungrouped, one half could take a
Biome major and the other not — and the two halves would then format the same code differently.

## Verified

- `node scripts/check-node-pins.mjs` — 7 declarations, all agree. Observed failing first, on the
  four real disagreements; then observed failing on a hand-broken `FROM` line, for the empty-match
  branch; then, after the review fix, on `"@types/node": "^24.13.4 || ^26.0.0"` (reports the 26
  alternative) and on `">=20 <25"` (reports the range as unverifiable). Each planted value was
  restored and the check re-run clean.
- Frontend `npm run verify` — clean. **1512 tests in 85 files**, identical to the count on `main`
  before this change.
- Backend, standalone — Biome clean, `tsc --build --force` clean, **787 tests in 33 files**,
  coverage 93% statements / 88.48% branches.
- Both lockfiles re-resolved to `@types/node@24.13.4`, hoisted, with `npm ls @types/node` clean.

## Not here

- The `frontend/` move — #181. It rewrites these same `package.json` files, which is why this
  lands first: the typecheck consequences of a version drop should not be tangled with a move.
- Whether `backend` and the frontend should share one Biome and TypeScript version rather than
  two that Dependabot keeps in step. Recorded here, not acted on.
