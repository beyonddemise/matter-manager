# Passkeys and the sign-in-methods page — design

**Status:** approved in conversation; spec awaiting review.
Piece 3 of the sign-in epic ([piece 1](2026-10-12-email-signin-design.md),
[piece 2](2026-10-12-github-signin-design.md)).
**Repos:** `matter-manager-backend` and this repo's `frontend/`.
**Date:** 2026-10-13

## Purpose

Installers and homeowners who have no Google or GitHub account — and distrust codes by mail —
still deserve a sign-in that works. Passkeys are the first method with no identity provider at
all: possession of a device plus local verification (Face ID, Windows Hello, a PIN), phishing
resistant by construction. This piece adds passkey sign-in and the first place a signed-in user
can *see* how they sign in: the sign-in-methods section, which also manages their passkeys.

## Decisions

1. **Add-only: a passkey never births an account.** Every record is still keyed by a verified
   email address; a passkey ceremony proves possession of a credential and yields no address.
   Passkeys are added from the sign-in-methods section by a signed-in user, and signing in with
   one resolves to that account. Consequence: an account with passkeys always has another
   sign-in method, so deleting passkeys is always safe — no last-method guard is needed.
   Passkey-born accounts are a possible later piece, not this one.
2. **Usernameless sign-in over discoverable credentials.** Registration requires a resident key
   (`residentKey: required`); the chooser's passkey button runs `navigator.credentials.get`
   with no `allowCredentials`, and the browser's own account picker identifies the credential.
   No email-first step: it would add a step, duplicate the email option's UX, and leak which
   addresses have accounts.
3. **The WebAuthn `userHandle` is the canonical subject.** Registration sets
   `user.id = canonical sub` (opaque bytes to the authenticator); the assertion's `userHandle`
   resolves the record through the existing `by_sub` view — no new index — and the asserted
   credential id must exist in that record's `passkeys` array. Passkeys mint no canonical
   subject and never touch the `subjects` map: the uniform `<provider>:<id>` rule from piece 2
   is unaffected, and `resolveIdentity` is not called.
