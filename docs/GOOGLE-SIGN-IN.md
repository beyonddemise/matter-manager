# Setting up Google sign-in

What to create in the Google Cloud console, and what to put in the environment. Roughly ten
minutes, once.

Sign-in is **authorization code with PKCE**, server-side. The browser is redirected to Google by
`GET /auth/google`; Google redirects back to `GET /auth/google/callback`; the API exchanges the
code for an ID token in a server-to-server request carrying the client secret. The page never
talks to Google and never holds a Google token.

## 1. A project

<https://console.cloud.google.com/projectcreate>

Any name. Nothing else on the page matters.

## 2. Enable no APIs

Listed as a step because it is the one people go looking for. This service calls exactly one
Google URL beyond the OAuth endpoints — `https://www.googleapis.com/oauth2/v3/certs`, the public
JWKS — and reads the user's identity out of the ID token's own claims. There is no People API or
Google+ API to switch on.

## 3. Branding

<https://console.cloud.google.com/auth/branding>

| Field | Value |
| --- | --- |
| App name | Matter Manager |
| User support email | yours |
| App logo | **leave empty** — uploading one triggers verification review |
| Authorized domains | the registrable domain of the API host, e.g. `matter-manager.example` |
| Developer contact | yours |

## 4. Audience

<https://console.cloud.google.com/auth/audience>

**External**, unless every user is in one Workspace organisation.

Then **Publish app**, moving from *Testing* to *In production*. With only the scopes in step 5
this triggers no verification review. Staying in *Testing* caps you at 100 users and shows an
"unverified app" interstitial before every consent screen.

## 5. Scopes

<https://console.cloud.google.com/auth/scopes>

Exactly three:

```
openid
https://www.googleapis.com/auth/userinfo.email
https://www.googleapis.com/auth/userinfo.profile
```

**Do not add a fourth without reading this paragraph.** These three are *non-sensitive*, which is
why publishing needs no review. Sensitive and restricted scopes — Drive, Gmail, Calendar — put
this project into Google's verification process, and the restricted ones into an annual paid
third-party security assessment. That is the practical meaning of the comment in
`packages/api/src/auth/google.ts`: *"Nothing else: every extra scope is a consent screen that
asks for more than it needs."* The scope list is a one-line edit with a months-long consequence.

## 6. The client

<https://console.cloud.google.com/auth/clients> → **Create client** → Application type
**Web application**

| Field | Value |
| --- | --- |
| Name | Matter Manager API |
| Authorized JavaScript origins | **leave empty** |
| Authorized redirect URIs | `http://localhost:3000/auth/google/callback`<br>`https://<api-host>/auth/google/callback` |

The two lists are not symmetric, and mixing them up costs an afternoon:

- **Redirect URIs** are compared byte for byte — scheme, host, port, path, trailing slash. No
  wildcards, and `http` is refused except on `localhost`. The path `/auth/google/callback` is
  fixed in `auth/routes.ts`; only the host in front of it is yours to choose.
- **JavaScript origins** authorize a *browser* to call Google directly. This flow never does, so
  an empty list is the accurate statement. Filling it in is harmless but describes a flow that
  does not exist here.

Register the `localhost` URI even for a production-only deployment. Without it nobody can run the
sign-in flow on their own machine.

## 7. The environment

Copy the client ID (ends `.apps.googleusercontent.com`) and secret (starts `GOCSPX-`).

| Variable | |
| --- | --- |
| `GOOGLE_CLIENT_ID` | From step 6 |
| `GOOGLE_CLIENT_SECRET` | From step 6 |
| `GOOGLE_REDIRECT_URI` | Byte-for-byte one of the URIs registered in step 6 |
| `APP_ORIGIN` | Where the browser is returned to, e.g. `https://matter-manager-app.pages.dev` |
| `JWT_PRIVATE_KEY` | EC P-256 private key, PEM. `openssl ecparam -name prime256v1 -genkey -noout` |
| `JWT_KEY_ID` | Names the key in tokens and in CouchDB's `[jwt_keys]`, e.g. `ec-2026-08` |

CouchDB (`COUCHDB_URL`, `COUCHDB_ADMIN_USER`, `COUCHDB_ADMIN_PASSWORD`) is needed too: signing in
**writes**, creating or updating the `_users` document that the session then identifies.

`APP_ORIGIN` and the API host are usually **different origins** — the application is on Cloudflare
Pages, the API is wherever you run it. `GOOGLE_REDIRECT_URI` belongs to the API; `APP_ORIGIN`
belongs to the application. Swapping them produces a sign-in that completes and then lands the
user on a JSON endpoint.

## What happens when something is missing

**No routes**, rather than routes that fail when pressed. `composition.ts` builds the sign-in
dependencies only when all of `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GOOGLE_REDIRECT_URI`
and `APP_ORIGIN` are present, and `buildServer` registers `/auth/*` only when they are. A
half-configured deployment answers `GET /auth/google` with 404.

That is deliberate and it is what to check first: a 404 there means this service, not Google.
`packages/api/test/composition.test.ts` asserts each variable's absence individually.

## Checking it works

```bash
curl -sI localhost:3000/auth/google | head -1        # 302, not 404
curl -s localhost:3000/auth/google -o /dev/null -D - | grep -i '^location'
```

The `Location` header should be `https://accounts.google.com/o/oauth2/v2/auth?...` carrying
`client_id`, your exact `redirect_uri`, `code_challenge_method=S256` and `state`.

| Symptom | Cause |
| --- | --- |
| 404 on `/auth/google` | One of the four variables is unset or empty |
| `redirect_uri_mismatch` from Google | `GOOGLE_REDIRECT_URI` differs from the console by a character — check the trailing slash and `http` vs `https` |
| `invalid_client` | Wrong client ID or secret, or a secret from a different project |
| Sign-in returns to a 404 | `APP_ORIGIN` points at the API rather than the application |
| Sign-in works, everything else 401s | `JWT_PRIVATE_KEY` is not the EC key CouchDB's `[jwt_keys]` holds — see `auth/keys.ts` |
