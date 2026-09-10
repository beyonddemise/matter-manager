# 17. Two halves and one contract, not a shared package

Date: 2026-09-10

## Status

Accepted. Supersedes the reasoning of
[ADR 0004](0004-typescript-backend-openapi-contract.md) without reversing its decision: the
backend remains Fastify and TypeScript. What changes is *why the option to replace it stays
open*, because the premise 0004 rested on turned out not to be true of this codebase.

## Context

ADR 0004 chose Node and TypeScript over Quarkus, and the strongest reason it recorded was
shared domain logic:

> That matters more here than usual because of `packages/core` — the Matter codec, room-path
> logic, entitlement rules and conflict-merge functions are needed by *both* the browser and
> the server. In Java they would have to be written twice, in two languages, with two test
> suites, and the two implementations would drift.

That sentence describes a repository this never became. Counted against the tree as it stood
immediately before the move (`e7eb0df`), by resolving every `import … from '@matter-manager/core'`
in each half:

| | distinct symbols imported from `core` |
|---|---|
| the API (`packages/api/src`) | **27** — `ACTIONS`, `can`, `canManageMembers`, `planInvitation`, `planTransfer`, `securityFor`, `roleOf`, `grantRole`, `revokeAccess`, `narrowsAccess`, … |
| the browser (`packages/web/src`, `packages/data/src`) | **58** — `readCredential`, `planNewDevice`, `mergeDevice`, `mergeRoom`, `layoutLabels`, `normaliseRoomPath`, `browseDevices`, `resurrectedRooms`, … |
| **shared by both** | **1: `ProjectRole`.** A type alias. **Zero functions.** |

Eighty-four distinct symbols crossed into that package, and exactly one of them crossed into
both.

(#164's own description said "thirteen each way", which is where this record's first draft got
the figure. Re-measuring for this ADR gave 27 and 58 — the conclusion is the same and the
evidence is stronger, but the number is worth getting right in the document that will be cited
for it.)

So the four things 0004 named as shared were never shared, and could not have been: each one
belongs to exactly one side for a reason that predates the decision. `packages/core`'s first
recorded Consequence — "written once and used by browser and server alike" — describes
something that did not happen.

Issue #164 then made the backend a self-contained directory, and #181 did the same for the frontend.
There is no `packages/` any more, and therefore no `packages/core` for 0004's reasoning to
refer to.

## Decision

**The two halves share no package. They share `openapi.yaml`, and nothing else.**

`frontend/` and `backend/` each carry their own `package.json`, lockfile, `tsconfig`, Biome and
Vitest configuration. Each installs, lints, typechecks, tests and builds without the other
present. The repository root owns what spans them and nothing that belongs to either.

The Quarkus option stays open — more genuinely than 0004 arranged, and by a different
mechanism. 0004 kept it open by having one language on both sides, which would have made a
rewrite a *translation* of shared code. What keeps it open now is that there is no shared code
to translate: replacing the backend is a change to one directory, behind one HTTP contract.

`ProjectRole` is the one alias each half declares in its own source rather than reading from the
contract, and it is written by hand in both, each comment pointing at the other. Plenty of values
cross this boundary — that is what `openapi.yaml` is for; this is the only *duplicated* one. One
four-value union does not justify a build boundary, and a shared
TypeScript type could not survive a non-TypeScript backend anyway. Whether it should instead be
generated from `openapi.yaml` is [#183](https://github.com/beyonddemise/matter-manager/issues/183),
open deliberately: it is a decision, not an oversight.

## Consequences

**What is now load-bearing, and must not be traded away:**

- **`openapi.yaml` is the whole agreement.** It was one input among several under 0004, when a
  shared package carried real weight. It now carries all of it.
- **The drift check is what makes that true rather than aspirational.** ADR 0015 chose checking
  over executing, and 0004 already warned that without such a check "we kept the option open"
  quietly stops being true within a month. That warning is stronger now, not weaker:
  `backend/test/openapi-drift.test.ts` is the only *automated* mechanism that would notice the
  two sides disagreeing.

  Its reach is exactly the contract, and no further. `ProjectRole` is declared in source on both
  sides, so **no test would fail if the two declarations diverged** — that is the case #183
  exists to close, and until it does the guard is two comments pointing at each other. Worth
  stating plainly, because "the drift check covers it" is the assumption that would let a fifth
  role be added to one side only.
- **Neither half may take a dependency on the other's package.** Not a style rule. It is the
  property that makes "replace this directory" a bounded change, and it would be dissolved by a
  single convenient import.
- **`backend/` needs no Web Awesome Pro token.** A side effect worth naming, because it is load-
  bearing for contribution: a fork's backend pull request passes CI, where the frontend's
  structurally cannot (issue #18).

**What this costs:**

- **Domain purity inside `frontend/` is no longer structural.** `packages/core` enforced it by
  being a separate TypeScript project with an empty dependency list. #181 replaces that with
  `frontend/tsconfig.domain.json` (no `lib` beyond ES2023, no `types`) and
  `frontend/test/domain/purity.test.ts` (transitive import walk). Two mechanisms rather than
  one boundary — which is more to maintain, and the trade accepted for deleting a package that
  had one consumer.
- **Shared tooling versions can drift.** Biome, TypeScript and Vitest are installed twice.
  `.github/dependabot.yml` groups them with `group-by: dependency-name` so updates arrive
  together; without that the halves could format the same code differently.
- **A genuinely shared pure function would now be awkward.** None exists, and the census above
  is the evidence rather than an assumption. If one ever does, this ADR is the record to
  supersede — the answer is likely to be `openapi.yaml` growing a schema, not `packages/`
  coming back.

**What does not change:** the backend is Fastify on Node with TypeScript, for the reasons 0004
gave that still hold — this service is I/O-bound glue, and Node's Java-relative weaknesses do
not apply to it. Reversing a decision and correcting the reasoning behind it are different
acts, and only the second one is warranted here.
