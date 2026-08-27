# Todo — #41 · M4-3 Google sign-in

Branch: `41-google-sign-in` (stacked on `42-couchdb-jwt`)

## Acceptance criteria (from the issue)

```gherkin
Scenario: a new user signs in       → returned signed in with an application-issued JWT,
                                      and a profile document created
Scenario: a returning user signs in → existing account and stored preferences used
Scenario: sign-in is abandoned      → returned signed out, with no partial account created
```

> **Out of scope:** Facebook. The provider layer must be pluggable, but only Google is wired.
>
> Authorization code with PKCE. State parameter validated. Tokens never in `localStorage`.

## Review

**All three scenarios met.** The profile *document* is M4-5's; this PR calls the seam that
writes it and proves the ordering around it.

### Pluggable means swappable, not "has an interface"

`Provider` is three endpoints, a client id, a secret and a redirect URI. `google.ts` supplies
Google's and nothing in `oidc.ts` knows the name. The test suite drives the whole flow through
that interface.

### Where the tokens live, and why each is different

- **PKCE carrier** — httpOnly cookie. The page has no reason to read it, so it cannot.
- **Session** — httpOnly cookie. Its only use is to authorise `POST /auth/token`.
- **CouchDB access token** — response body, held in memory.

The last one is deliberate rather than inconsistent: PouchDB has to put it in an
`Authorization` header, so it must be readable. In memory it dies with the tab; in
`localStorage` it survives and is readable by any script that ever runs on the origin, and it
grants direct access to that user's database.

### `SameSite=Lax`, not `Strict`

Load-bearing. The callback arrives as a **cross-site navigation from Google**, and `Strict`
withholds cookies on exactly that — so sign-in would fail only in production, only after a real
redirect, with a state error that looks like a bug in the state check.

### Four checks, each with a specific attack behind it

| Check | Without it |
|---|---|
| **PKCE (S256)** | An authorization code intercepted in a log, referrer or extension is usable |
| **State** | CSRF: an attacker walks a victim's browser through *their* sign-in, and the victim ends up signed in as the attacker |
| **`aud` on the ID token** | Anybody holding a Google client id can sign their users into this application — the confused-deputy problem |
| **`returnTo` is a path** | An open redirect wearing this application's own domain |

### Ordering that is the feature

`rememberUser` runs **after** the identity is verified and **before** the session is issued. A
failure there means no session, which is the right way round: a failed sign-in can simply be
repeated, whereas a signed-in user whose profile does not exist fails on their next request in a
way nothing explains. There is a test that makes storage fail and checks no session is set.

And "no partial account created" on cancel is a property of that ordering rather than of a
cleanup step — nothing has been written by the time the user presses Cancel.

### What the probe found

8/9, and the survivor was worth chasing. The missing-carrier guard looked redundant because the
other "missing" cases pair a missing state with a carrier that is invalid anyway — refused for
the wrong reason. With a **valid** carrier and no state, dropping the guard compares against
`undefined`, which throws a `TypeError` out of the route as a 500 rather than returning the user
to the application. A test now isolates that case. 9/9 after.

### Also fixed here: the drift check was skipping `$ref` responses

`$ref` was on the checker's *supported keyword* list, so a response declared as
`{ $ref: '#/components/responses/Unauthorized' }` reached the validator as an object with no
`type` and no `properties` — checked thoroughly, found entirely fine. Every `$ref`-shaped
response was waved through, **and the unsupported-keyword guard could not see it because the
keyword was listed as covered.** The loader now resolves local pointers, and a test asserts none
survive.

### Not done here

- The `/profile` operation and what the user document contains — **M4-5**.
- Refreshing a token when replication gets a 401 — the browser's side, with M5's sync work.
- **Real Google credentials.** Everything is exercised against an injected provider; the
  configuration needed is documented in `packages/api/README.md`.
