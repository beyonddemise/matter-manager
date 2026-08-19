# M4 — Authentication and backend

**Goal:** users have identities. Still no sync — that is M5. This milestone establishes who
someone is and gives them somewhere to keep their preferences.

---

## M4-1 · Fastify skeleton with the OpenAPI contract

`type:chore` `area:api` `size:M`

**Done when:** the service starts, `/healthz` responds, structured logging is in place, and
routes are typed from `openapi/matter-manager.yaml`.

**CouchDB is accessed with native `fetch`.** No `nano`, no `couchdb`, no `axios` — those
packages predate global `fetch` and carry their own HTTP stack for what is now a few lines
([ADR 0013](../adr/0013-minimal-runtime-dependencies.md)). Verified: create, read, write,
`_security` and `_changes` all work over plain `fetch` against CouchDB 3.5.2.

Write a small typed CouchDB client in `packages/api` — `getDoc`, `putDoc`, `putSecurity`,
`view`, `createDb` — rather than scattering `fetch` calls. That is a thin wrapper we own and
test, not a dependency.

**Logging rule from the first commit:** payload and passcode fields are never logged at any
level. Add a redaction list now, while there is nothing to redact, rather than after
something leaks.

---

## M4-2 · OpenAPI drift check in CI

`type:chore` `area:api` `size:M`

**Story:** as the project owner, I want the Quarkus option to stay genuinely open, so the
backend language is a reversible decision.

```gherkin
Scenario: a handler that does not match the contract fails CI
  Given a route whose response shape differs from the specification
  When CI runs
  Then it fails and names the mismatch

Scenario: an undocumented route fails CI
  Given a route absent from the specification
  Then CI fails
```

**This issue is the whole value of [ADR 0004](../adr/0004-typescript-backend-openapi-contract.md).**
Without it, "we kept the option open" quietly becomes false within a month, and nobody finds
out until they try to use it.

**Fastify does not read OpenAPI.** Its model is JSON Schema per route, and `@fastify/swagger`
*generates* a spec from those — code-first, the opposite direction to what ADR 0004 wants.
Spec-first plugins exist (`fastify-openapi-glue`, `openapi-backend`) but are runtime
dependencies, which [ADR 0013](../adr/0013-minimal-runtime-dependencies.md) resists.

**Use build-time tooling instead**, so this costs nothing at runtime:

1. `openapi-typescript` (a **devDependency**) generates types from `openapi/matter-manager.yaml`
2. Handlers are typed against them, so a response-shape mismatch is a *compile error*
3. A small script derives Fastify's route schemas from the spec's own JSON Schema components,
   giving runtime validation from the same source
4. CI regenerates and runs `git diff --exit-code`, failing when the committed output no longer
   matches the spec

**Verify the check by breaking it on purpose** before trusting it: change a handler's response
shape and confirm CI goes red, and add an undocumented route and confirm the same. A drift
check that has never caught drift has not been shown to catch drift.

---

## M4-3 · Google sign-in

`type:story` `area:auth` `size:L`

```gherkin
Scenario: a new user signs in
  When I sign in with Google
  Then I am returned to the app signed in with an application-issued JWT
  And a profile document is created in the _users database

Scenario: a returning user signs in
  Then my existing account and the preferences stored in _users are used

Scenario: sign-in is abandoned
  When I cancel at Google's consent screen
  Then I return to the app signed out, with no partial account created
```

**Out of scope:** Facebook. The provider layer must be pluggable, but only Google is wired.

**Implementation note:** authorization code with PKCE. State parameter validated. Tokens
never in `localStorage`.

---

## M4-4 · Mint CouchDB-validatable JWTs

`type:story` `area:auth` `security` `size:M`

```gherkin
Scenario: a token authenticates directly against CouchDB
  Given a signed-in user
  When the app requests an access token
  Then CouchDB accepts it for that user's own database
  And the API is not involved in that request

Scenario: an expired token is refreshed transparently
  Given replication receives a 401
  Then the client refreshes and retries
  And no local write was blocked while this happened

Scenario: a token for one user cannot open another's database
  Then access is denied
```

