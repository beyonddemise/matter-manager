# todo-184 — ADR 0004's decision stands, its reasoning does not

Closes #184. The change #164 deliberately deferred:

> On the ADR: this does not change ADR 0004's decision — the backend is still Fastify and
> TypeScript — but it removes the premise that decision rested on. Superseding it deserves its
> own change rather than being buried in a move.

## What was wrong with the record

ADR 0004's strongest recorded argument for TypeScript over Quarkus was shared domain logic:

> the Matter codec, room-path logic, entitlement rules and conflict-merge functions are needed
> by *both* the browser and the server

Its first Consequence followed from that: "`packages/core` is written once and used by browser
and server alike."

Neither was true. #164 counted the imports before moving anything — thirteen symbols each way,
one type alias in common, no functions. And each of the four things named belongs to exactly one
side for a reason that predates the decision:

| named as shared | actually |
| --- | --- |
| the Matter codec | browser-only — the server never sees a payload (ADR 0002) |
| room paths | browser-only — they belong to whichever side holds the documents |
| conflict merge | browser-only, same reason |
| entitlement rules | server-only — a browser evaluating them would be asking the client whether the client is allowed |

After #181 there is no `packages/core` at all, so the record referred to a directory the
repository does not have.

## What the new ADR does

`docs/adr/0017-two-halves-one-contract.md`. It **does not reopen the language choice** —
reversing a decision and correcting the reasoning behind it are different acts, and only the
second is warranted. The backend is Fastify and TypeScript, for the reasons 0004 gave that still
hold: this service is I/O-bound glue.

What changed is *why the Quarkus option stays open*. 0004 kept it open by having one language on
both sides, which would have made a rewrite a translation of shared code. What keeps it open now
is that there is no shared code to translate — one HTTP contract, one hand-declared union, and
two directories that install independently.

The Consequences section is written to be checkable rather than agreeable, and names what must
not be traded away: `openapi.yaml` as the whole agreement, `backend/test/openapi-drift.test.ts`
as the only remaining mechanism that would notice the sides disagreeing, no cross-dependency
between the halves, and `backend/` needing no Web Awesome token. It also states the costs
honestly — domain purity is now enforced by two mechanisms instead of one package boundary, and
Biome/TypeScript/Vitest are installed twice and can drift.

ADR 0004's Status gains a supersession note in the same form it already uses for 0015's
amendment. The index records it.

## One thing the ADR made true rather than assumed

The draft claimed `ProjectRole` is "declared by hand on both sides, each comment pointing at the
other". Only the frontend's comment pointed. The backend's said nothing about the duplication at
all, so a reader arriving from the server side had no way to learn there was a second copy —
which is the whole mechanism by which the two are supposed to stay in step.

`backend/src/domain/ownership.ts` now carries the other half of the pointer, and
`frontend/src/domain/role.ts` cites 0017 rather than the superseded 0004. Both name #183, where
the duplication is recorded for a decision.

## Verified

- Every factual claim in 0017 checked against the tree rather than against #164's description:
  `backend/src/projects/routes.ts` and `backend/src/domain/membership.ts` use `ProjectRole`,
  `frontend/src/domain/role.ts:17` declares it, `backend/test/openapi-drift.test.ts` exists.
- The census table was internally inconsistent on first writing — `ProjectRole` appeared in the
  browser row while being called the overlap. Split into "the API only", "the browser only" and
  "both", which is what #164 actually measured.
- `npm run verify` — exit 0. Frontend 1516 tests in 86 files, backend 787 in 33, both Biome
  runs clean.
