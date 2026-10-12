# Email sign-in and multi-provider accounts — design

**Status:** design approved in conversation; spec awaiting review. Piece 1 of the sign-in epic.
**Repos:** `matter-manager-backend` (the Java backend of record) and this repo's `frontend/`. The retiring TypeScript backend gets none of this.
**Date:** 2026-10-12

## Purpose

Today the only way into Matter Manager is a Google account. That excludes homeowners and
installers who do not have one or will not use one. This epic adds sign-in methods; this piece
adds the foundation they all build on, plus the first and most load-bearing method: signing in
with an email address and a one-time code.

## The epic, decomposed

Each piece is its own spec → plan → PR cycle and produces working software on its own.

| Piece | Content | Depends on |
| --- | --- | --- |
| **1 (this spec)** | Multi-provider account model, outbound email, email-code sign-in | — |
| 2 | GitHub OAuth (identity from the *verified primary* address only) | 1 |
| 3 | Passkeys (WebAuthn), plus the "sign-in methods" settings UI | 1 |
| 4 | Apple (prerequisite: paid developer account; must answer the Hide-My-Email relay question) | 1 |

Meta products are excluded by decision. GitLab/Bitbucket/Amazon/X were considered and dropped.

## Decisions

1. **Auto-link on verified email.** The same verified address through a second method lands in
   the same account. An account stays keyed by its folded address.
2. **One canonical subject per account.** Project membership and CouchDB access are keyed by the
   token's `sub`, so an account presents the same subject however it signed in. The canonical
   subject is set once and never rebound.
3. **Email sign-in uses a one-time code, not a magic link.** A clicked link opens the device's
   default browser, which for an installed PWA is often not where sign-in started. A typed code
   stays in the context the user started in.
4. **The secret is split across two channels.** Starting a sign-in returns a random *challenge
   id* to the requesting client; the code goes only to the mailbox. Verification requires both,
   so an intercepted email is useless without the challenge id, which never leaves the
   requesting device.
5. **Outbound mail goes through Cloudflare Email Service**, behind a small `MailSender` port so
   the vendor stays swappable. The zone's DNS already lives on Cloudflare.
6. **The start endpoint answers 202 with a JSON body** (MDN documents 202 with bodies).
7. **Signing in creates no record**, for email exactly as for Google today. Records come from
   `ensureRecord` when something needs keeping.

## Account model

### Canonical subject and the `subjects` map

The user record's existing `sub` field becomes the **canonical account subject**: the value in
every token's `sub` claim, in project membership, and in the `by_sub` view. Once set it is never
rebound — memberships depend on it.

A new optional field holds authentication identities:

```json
{
  "_id": "user:…",
  "type": "user",
  "sub": "110248495921238986420",
  "subjects": { "google": "110248495921238986420", "github": "8341702" },
  "email": "ada@example.com",
  "…": "unchanged fields"
}
```

- Each `subjects` slot is **write-once**: filling an empty slot is auto-linking; a different
  value for a filled slot is refused with the existing 409 `subject-conflict`. The anti-takeover
  rule the Java backend already enforces moves from "the one sub" to "each provider's slot".
- Slots are written **at sign-in completion**, where the provider is known: every provider
  sign-in resolves `(provider, providerSubject, verifiedAddress)` against the record —
  returning the canonical sub for the session, filling the provider's empty slot, or refusing a
  filled slot's mismatch. This applies to the **Google callback too**: an account whose
  canonical sub is `mail:…` must still be able to sign in with Google (auto-link works in both
  directions), so the callback's session subject is the record's canonical sub, not necessarily
  Google's.
- **Legacy records need no migration.** Until now Google was the only provider, so a record with
  `sub` not prefixed `mail:` and no `subjects.google` is read as `subjects.google = sub`. The
  next write through the new code normalizes the map; the `sub` field itself is never altered.
