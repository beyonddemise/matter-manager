# Todo — #38 · M4-1 Fastify skeleton with the OpenAPI contract

Branch: `38-api-skeleton` (stacked on `40-openapi-approach`)

## Acceptance criteria (from the issue)

> **Done when:** the service starts, `/healthz` responds, structured logging is in place, and
> routes are typed from `openapi/matter-manager.yaml`.
>
> **CouchDB is accessed with native `fetch`.** Write a small typed client — `getDoc`, `putDoc`,
> `putSecurity`, `view`, `createDb` — rather than scattering `fetch` calls.
>
> **Logging rule from the first commit:** payload and passcode fields are never logged at any
> level. Add a redaction list now, while there is nothing to redact.

## Review

**All four met.** 38 tests across the server, the redaction list and the CouchDB client.

### The redaction list, written before there is anything to redact

That ordering is the whole instruction, and it changes what gets written. A list added after an
incident is written by someone reading a log file that already contains the thing; added first,
it is written by someone reasoning about what the application holds.

Besides the usual credential names it covers `payload`, `manualCode`, `passcode` and
`discriminator` — because a Matter payload *encodes* a setup passcode and a manual pairing code
*is* one, and neither looks like a secret to a library's defaults. Matched by **name at any
depth** rather than by path: a payload is a payload whether it arrives as a body field, inside
an array of devices, or nested in an error somebody attached context to.

Censored rather than removed, so a line says a field was present and withheld — removing it makes
a redacted request indistinguishable from one that never carried the field, which is exactly the
distinction someone reading the log is trying to make.

### The CouchDB client is a wrapper for one reason above the others

Authentication and error handling in one place. A `fetch` written at a call site is one where
somebody eventually forgets the credentials header, treats a 409 as a failure, or logs the
response body — and the response body of a project database contains setup passcodes. **No error
from this client ever echoes a body**, and there is a test that plants a payload in an error
response and asserts it does not reach the message.

Three behaviours are decisions rather than plumbing, and each has a test:

- **404 is an answer, not a failure.** "No such project" is something this service acts on;
  throwing would make every caller write the same `try`/`catch`.
- **412 on create is `false`, not an error.** Provisioning something twice is a retried request,
  two tabs, a resumed migration — a caller can be idempotent without inspecting a status code.
- **View parameters are JSON-encoded.** `key=abc` is a parse error where `key="abc"` is a lookup,
  and getting it wrong produces a 400 that reads like a bad query rather than a bad encoding.

Tested against a fake `fetch` rather than a live CouchDB, deliberately: the question here is
"does this client speak CouchDB correctly", and the question "does CouchDB behave this way" is
already answered against a real server in CI by `infra/couchdb/verify-access-model.sh`.

### Decisions in the skeleton

- **`buildServer()` does not listen.** Every route is testable through `.inject()` — no port, no
  socket, no teardown race, no test that fails because a port was busy.
- **`/healthz` says nothing but `ok`**, and does not consult CouchDB. Liveness answers "should
  this process be restarted", and a restart does not fix a database that is down — it turns a
  degraded service into no service. It is also unauthenticated by contract, so anything more it
  reported would be an unauthenticated description of the deployment.
- **A 64KB body limit.** The largest legitimate body here is a membership list; Fastify's default
  megabyte is a megabyte of parsing offered to anyone who asks.
- **Graceful shutdown.** For this service an interrupted request is not a dropped page but a
  half-finished provisioning, where the database exists and its `_security` does not.
