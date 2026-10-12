# GitHub sign-in and auth-method discovery — design

**Status:** design approved in conversation (with `/auth/methods`); spec awaiting review.
Piece 2 of the sign-in epic ([piece 1](2026-10-12-email-signin-design.md)).
**Repos:** `matter-manager-backend` (stacked on its PR #7, which this piece depends on) and this
repo's `frontend/`.
**Date:** 2026-10-12

## Purpose

Installers and technically minded homeowners often have a GitHub account and no Google one — or
simply refuse to use Google for sign-in. Piece 1 built the multi-provider account model
(canonical subject, `subjects` map, `resolveIdentity`, `by_identity`); this piece plugs the first
OAuth provider besides Google into it, and adds the small discovery endpoint every later piece
needs: a chooser that only offers what the deployment can actually do.

## Decisions

1. **An OAuth App, not a GitHub App.** Sign-in needs identity and nothing else; a GitHub App's
   installation model, webhooks and permission system buy nothing here.
2. **Confidential client with PKCE.** The code exchange carries `GITHUB_CLIENT_SECRET` (server
   side only) *and* a PKCE S256 challenge — github.com supports S256 (and only S256) for the web
   flow. State protects the session, PKCE the code, exactly as the Google flow's `OidcFlow`
   documents. GitHub Enterprise Server (no PKCE support) is out of scope; the backend talks to
   github.com.
3. **Scope `user:email`, nothing more.** `GET /user` answers the authenticated account's numeric
   id with any token; `user:email` additionally opens `GET /user/emails`. Every extra scope is a
   consent screen that asks for more than it needs.
4. **Identity is the verified primary address only** (epic decision). The callback reads
   `GET /user/emails` and accepts the entry with `primary: true` **and** `verified: true`. An
   account whose primary address is unverified — or that has no address at all — is **refused**:
   auto-linking keys on the verified address, and accepting an unverified one would let anyone
   claim an address on GitHub and inherit the matching Matter Manager account.
5. **The GitHub subject is the numeric user id**, stringified, in `subjects.github` — stable
   across renames of the login name. The slot is write-once; a mismatch is the existing 409
   `subject-conflict`. `resolveIdentity("github", id, verifiedPrimaryEmail)` does all of it:
   auto-link in both directions on the folded address, canonical sub never rebound.
6. **Discovery is a public endpoint**, `GET /auth/methods`, answered from the same feature flags
   that gate the routes. A GitHub button is a full-page navigation and cannot hide behind a 404
   the way the email option's fetch does; without discovery, an unconfigured deployment dead-ends
   the user on a raw problem page. Piece 3 (passkeys) will extend the same answer.
7. **The GitHub access token is used once and discarded.** It exists only inside the callback
   handler, is never stored, never logged, and never leaves the service.

## The flow

### Start: `GET /auth/github`

A mirror of `startGoogleSignIn`: answers 302 to
`https://github.com/login/oauth/authorize` with `client_id`, `redirect_uri`, `scope=user:email`,
`state`, `code_challenge` (S256) and `code_challenge_method=S256`, and sets the signed `mm_flow`
cookie carrying verifier, state and `returnTo` — the same stateless carrier `OidcFlow` builds for
Google, reused or mirrored (`GitHubFlow`), whichever the implementation finds cleaner; the cookie
contract is identical.

### Callback: `GET /auth/github/callback`

1. Verify `state` against the flow cookie; on `error` or a mismatch, fail as the Google callback
   fails: 302 back to the application with **no** handoff cookie.
2. Exchange the code at `POST https://github.com/login/oauth/access_token`
   (`Accept: application/json`; `client_id`, `client_secret`, `code`, `redirect_uri`,
   `code_verifier`).
3. `GET https://api.github.com/user` → the numeric `id`.
4. `GET https://api.github.com/user/emails` → the `primary && verified` entry, else refuse (same
   failure shape; the reason is logged as a code, never as an address).
5. `resolveIdentity("github", String(id), email)` → canonical subject (409 `subject-conflict`
   surfaces as the failure shape with its problem code, as for Google).
6. `invitations.accept(...)`, `signInLog.record(..., provider: "github", ...)`, mint the
   single-use `mm_handoff` cookie, 302 to the application — byte-for-byte the Google tail.

Both GitHub hosts (`github.com` for authorize/token, `api.github.com` for the API) are
configurable bases in `GitHubConfig` so tests point them at a fake; production defaults stay the
real hosts.

### Discovery: `GET /auth/methods`

Public, no token, tag `auth`, `Cache-Control: public, max-age=300` (it changes only on redeploy).

```json
{ "google": true, "github": false, "email": true }
```

Each flag is the same predicate its route gate uses: `google` from the Google/auth gate's flag,
`github` from `Features::github`, `email` from `Features::mail`. The endpoint never lies about a
route the gate would 404.

### Feature gate and configuration

- `GitHubConfig` (`@ConfigMapping(prefix = "github")`): `clientId`, `clientSecret`, `webBase`
  (default `https://github.com`), `apiBase` (default `https://api.github.com`). Empty strings
  count as unset, as everywhere else.
- `Features.github()` is true only when both `clientId` and `clientSecret` are set.
- A `("auth/github", Features::github)` gate **before** the broader `("auth", ...)` gate,
  first-match-decides — the pattern the email gate established. Unconfigured deployments answer
  404 on both routes, and `methods` says `"github": false`.
- `/auth/methods` sits under the broader auth gate only (it must answer wherever sign-in exists
  at all).
- Rate limiting: the existing per-IP `/auth/*` limits cover all three routes; nothing new.

## API contract (OpenAPI)

Three operations in `matter-manager-backend`'s `src/main/resources/openapi.yaml` (the contract of
record), mirrored verbatim into this repo's `openapi.yaml`:

