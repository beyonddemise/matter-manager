# 15. The OpenAPI contract is checked against, not executed from

Date: 2026-08-27

## Status

Accepted. Amends [ADR 0004](0004-typescript-backend-openapi-contract.md), which chose Fastify
and named the contract the source of truth without saying how the two are joined.

## Context

ADR 0004 committed to two things that do not automatically fit together: **Fastify**, and
`openapi/matter-manager.yaml` as **the source of truth**.

Fastify does not read OpenAPI. Its model is JSON Schema per route, and `@fastify/swagger`
*generates* a specification from those — code-first, which is the opposite direction to the one
ADR 0004 chose. So something has to bridge the two, and M4-2a asks which.

The question underneath is narrower than "which library": **should the specification be checked
against, or executed from?**

Three options were on the table, with figures verified again today rather than taken from the
issue:

| | Runtime cost | Drift protection |
|---|---|---|
| **A. Fastify, contract checked** | none — `openapi-typescript` is a devDependency | Compile-time on declared shapes; CI check for the rest |
| **B. `openapi-backend` on `node:http`** | replaces Fastify: 10 direct dependencies against 15 | structural — routing cannot drift |
| **C. Fastify + `fastify-openapi-glue`** | adds to Fastify: the largest total | structural for routing |

B is the interesting one, because on the headline number it is a *reduction*. Two things about
its dependency list changed the reading:

- it depends on **`lodash`**, which `dependency-policy.json` rejects by name — "Use plain code
  and `structuredClone`";
- it depends on **`mock-json-schema`**, a mocking library, as a production dependency of a
  service that provisions databases and mints credentials.

Fastify's fifteen are its own maintained ecosystem — `pino`, `find-my-way`, `avvio`,
`secure-json-parse` — rather than a general-purpose utility belt arriving underneath a routing
decision.

## Decision

**A. The contract is checked against.**

Fastify stays. `openapi-typescript` generates types from the specification as a *devDependency*,
so the declared request and response shapes are compile-time facts. Nothing new ships.

Drift protection that a compiler cannot give is CI's job (M4-2, #39): the registered routes of
the built application are compared against the specification's paths and methods, and responses
are validated against its schemas in tests. That catches the case none of the three options
catch on their own — **a handler returning something the contract does not declare.**

## Consequences

**Zero new runtime dependencies**, which is [ADR 0013](0013-minimal-runtime-dependencies.md)'s
stated preference and the tiebreaker M4-2a itself names.

**Routing can drift, and CI is what stops it.** This is the real cost of A and it should be
stated plainly: with B or C, a route that exists in the code and not in the specification is
impossible; with A it is merely caught. If #39 is ever weakened or skipped, this decision
quietly becomes the wrong one — so the check is not optional infrastructure, it is the other
half of this ADR.

**ADR 0004's Quarkus escape hatch is unaffected**, and slightly better served. A specification
that is *executed* by a Node library is a specification with a Node library's interpretation
baked into it; one that is merely conformed to stays a plain document another stack can
implement.

**Body parsing, structured logging and graceful shutdown stay Fastify's.** M4-2a warns that
hand-rolling them is "small, but real, and easy to underestimate", and that warning is worth
taking at face value for a service holding the credential path.

## What would change this

- **The API stops being thin.** ADR 0013 already notes `node:http` as the alternative "if the
  API stays thin", and the surface today is nine operations across seven paths, none of them
  touching device data. If it grows a device or sync surface, the calculus changes.
- **`openapi-backend` drops `lodash`.** Its structural routing guarantee is genuinely better
  than a CI check, and that dependency is the main thing standing against it.
- **The CI drift check proves unmaintainable.** If #39 turns out to be a permanent source of
  false failures, the honest response is to move to B or C rather than to disable it.
