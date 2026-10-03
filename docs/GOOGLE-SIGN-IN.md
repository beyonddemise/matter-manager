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
`backend/src/auth/google.ts`: *"Nothing else: every extra scope is a consent screen that
asks for more than it needs."* The scope list is a one-line edit with a months-long consequence.

## 6. The client

<https://console.cloud.google.com/auth/clients> → **Create client** → Application type
**Web application**

| Field | Value |
| --- | --- |
| Name | Matter Manager API |
| Authorized JavaScript origins | **leave empty** |
| Authorized redirect URIs | `http://localhost:5173/api/auth/google/callback`<br>`https://<app-host>/api/auth/google/callback` |

**Register the address the *browser* is sent back to, which is not the API's own route.** This is
the single most common way to get `redirect_uri_mismatch` here, and it reads as a typo when it is
not one.

`frontend/functions/` forwards `/api/*` from the application's origin to the API and strips the
prefix, so the browser only ever addresses the application. The callback the browser is handed is
therefore `https://app.example/api/auth/google/callback`; the API sees `/auth/google/callback`
after the Function has removed the prefix, and never knows the difference. Google compares the
value against what the browser was sent to, so the registered URI carries the `/api` prefix and
the application's host — **not** `https://<api-host>/auth/google/callback`, which is what this
table said before the proxy existed and what no browser is ever sent to now.

The same is true in development: `vite.config.ts` proxies `/api` to the API for exactly this
reason, so the browser is at `localhost:5173` and the registered URI is
`http://localhost:5173/api/auth/google/callback`, not `localhost:3000`. Register it even for a
production-only deployment — without it nobody can run the sign-in flow on their own machine.

If you drive the API directly on `:3000`, bypassing Vite, add
`http://localhost:3000/auth/google/callback` as well and set `GOOGLE_REDIRECT_URI` to match
whichever one you are actually using. It is one field; it has to name one URI.

The two lists are not symmetric, and mixing them up costs an afternoon:

- **Redirect URIs** are compared byte for byte — scheme, host, port, path, trailing slash. No
  wildcards, and `http` is refused except on `localhost`. The path `/auth/google/callback` is
  fixed in `auth/routes.ts`, but what the browser is sent to is that path *behind whatever
  forwards it*, which is why the registered value has the `/api` in front.
- **JavaScript origins** authorize a *browser* to call Google directly. This flow never does, so
  an empty list is the accurate statement. Filling it in is harmless but describes a flow that
  does not exist here — and a redirect URI pasted into this box is registered as nothing at all,
  which Google reports as `redirect_uri_mismatch` exactly as if you had never added it.

## 7. The environment

Copy the client ID (ends `.apps.googleusercontent.com`) and secret (starts `GOCSPX-`).

| Variable | |
| --- | --- |
| `GOOGLE_CLIENT_ID` | From step 6 |
| `GOOGLE_CLIENT_SECRET` | From step 6 |
| `GOOGLE_REDIRECT_URI` | Byte-for-byte one of the URIs registered in step 6 — the **application** origin with the `/api` prefix, e.g. `https://app.example/api/auth/google/callback` |
| `APP_ORIGIN` | Where the browser is returned to — the same host, no path, e.g. `https://app.example` |
| `JWT_PRIVATE_KEY` | EC P-256 private key, PEM. `openssl ecparam -name prime256v1 -genkey -noout` |
| `JWT_SESSION_PRIVATE_KEY` | A **second** EC P-256 key, generated the same way. Must differ from the one above |
| `JWT_KEY_ID` | Names the key in tokens and in CouchDB's `[jwt_keys]`, e.g. `ec-2026-08` |