| Operation | Method and path | Answers |
| --- | --- | --- |
| `getAuthMethods` | `GET /auth/methods` | 200 `AuthMethods` |
| `startGitHubSignIn` | `GET /auth/github` | 302 (consent screen), as `startGoogleSignIn` |
| `completeGitHubSignIn` | `GET /auth/github/callback` | 302 (handoff on success, none on failure), as `completeGoogleSignIn` |

Schema `AuthMethods`: `{ google: boolean, github: boolean, email: boolean }`, all required —
adding a method later is a new required field in both files at once (the mirror rule). Drift and
contract-validation tests grow by the three operations.

## Frontend

- **The chooser renders from `/auth/methods`**, fetched when the dialog opens (the plan-matrix
  pattern: a throw-free client answering `AuthMethods | undefined`, a shell seam for tests). No
  cache document: the dialog needs a connection to sign in anyway, so a cached answer would only
  ever offer buttons that cannot work.
- **Fallback when methods cannot be read** (older deployed API, or offline): exactly today's
  chooser — Google, plus the optimistic email option with its existing 404-hiding. GitHub never
  shows without a readable `methods`, because its dead-end is a full-page navigation.
- When `methods` is readable it is authoritative: the email option shows iff `email: true`
  (the 404-hiding stays as belt and braces), GitHub iff `github: true`.
- **"Sign in with GitHub"** is an outlined button like the email option (Google keeps the
  surface's one filled brand button), navigating to `${API_BASE}/auth/github` exactly as
  `beginSignIn` navigates for Google — the return trip is the existing handoff → token exchange,
  so no new frontend session code. The same injected `signIn`-style seam keeps tests
  navigation-free.
- German (formal Sie): "Mit GitHub anmelden". The brand name stays "GitHub" in both languages.
- Accessibility as #224/piece 1 settled it: the chooser's buttons appear/disappear by state, the
  persistent status region stays, German checked at 360 px.

## Security and logging

- No address, no GitHub access token, no code and no `state`/verifier in any log line, problem
  body or notice. The `SignInLog` line keeps its deliberate exception (reference #212) and gains
  `provider: "github"`.
- The flow cookie, handoff cookie, deny-list and refresh-token semantics are unchanged — the
  GitHub path joins at `resolveIdentity` and inherits everything after it.
- The callback's outbound calls (token exchange, two API reads) carry timeouts like the Google
  flow's; a GitHub outage fails the sign-in, never hangs it.

## Testing

- **Backend:** callback over a fake GitHub (token exchange + `/user` + `/user/emails` stubbed):
  verified primary accepted; unverified-primary and no-email refused with the Google-failure
  shape; `subjects.github` write-once (409 on mismatch); auto-link both directions (GitHub-first
  then Google, email-first then GitHub — the canonical sub never rebinds); state mismatch and
  `error` refused; the gate 404s both routes when unconfigured; `methods` answers each flag
  truthfully in all configurations; contract validation and drift for the three operations;
  JaCoCo gates hold.
- **Frontend:** chooser from a stubbed methods answer (all-on, github-off, unreadable →
  fallback); the GitHub button navigates via the seam; German at 360 px with three buttons.

## Out of scope (later pieces)

- The "sign-in methods" settings UI showing linked providers (piece 3).
- Passkeys (piece 3), Apple (piece 4) — both will extend `AuthMethods`.
- GitHub Enterprise Server support (no PKCE on the web flow there).
- Unlinking a provider, or any account-merge tooling beyond the write-once slots.
