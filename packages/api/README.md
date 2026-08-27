# @matter-manager/api

The Fastify backend. Deliberately thin.

**Created in M4.** The skeleton, the CouchDB client and the logging redaction are M4-1.

## What belongs here

- Google OIDC (authorization code + PKCE) and JWT minting
- Project provisioning: create `project_<uuid>`, write `_security`, install `_design/access`
- Membership changes, invitations, ownership transfer
- Injecting the JWT public key into CouchDB at startup via
  `PUT /_node/_local/_config/jwt_keys/ec:<kid>`
- Admin and audit endpoints (M7), billing webhooks (M8)

## What does not

Anything sync-related. Replication goes **browser → CouchDB directly**, authenticated by a
JWT that CouchDB validates itself using the public key. Proxying replication through this
service would put it on the critical path of every document, for no benefit.

## The OpenAPI contract

`openapi/matter-manager.yaml` is the source of truth, not a generated afterthought. It
exists so the backend could be reimplemented in Quarkus without touching the frontend
(ADR 0004). A CI check that fails when handlers drift from the contract is what keeps that
option real — without it, "we kept it open" quietly becomes false.

## Dependencies

**CouchDB is accessed with native `fetch`.** No `nano`, no `couchdb`, no `axios` — they
predate global `fetch` and bring their own HTTP stack for what is now a few lines
([ADR 0013](../../docs/adr/0013-minimal-runtime-dependencies.md)).

**JWT signing and verification use `node:crypto`.** No `jose`, no `jsonwebtoken`. The two
pieces that usually motivate a library:

```js
// ES256 needs the raw R||S pair; Node emits DER without this.
signer.sign({ key, dsaEncoding: 'ieee-p1363' })

// Google publishes JWKS; node:crypto imports those keys directly.
createPublicKey({ key: jwk, format: 'jwk' })
```

Both verified working, along with rejection of expired and wrongly-signed tokens.

Prefer a small typed CouchDB client here (`getDoc`, `putDoc`, `putSecurity`, `view`,
`createDb`) over scattered `fetch` calls — a thin wrapper we own and test, not a dependency.

## Running it

```bash
npm run typecheck                       # builds dist/
npm --workspace @matter-manager/api start
curl localhost:3000/healthz             # {"status":"ok"}
```

`buildServer()` returns an instance that **does not listen**, which is what makes every route
testable through Fastify's `.inject()` — no port, no socket, no teardown race. `main.ts` is the
only thing that binds, and is deliberately short enough that nothing hides in it.

## Types from the contract

```bash
npm --workspace @matter-manager/api run openapi:types
```

`src/generated/openapi.ts` is produced from `openapi/matter-manager.yaml` by
`openapi-typescript` and **committed**, so a fresh clone builds without a code-generation step —
the same reasoning the translation catalogue follows. A handler returning a shape the contract
does not declare is a compile error.

What a compiler cannot check — that the registered routes are exactly the operations the
contract describes — is M4-2's CI check. [ADR 0015](../../docs/adr/0015-openapi-checked-not-executed.md)
is explicit that this is not optional infrastructure but the other half of the decision to check
the contract rather than execute it.

## Logging

`src/logging.ts` holds the redaction list, and it was written **before there was anything to
redact** — which is the point. A list added after an incident is written by someone reading a
log that already contains the thing.

Besides the usual credential names it redacts `payload`, `manualCode`, `passcode` and
`discriminator`: a Matter payload encodes a setup passcode and a manual pairing code *is* one,
and neither looks like a secret to a library's defaults.

## The CouchDB client

`src/couch/client.ts` — `getDoc`, `putDoc`, `createDb`, `putSecurity`, `getSecurity`, `view`,
over native `fetch`. Written rather than installed (ADR 0013): `nano` and friends predate global
`fetch` and carry an HTTP stack for what is a few lines here.