**Why two keys.** The public half of `JWT_PRIVATE_KEY` is installed in CouchDB's `[jwt_keys]`, so
anything signed with it is a database credential — and CouchDB checks only a signature and an
expiry, evaluating no claim this service invented. Signing the thirty-day refresh token with it
would therefore make that token a thirty-day direct database credential, whatever this API
thought of the idea. `JWT_SESSION_PRIVATE_KEY` is never given to CouchDB, so a refresh token cannot be
verified there at all. Reusing one key for both undoes this silently; the service refuses to
serve sign-in rather than fall back.

CouchDB (`COUCHDB_URL`, `COUCHDB_ADMIN_USER`, `COUCHDB_ADMIN_PASSWORD`) is needed too: the API reads and
writes user records in the `matter_manager` database there (created on demand; a plain sign-in
creates none).

`APP_ORIGIN` and `GOOGLE_REDIRECT_URI` now share a host, and that is a change worth stating
because the old warning was the opposite. Before `frontend/functions/` existed the application and
the API were different origins — Pages on one, the API wherever you ran it — and the advice was
to keep the two variables apart. The proxy makes `/api` part of the application's origin, so both
values name the application host and differ only in path:

    APP_ORIGIN           https://app.example
    GOOGLE_REDIRECT_URI  https://app.example/api/auth/google/callback

The API host appears in neither. It is named once, in the Pages project's `API_ORIGIN`, which is
what the Function forwards to — and nowhere else, which is the point of the proxy.

`GOOGLE_REDIRECT_URI` is still the API's variable, in that the API is what sends it to Google; the
API never compares it to its own route path, so a value carrying a prefix the API never sees is
not a contradiction.

## What happens when something is missing

**No routes**, rather than routes that fail when pressed. `composition.ts` builds the sign-in
dependencies only when all five of `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`,
`GOOGLE_REDIRECT_URI`, `APP_ORIGIN` and `JWT_SESSION_PRIVATE_KEY` are present, and `buildServer`
registers `/auth/*` only when they are. A half-configured deployment answers `GET /auth/google`
with 404.

`JWT_SESSION_PRIVATE_KEY` is the one that surprises people, because it is not a Google setting and
its absence looks like a Google problem. Sign-in cannot issue a refresh token or handoff without it. **A copy of `JWT_PRIVATE_KEY` counts as
absent**: same key, two names, and the isolation described above is gone — so it is refused rather
than accepted, and the symptom is the same 404.

That is deliberate and it is what to check first: a 404 there means this service, not Google.
`backend/test/composition.test.ts` asserts each variable's absence individually.

## Checking it works

```bash
curl -sI localhost:3000/auth/google | head -1        # 302, not 404
curl -s localhost:3000/auth/google -o /dev/null -D - | grep -i '^location'
```

The `Location` header should be `https://accounts.google.com/o/oauth2/v2/auth?...` carrying
`client_id`, your exact `redirect_uri`, `code_challenge_method=S256` and `state`.

| Symptom | Cause |
| --- | --- |
| 404 on `/auth/google` | One of the five variables is unset or empty |
| 404 on `/auth/google` **and** on `/profile` | `JWT_SESSION_PRIVATE_KEY` is unset, empty, or the same key as `JWT_PRIVATE_KEY` |
| `redirect_uri_mismatch` from Google | `GOOGLE_REDIRECT_URI` differs from the console by a character. Check, in this order: the **`/api` prefix** (the browser is sent to the application's origin, not the API's — see step 6); that it is in **Authorized redirect URIs** and not JavaScript origins; the trailing slash; `http` vs `https`; and that you edited the client whose id the request actually carries — `curl -sS -o /dev/null -D- https://<app-host>/api/auth/google \| grep -i '^location'` prints both the `client_id` and the exact `redirect_uri` being sent |
| `invalid_client` | Wrong client ID or secret, or a secret from a different project |
| Sign-in returns to a 404 | `APP_ORIGIN` points at the API rather than the application |
| Sign-in works, everything else 401s | `JWT_PRIVATE_KEY` is not the EC key CouchDB's `[jwt_keys]` holds — see `auth/keys.ts` |
