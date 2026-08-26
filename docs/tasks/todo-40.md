# Todo — #40 · M4-2a Choose how the spec relates to the running API

Branch: `40-openapi-approach` (stacked on `37-print-stylesheet`)

> `type:spike` **← do this before M4-1**

## The question

ADR 0004 committed to Fastify *and* to `openapi/matter-manager.yaml` as the source of truth, and
those two do not automatically fit together: Fastify does not read OpenAPI. So the question is
whether the specification should be **checked against** or **executed from**.

## Decision: A — checked against

Recorded in [ADR 0015](../adr/0015-openapi-checked-not-executed.md), which amends 0004.

### What decided it

The issue names the tiebreaker itself: ADR 0013's preference for zero runtime dependencies.
Option A adds none — `openapi-typescript` is a devDependency.

**Option B was the one worth taking seriously**, because on the headline figure it is a
dependency *reduction*: ten direct dependencies against Fastify's fifteen. I checked the list
today rather than trusting the issue's figures, and two entries changed the reading:

- **`lodash`**, which `dependency-policy.json` rejects by name — "Use plain code and
  `structuredClone`";
- **`mock-json-schema`**, a mocking library, as a production dependency of a service that
  provisions databases and mints credentials.

Fastify's fifteen are its own maintained ecosystem — `pino`, `find-my-way`, `avvio`,
`secure-json-parse` — rather than a general-purpose utility belt arriving underneath a routing
decision.

### The cost, stated plainly

**Routing can drift, and CI is what stops it.** With B or C, a route in the code but not in the
specification is impossible; with A it is merely caught. That makes #39 not optional
infrastructure but the other half of this decision, and the ADR says so — if the check is ever
weakened, this choice quietly becomes the wrong one.

The ADR also records what would change the answer: the API ceasing to be thin, `openapi-backend`
dropping `lodash`, or the drift check proving unmaintainable.

## ⚠️ Worth a second opinion

This is an architectural fork rather than an implementation detail, and it is the one decision
in this run I would most want checked. The reasoning is all in ADR 0015, including the case for
B — if you disagree, the ADR is the thing to argue with, and nothing has been built on it yet.