**Tokens are ES256** (EC P-256), not RS256 — smaller signatures on every replication request
for equivalent security. Verified working against CouchDB 3.5.2, including correct rejection
of expired tokens, tokens signed with another key, and tokens whose payload was edited to
claim a different `sub`.

**Signing and verification use `node:crypto` directly.** No `jose`, no `jsonwebtoken`
([ADR 0013](../adr/0013-minimal-runtime-dependencies.md)). Verified end to end, including the
part that looks like it needs a library:

```js
// ES256 requires the raw R||S pair; Node emits DER without dsaEncoding.
sign.sign({ key, dsaEncoding: 'ieee-p1363' })

// Google publishes JWKS; node:crypto imports those keys directly.
createPublicKey({ key: jwk, format: 'jwk' })
```

That second line is the one that usually motivates pulling in `jose`. It is not needed.

**Key handling.** The API injects the public key via
`PUT /_node/<node>/_config/jwt_keys/ec:<kid>`, so key material never enters the image.

```gherkin
Scenario: the key is confirmed in effect before serving traffic
  Given the API has written its public key to CouchDB's config
  When it mints a token and checks CouchDB accepts it
  And CouchDB does not
  Then the API refuses to serve traffic and says why

Scenario: rotation does not interrupt anyone
  Given tokens are being issued under kid A
  When a new key is added under kid B and issuance switches to B
  Then tokens carrying kid A continue to validate
  And no replication is interrupted
```

**`[jwt_keys]` is applied live** — verified against 3.5.2 — which is what makes that second
scenario achievable. Name keys by `kid` so old and new coexist.

**The trap is a neighbouring setting.** `[chttpd] authentication_handlers` is read only at
*startup*: setting it at runtime returns `200`, does nothing, and leaves every request
authenticating as **anonymous** rather than failing. Production bakes it into the image, so
this bites during experimentation rather than in operation — but it costs an afternoon if you
assume the two settings behave alike. They do not.

---

## M4-5 · Profile and locale preference

`type:story` `area:web` `area:i18n` `size:S`

```gherkin
Scenario: a locale preference is saved and applied
  When I set my language to German
  Then the API updates my profile document in _users
  And the interface switches immediately without a reload
  And the preference persists across sessions and devices

Scenario: my locale is available offline
  Given my profile was fetched at least once
  When I reload with no connectivity
  Then the interface is still German
```

**The profile is read through `GET /profile`, not from CouchDB directly.** A
JWT-authenticated browser cannot read `_users` at all — not even its own document; it gets a
`403`. Verified against CouchDB 3.5.2. That is why the second scenario exists: the value has
to be cached in `mm-local` (M2-4b) or the preference is simply unavailable offline.

---

## M4-6 · Wire the entitlement seam into the API

`type:chore` `area:api` `size:S`

Every gated endpoint calls `can(principal, action, project)` — which still returns true.

```gherkin
Scenario: no gated action bypasses the seam
  Then a test enumerates gated actions and asserts each route calls the seam
```

That enumeration test is what makes the seam real rather than decorative.

---

## M4-7 · Sign out and session expiry

`type:story` `area:auth` `size:S`

```gherkin
Scenario: signing out clears local data
  When I sign out
  Then tokens are discarded and local databases are removed from this browser

Scenario: expiry while offline does not destroy work
  Given my session expired while I was offline
  When I reconnect
  Then I am prompted to sign in again
  And no unsynced local change was lost
```

**The second scenario is the important one.** Discarding unsynced work because a token
expired would be catastrophic and is an easy mistake to make.

---

## M4-8 · Rate limiting and security headers

`type:chore` `area:api` `security` `size:S`

Rate limits on auth endpoints, CORS restricted to known origins, standard security headers,
request body size caps.
