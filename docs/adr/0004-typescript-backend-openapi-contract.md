# 4. TypeScript backend behind an OpenAPI contract

Date: 2026-08-19

## Status

Accepted

## Context

The backend is small. It handles Google OIDC, mints JWTs, provisions project databases,
manages membership, and will later serve admin and billing endpoints. Device data never
passes through it — the browser replicates straight to CouchDB.

Quarkus and Node/TypeScript were both genuinely viable, and the developer is comfortable in
Java.

**For Quarkus:** excellent OIDC support out of the box, native image compiles to a small
fast binary suited to a modest droplet, and a mature ecosystem.

**For TypeScript:** one language across the stack. That matters more here than usual because
of `packages/core` — the Matter codec, room-path logic, entitlement rules and conflict-merge
functions are needed by *both* the browser and the server. In Java they would have to be
written twice, in two languages, with two test suites, and the two implementations would
drift. A Base38 decoder that disagrees with itself across the wire is a genuinely nasty bug.

The concern about TypeScript is lock-in: choosing it now to save effort, then being unable
to move if the backend grows into something Java suits better.

## Decision

Fastify on Node with TypeScript, and `openapi/matter-manager.yaml` as the source of truth
for the HTTP surface.

The contract is what keeps the Quarkus option real. It is a hand-maintained specification
the implementation must conform to — not documentation generated from the code, which would
merely describe whatever drift occurred.

## Consequences

- `packages/core` is written once and used by browser and server alike. No duplicated
  domain logic, no cross-language drift.
- One toolchain, one test runner, one lint configuration.
- The backend can be reimplemented in Quarkus against the contract without the frontend
  noticing.
- **This only holds if a CI check fails when handlers drift from the contract.** Without
  it, "we kept the option open" quietly stops being true within a month, and the first
  anyone learns of it is when someone tries to use the option. That check is an M4 task,
  not an optional extra.
- Node's Java-relative weaknesses (CPU-bound work, long-lived stateful processes) do not
  apply: this service is I/O-bound glue.