It is a wrapper rather than scattered `fetch` calls chiefly so that **authentication and error
handling happen in one place**. A `fetch` at a call site is one where somebody eventually forgets
the credentials header, treats a 409 as a failure, or logs the response body — and the response
body of a project database contains setup passcodes. No error message from this client ever
echoes a response body; there is a test for that.

## Sign-in

Authorization code with PKCE. Three modules:

| | |
|---|---|
| `auth/oidc.ts` | The flow, provider-agnostic. PKCE, state, the code exchange. |
| `auth/google.ts` | Google's endpoints, and ID-token verification against its JWKS. |
| `auth/routes.ts` | The three operations the contract declares. |

**Tokens never touch `localStorage`.** The PKCE carrier and the session are **httpOnly** cookies
the page cannot read. The CouchDB access token is returned by `POST /auth/token` in a response
body, because PouchDB has to put it in an `Authorization` header — so it is held in memory,
where it dies with the tab, rather than in storage, where it survives and is readable by any
script that ever runs on the origin.

**The routes are absent when no provider is configured**, rather than present and answering with
a misconfiguration error at the moment a user presses the button.

### Configuration

Step-by-step, with the console URLs: [docs/GOOGLE-SIGN-IN.md](../../docs/GOOGLE-SIGN-IN.md).

`composition.ts` builds these into `ServerOptions.auth`, and `buildServer` registers `/auth/*`
only when it is present — so a deployment missing any one of the first four answers
`GET /auth/google` with **404** rather than with a misconfiguration error.

| Variable | |
|---|---|
| `GOOGLE_CLIENT_ID` | From the Google Cloud console, OAuth 2.0 Client ID (Web application) |
| `GOOGLE_CLIENT_SECRET` | Same screen |
| `GOOGLE_REDIRECT_URI` | Must match what is registered **exactly**, e.g. `https://api.matter-manager.example/auth/google/callback` |
| `APP_ORIGIN` | Where the browser is returned, e.g. `https://matter-manager.pages.dev` |
| `JWT_PRIVATE_KEY` | EC P-256 private key, PEM. `openssl ecparam -name prime256v1 -genkey -noout`. **Its public half goes into CouchDB**, so anything signed with it is a database credential |
| `JWT_SESSION_PRIVATE_KEY` | A **second**, different EC P-256 key, for session cookies and PKCE carriers. Never given to CouchDB |
| `JWT_KEY_ID` | Names the key in tokens and in CouchDB's `[jwt_keys]`, e.g. `ec-2026-08` |

None of these are in the repository and none should be. The public half of `JWT_PRIVATE_KEY` is
pushed into CouchDB at startup (`auth/keys.ts`), so key material never enters the image.

## Protecting the service

Rate limits, cross-origin access, the headers on every response and a cap on request bodies
(#47). The limits are in-process and that constrains the deployment — see
[ADR 0016](../../docs/adr/0016-in-process-rate-limiting.md).

| Variable | |
|---|---|
| `CORS_ORIGINS` | Comma-separated origins allowed to make cross-origin requests. `APP_ORIGIN` is included automatically, so this is only needed for a second front end |
| `TRUST_PROXY` | `true` when the service runs behind a proxy that sets `X-Forwarded-For` |

**`TRUST_PROXY` matters in both directions.** Unset behind a proxy, every request appears to
come from the proxy, one address is counted for everybody, and the first twenty sign-in attempts
from anywhere lock out the world. Set where there is no trusted proxy, any client can claim any
address and the limit is off. There is no default that is right for both, so the deployment says
and the default trusts nothing.

**A bad origin stops the service starting.** `https://app.example/` is tolerated, but a value
with a path, a wildcard, or something that is not a URL throws before anything listens. The
alternative failure — the real application quietly refused, in production — looks exactly like a
browser problem.

Nothing configured means **no** cross-origin access, which is why a deployment that forgets
`APP_ORIGIN` refuses the application rather than admitting the internet.
