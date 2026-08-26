# Todo — #39 · M4-2 OpenAPI drift check in CI

Branch: `39-openapi-drift` (stacked on `38-api-skeleton`)

## Acceptance criteria (from the issue)

```gherkin
Scenario: a handler that does not match the contract fails CI
Scenario: an undocumented route fails CI
```

> **This issue is the whole value of ADR 0004.**
>
> **Verify the check by breaking it on purpose** before trusting it. A drift check that has never
> caught drift has not been shown to catch drift.

## Review

**Both scenarios met, and both verified by breaking the build on purpose.**

### Broken deliberately, twice, with the output recorded

The issue asks for this and it is not ceremony — a drift check is the kind of thing that passes
forever while checking nothing.

**Response drift.** `/healthz` was changed to return `{ status: 'degraded' }`:

```
× GET /healthz matches its declared response
  AssertionError: expected [ { at: '$.status', … } ] to deeply equal []
  +  "says": "must be \"ok\", got \"degraded\"",
```

It fails **and names the mismatch**, which is the scenario's actual wording.

**An undocumented route.** `GET /undocumented-on-purpose` was registered:

```
× registers nothing the contract does not describe
  AssertionError: expected [ 'GET /undocumented-on-purpose' ] to deeply equal []
```

Both restored, and both drifts are now also asserted permanently against a purpose-built
server — so the proof is kept rather than described.

### It is a test, not a script

CI already runs the tests, and a check that lives beside the code it checks is one people run
before pushing rather than one they discover in a failed pipeline.

### Routes are collected from Fastify, not parsed out of its output

Through the `onRoute` hook. `printRoutes()` produces a tree for humans whose shape is not a
contract — a check built on it breaks when Fastify changes its box-drawing characters, and,
far worse, could silently stop matching anything and report no drift at all.

`HEAD` is excluded: Fastify registers one alongside every `GET`, and a contract that had to
declare them would be a contract describing Fastify rather than this service.

### Three ways this check could have quietly stopped checking

Each one has a guard, because a drift check that reports nothing looks exactly like a codebase
with no drift.

1. **The contract fails to parse, or moves.** Every assertion compares two sets, and two empty
   sets agree perfectly. A positive control asserts the contract yields more than five
   operations and contains `GET /healthz`.
2. **The validator meets a keyword it does not know.** A partial validator that ignores what it
   cannot check reports success for a `oneOf` it never looked at. `unsupportedKeywords` fails
   the suite if the contract grows one. **This guard caught a bug in itself on its first run** —
   the traversal treated property *names* as schema keywords, and reported `status`,
   `accessToken` and `expiresIn` as unknown.
3. **Nothing is implemented yet.** An empty list of implemented operations would let the
   response check pass without checking a response. Asserted to be non-empty.

### Unimplemented operations are reported, not failed

Mid-milestone most of the contract is unimplemented by design, and a check that failed on that
would be a check nobody could keep green — which is how checks get disabled. The nine pending
operations are asserted as a **known list**, so implementing one is a deliberate edit here
rather than a silent change in how much the drift check covers.

### The validator is hand-rolled, and says why

Same reasoning as the PDF text extractor: it only has to check documents *this* contract
describes. Ajv arrives transitively under Fastify but is not declared by anything here, and
declaring it for a forty-line job is a dependency-policy conversation (ADR 0013). `yaml` *is*
added, as a root devDependency — Node has no built-in parser, and hand-rolling one for the file
the entire HTTP contract lives in is exactly the wrong place to be clever.
