# M4 — Authentication and backend

**Goal:** users have identities. Still no sync — that is M5. This milestone establishes who
someone is and gives them somewhere to keep their preferences.

---

## M4-1 · Fastify skeleton with the OpenAPI contract

`type:chore` `area:api` `size:M`

**Done when:** the service starts, `/healthz` responds, structured logging is in place, and
routes are typed from `openapi/matter-manager.yaml`.

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

---

## M4-3 · Google sign-in

`type:story` `area:auth` `size:L`

```gherkin
Scenario: a new user signs in
  When I sign in with Google
  Then an account is created and I am returned to the app signed in
  And a user_<sub> database is created for me

Scenario: a returning user signs in
  Then my existing account and preferences are used

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

**Key handling:** the API injects the public key at startup via
`PUT /_node/_local/_config/jwt_keys/rsa:_default`, so key material never enters the image.
CouchDB rejects every JWT until that succeeds, so **the API must fail loudly if it cannot**
rather than starting and serving broken tokens.

---

## M4-5 · Profile and locale preference

`type:story` `area:web` `area:i18n` `size:S`

```gherkin
Scenario: a locale preference is saved and applied
  When I set my language to German in my profile
  Then the interface switches immediately without a reload
  And the preference persists across sessions and devices
```

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