4. **`webauthn4j-core` as a library inside the existing auth architecture.** It verifies the
   ceremonies (CBOR/COSE, attestation, assertion, signature counters); HTTP, cookies, storage
   and session minting stay in the patterns pieces 1–2 built (`PasskeyFlow` as a sibling of
   `OidcFlow`/`GitHubFlow`). Rejected: `quarkus-security-webauthn` (installs its own endpoints
   and session machinery beside ours — two auth systems in one app) and Yubico's
   `java-webauthn-server` (BouncyCastle dependency with no first-party native-image metadata;
   webauthn4j is the engine under Quarkus's own extension, whose reflection config exists to
   crib). **Native-image is the known risk:** the backend plan must run `scripts/native-build.sh`
   green before its PR — per-PR CI no longer builds native (v0.3.0's lesson).
5. **Credentials live on the user record**, in a `passkeys` array parallel to — never inside —
   `subjects`: a passkey is a credential on an account, not an identity. Each entry:
   `id` (credential id, base64url), `publicKey` (COSE, base64url), `signCount`,
   `transports`, user-editable `label` (default honest and date-based, e.g. "Passkey added
   13 Oct 2026" — authenticators do not reliably name themselves), `createdAt`, `lastUsedAt`.
   Registration sends `excludeCredentials` from this array; at most 10 per account.
6. **The sign-in-methods section manages passkeys only.** Providers (Google, GitHub, email) are
   shown read-only — linked or not, nothing clickable; unlinking stays out of scope as pieces
   1–2 decided. Passkeys get the full lifecycle: add, rename, delete.
7. **`userVerification: required` on both ceremonies.** A passkey sign-in is possession *plus*
   local verification, keeping it at least as strong as the methods beside it. Attestation
   policy is `none`: we verify possession, not device provenance.
8. **Challenges ride the `mm_flow` carrier.** 32 random bytes in the signed, short-TTL,
   single-purpose cookie — exactly the OAuth `state` posture — with a claim distinguishing the
   passkey sign-in ceremony from registration (no other flow's carrier resumes either), and the
   registration carrier additionally bound to the signed-in user's sub, so nobody completes
   someone else's add-passkey ceremony.
9. **Discovery and gating.** `AuthMethods` gains `passkeys` as a **required** flag in both
   contract copies at once. `Features.passkeys()` is the session prerequisites — `rpId` and the
   origin check derive from `APP_ORIGIN`'s host (which keeps `localhost` dev working), so no
   new configuration and no new secrets. Gate rows follow the email/GitHub first-match pattern.

## The flows

### Sign-in (public, fetch-based — no redirect dance)

1. `POST /auth/passkey/options` → WebAuthn request options (fresh challenge, `rpId`, no
   `allowCredentials`, `userVerification: required`) + the challenge carrier cookie.
2. Browser ceremony: `navigator.credentials.get`.
3. `POST /auth/passkey` with the assertion JSON → verify carrier (purpose + challenge), resolve
   the record by `userHandle` via `by_sub`, find the credential by id, verify the assertion
   (webauthn4j), refuse a regressed `signCount` (cloned-authenticator signal; problem code
   only), update `signCount`/`lastUsedAt`, then complete **exactly as email-code completion
   completes** — same response shape, same session establishment, `signInLog` with
   `provider: "passkey"`. Every failure is one indistinguishable 401, as piece 1's challenge
   endpoints answer.

### Management (bearer token)

- `GET /auth/sign-in-methods` → which providers this account has linked
  (`google`/`github` from `subjects` plus the born provider implied by the canonical sub's
  namespace; `email` is always true — the address is the key) and the passkey summaries
  (`id`, `label`, `createdAt`, `lastUsedAt`). One endpoint, so the page renders from one fetch.
- `POST /auth/passkeys/options` → creation options (challenge carrier bound to the sub,
  `user.id` = canonical sub, `excludeCredentials`, `residentKey: required`).
- `POST /auth/passkeys` with the attestation JSON → verify, store, answer the new summary.
  Refused when the account already holds 10.
- `PATCH /auth/passkeys/{id}` with `{ "label": … }` → rename (label length capped at 64).
- `DELETE /auth/passkeys/{id}` → 204; that credential refuses sign-in from then on.

## API contract (OpenAPI)

Operations in the backend's `openapi.yaml` (contract of record), mirrored byte-identically here;
resource method names equal operationIds (the drift law):

| Operation | Method and path | Answers |
| --- | --- | --- |
| `startPasskeySignIn` | `POST /auth/passkey/options` | 200 request options |
| `completePasskeySignIn` | `POST /auth/passkey` | as `completeEmailSignIn`; 401 on any refusal |
| `getSignInMethods` | `GET /auth/sign-in-methods` | 200 `SignInMethods` |
| `startPasskeyRegistration` | `POST /auth/passkeys/options` | 200 creation options |
| `createPasskey` | `POST /auth/passkeys` | 201 `Passkey` |
| `renamePasskey` | `PATCH /auth/passkeys/{id}` | 200 `Passkey` |
| `deletePasskey` | `DELETE /auth/passkeys/{id}` | 204 |

Schemas: `AuthMethods` gains required `passkeys`; new `SignInMethods` (provider booleans +
`passkeys: Passkey[]`) and `Passkey` (`id`, `label`, `createdAt`, `lastUsedAt`, all required).
The WebAuthn options and ceremony bodies are documented free-form objects (WebAuthn Level 3
JSON): modelling them field-by-field buys no drift protection and costs it dearly.

## Frontend

- **Chooser:** an outlined **"Sign in with a passkey"** button between GitHub and the email
  option, rendered only when `methods.passkeys` is true **and** `window.PublicKeyCredential`
  exists (discovery cannot know the device). German: „Mit Passkey anmelden" — "Passkey" stays
  untranslated, as the platforms do. Click → options fetch → ceremony → completion POST → the
  session establishes through the same client path as email completion; no new session code.
- **A small in-house WebAuthn JSON helper** (~40 lines: base64url ⇄ ArrayBuffer, options
  parsing, response serialising), tested, instead of a dependency. The credentials API sits
  behind an injected seam (the `signIn`/`signInGitHub` pattern), so browser tests run without
  an authenticator.
- **Sign-in methods on a new Account view** (amended: no profile view exists — the account
  surface today is the header's email and sign-out in the navigation). The view is reachable
  from the navigation when signed in, following the settings view's routing pattern, and shows
  the account's email and plan plus the sign-in-methods section: providers read-only, passkey
  list with add/rename/delete, rendered from the one `GET /auth/sign-in-methods` fetch. It is
  account-level, so not `SettingsView` (whose doc comment refuses to be a bucket); piece 4 and
  any later profile editing land on the same view. Web Awesome primitives throughout.
- Accessibility as the epic settled it: WCAG 2.2 AA, ceremony outcomes announced in the
  persistent status region, focus management on section changes, German checked at 360 px.
- Conditional mediation (passkeys in the autofill dropdown) is out of scope — a later
  enhancement, not a correctness gap.

## Security and logging

- No challenge, credential id, label, public key or address in any log line, problem body or
  notice — the standing rule verbatim. `SignInLog` keeps its deliberate exception and gains
  `provider: "passkey"`.
- All `/auth/*` per-IP rate limits cover the two public endpoints; nothing new.
- The deny-list, refresh-token and sign-out semantics are unchanged — passkey sign-in joins at
  the same session tail as email and inherits everything after it.
- Failure answers are indistinguishable: a wrong challenge, an unknown credential, a regressed
  counter and a failed verification all answer the same 401.

## Testing

- **Backend:** flow unit tests over synthesized authenticator data; resource tests over full
  HTTP — register → list → sign out → usernameless sign-in → token pair; regressed `signCount`
  refused; a carrier minted for Google (and one for registration) refused at sign-in
  completion; registration carrier from another account's session refused; delete → that
  credential refuses; 11th passkey refused; rename caps the label; `methods.passkeys` true and
  false per profile; gates 404 when off; contract drift and validation for the seven
  operations; JaCoCo gates hold. **`scripts/native-build.sh` green before the PR** —
  webauthn4j's native reflection is this piece's proving burden.
- **Frontend:** chooser gating matrix (flag × feature detection), ceremony success and the
  generic failure through the seam, the sign-in-methods section (list, add, rename, delete,
  empty state), German at 360 px with four buttons; the helper's base64url round-trips.
- Both plans walk this Testing list line by line (piece 2's lesson).

## Out of scope (later pieces or never)

- Passkey-born accounts (no email key — would need its own design).
- Provider unlinking, and any account-merge tooling.
- Conditional mediation / autofill UI.
- Attestation metadata (MDS), device provenance policies.
- Apple sign-in (piece 4).