- Accounts first seen through email have no external identity authority, so their canonical
  subject is **derived deterministically from the address**:
  `"mail:" + lowercaseHex(sha256(foldedAddress)[0..15])` (the first 16 bytes, 32 hex
  characters; folding is the existing `Emails.fold`). Stable across sign-ins with no stored
  state, not reversible, and therefore safe in logs — which is half the reason it is a hash.
  Email sign-in itself adds **no** `subjects` entry: possession of the address *is* the
  identity, and the address is already the record's key.
- A recordless email user carries the derived sub in their token. When something later needs a
  record, `ensureRecord` seeds it with that sub, exactly as it seeds Google subs today. If that
  account later signs in with Google, the Google subject fills `subjects.google` and the
  canonical `mail:` sub stays — rule 2 above.
- `ensureRecord` therefore gains the provider dimension: `ensure(provider, subject, email,
  displayName)`. Same provider + different subject on a filled slot → 409 `subject-conflict`.
  Different provider → fill that slot, leave the canonical sub alone.

### Views

- `by_sub` is unchanged: it emits the canonical `sub`.
- A new `by_identity` view emits `[provider, subject] → null` for every entry in `subjects`
  (and, for legacy records, the implied `["google", sub]`). Piece 1 installs it next to
  `by_sub`/`by_plan_requested` in `ensureDatabase()`; pieces 2 and 4 are its consumers
  (resolving an OAuth callback's subject to a record). Email sign-in does not read it — the
  address is the key.

## Email-code sign-in flow

### Start: `POST /auth/email`

Request body: `{ "email": "ada@example.com" }`.

- **202** with body `{ "challenge": "<id>" }` for any well-formed address, whether or not an
  account exists — there is nothing to enumerate, since any address may sign in. The challenge
  id is 128 bits from `SecureRandom`, base64url without padding (22 characters).
- **400** (problem+json) for a malformed address.
- **429** when rate-limited: at most **3 sends per folded address per 15 minutes**, plus the
  per-IP limiting the backend already applies to auth routes.

Side effects: mint a **6-digit code** (`SecureRandom`, 000000–999999, leading zeros kept),
store a challenge keyed by the challenge id — folded address, `sha256(code)`, expiry **10
minutes**, attempt counter 0 — and hand the address, locale and code to the `MailSender`.
Storage is **in memory** (precedent: `InMemoryRefreshStore`; the deployment is a single
container, and a restart losing 10-minute challenges is harmless — the user requests a new
code). The plaintext code exists only inside the email.

### Verify: `POST /auth/email/{challenge}`

Request body: `{ "code": "123456" }`. The address appears nowhere in this request — the
challenge binds it.

- **200** on success with the same body `POST /auth/token` answers —
  `{ accessToken, expiresIn, refreshToken }` — because this backend keeps the refresh token in
  the page, not in a cookie: the `mm_handoff` cookie exists only to bridge the Google redirect
  flow, and a fetch-based verify needs no bridge. Verification mints the refresh token
  (remembering its hash) and the access token in one step, exactly as the first
  `POST /auth/token` after a Google callback does. The token `sub` is the record's canonical
  sub, or the derived `mail:` sub when no record exists; `_couchdb.roles` carries the plan as
  today. The challenge is consumed: a second use is a 401.
- **401** (problem+json, `title: "Sign-in failed"`) for *every* failure — unknown, expired,
  consumed or attempt-exhausted challenge, and a wrong code alike. The answer never reveals
  which half the caller is missing.

Code comparison is constant-time over the hashes. The **fifth** wrong code invalidates the
challenge. Expired challenges are purged lazily on access and by a sweep on each start call.

### The email

Localized (`en`/`de`, formal Sie), subject and body carry the product name, the code, and its
10-minute validity — no links, no greeting by name, no other personal data. Plain text plus a
minimal HTML alternative.

## Sending infrastructure

- **Port:** `MailSender.send(to, locale, template, params)` in the backend; the email-code
  template is its first user.
- **Adapter:** Cloudflare Email Service over its REST API. New environment variables
  `MAIL_API_TOKEN` and `MAIL_FROM` (e.g. `signin@matter-manager.io`); an empty string counts as
  unset, as for every other variable there.
- **Feature gate:** the two `/auth/email*` routes are **absent** when mail is unconfigured
  (a new `FeatureGateFilter` gate on a `Features::mail` flag), following the backend's
  convention that unconfigured features 404 rather than fail at the moment a user presses the
  button.
- **DNS:** SPF/DKIM/DMARC for the sending domain are a one-time task in the Cloudflare zone
  console, documented in the backend's infra docs. Sending is verified end to end before the
  frontend piece ships.

## API contract (OpenAPI)

Two operations, tag `auth`, in `matter-manager-backend`'s `src/main/resources/openapi.yaml`
(the contract of record; this repo's `openapi.yaml` is retired with the TS backend):

| Operation | Method and path | Answers |
| --- | --- | --- |
| `startEmailSignIn` | `POST /auth/email` | 202 `EmailChallenge`, 400, 429 |
| `completeEmailSignIn` | `POST /auth/email/{challenge}` | 200 `TokenResponse` (as `issueToken`), 401 |

Schemas: `EmailSignInStart` `{ email: string (format: email, required), locale?: enum [en, de] }`
(the app sends its active locale for the email's language; absent means `en`),
`EmailChallenge` `{ challenge: string }` (required),
`EmailSignInCode` `{ code: string, pattern: ^[0-9]{6}$ }` (required).
The `Profile` schema is untouched in this piece. Drift and contract-validation tests grow by
the two operations.

## Frontend

- The sign-in affordance becomes a **method chooser**: the Google button (unchanged, the one
  filled brand button) plus "Sign in with email" (DE: "Mit E-Mail anmelden"), which reveals an
  address field and a send button.
- After a 202, a code screen on `wa-otp-input` (6 digits), with the sent-to address displayed,
  a resend button on a cooldown matching the server's rate limit, and a way back to the
  chooser. The challenge id lives in component state; a reload drops it and the recovery is
  requesting a new code.
- Results are announced in a `role="status"` region and focus moves with each step, as settled
  in #224; the German layout is checked at 360 px.
- A generic 401 shows one message ("That code didn't work — request a new one if it expired");
  a 404 from the start endpoint (backend not yet deployed or mail unconfigured) hides the email
  option with a console-free fallback to Google only.
- Sign-in requires connectivity, as today; the offline treatment follows the existing dialog
  conventions.
- **Deployment order:** backend first, frontend after the deployed API answers.

## Security and logging

- No address ever reaches a log line, an error message or a problem body; the derived `mail:`
  sub (or the canonical sub) is the loggable identity. Sign-ins log through the existing
  `SignInLog` with the subject only.
- The code is stored only as `sha256(code)`, compared constant-time, single-use, 10-minute TTL,
  5 attempts.
- The challenge id is high-entropy and single-use; possession of the email alone (code) or the
  JSON answer alone (challenge) signs nobody in.
- The start answer is identical for known and unknown addresses.
- Deny-list and refresh-token semantics are unchanged.

## Testing

- **Backend:** route tests over FakeCouch plus a recording fake `MailSender` — asserting the
  code reaches only the port and appears in no log line and no response body; challenge
  lifecycle (success, wrong code ×5, expiry, reuse after success, unknown id — all 401 and
  indistinguishable); rate limiting (4th send in the window → 429); canonical-sub stability
  (email-first then Google, Google-first then email, 409 on a conflicting Google subject);
  `by_identity` view emits for `subjects` and for legacy `sub`; contract validation and drift
  for the two operations; JaCoCo gates hold.
- **Frontend:** browser tests for the chooser, the code screen (success, generic failure,
  resend cooldown), focus and announcements, the 404 fallback, German copy at 360 px.
- **Integration (optional):** WireMock stub of the Cloudflare mail API behind the adapter.

## Out of scope (later pieces)

- GitHub: the OAuth dance, verified-primary-email rule, `by_identity` consumer (piece 2).
- Passkeys: WebAuthn, credential storage, the "sign-in methods" settings UI that also shows
  linked providers (piece 3).
- Apple: relay addresses as account identity, developer-account prerequisite (piece 4).
- Any "linked methods" UI in this piece; email sign-in needs none.
