# Passkeys (Frontend) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The chooser gains "Sign in with a passkey" (usernameless, gated on `/auth/methods` **and** browser support), and a new Account view shows how the account signs in and manages its passkeys.

**Architecture:** A small `webauthn-json` helper (base64url ⇄ buffers) and two outcome-style clients (`passkey-signin.ts` mirroring `email-signin.ts`; `sign-in-methods.ts` for the account view), the browser's credentials API behind injected seams, the chooser flag derived in `chooserStep()`, and `<account-view>` following `<settings-view>`'s registration pattern.

**Tech Stack:** Lit light-DOM, `@lit/localize` (en/de formal Sie), Web Awesome Pro (attributes-only styling), Vitest browser tests (Chromium), Biome. **UI work loads the `webawesome-design` + `webawesome` skills first — subagents too.**

**Spec:** `docs/superpowers/specs/2026-10-13-passkeys-design.md` (as amended: Account view). **Repo:** this one, branch `feat/passkeys` (already holds the spec). Backend counterpart: `2026-10-13-passkeys-backend.md` (peer session; the contract blocks below mirror its Task 4 verbatim).

## Global Constraints

- **No credential id, label, challenge, token or address in any log line, error message or notice.**
- Outcomes, not exceptions, at every API boundary (`email-signin.ts`'s doctrine); the chooser has a next step for every outcome.
- The chooser **never** shows the passkey button without a readable `methods` answering `passkeys: true` AND `window.PublicKeyCredential` present.
- An older API's `methods` answer (no `passkeys` field) stays **valid** — discarding it would silently remove the GitHub button too.
- German is formal (Sie); "Passkey" stays untranslated („Mit Passkey anmelden"). `npm run i18n:extract` / `i18n:build` after copy changes; generated `de.ts` is committed with `de.xlf` (piece 2's miss).
- Zero warnings is the passing bar: run bare `npm run verify` from `frontend/`, read the log, never wrap exit codes.
- Commits end `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>` + the Claude-Session line.

## Review Focus

1. **A v0.3.1 API's `methods` answer (no `passkeys` field)** must still render Google/GitHub/email correctly, passkey absent → Task 1's tolerant-guard tests.
2. **`passkeys: true` on a browser without `PublicKeyCredential`** must hide the button → Task 5's gating matrix.
3. **The user cancels the OS passkey sheet** (`NotAllowedError`) → the chooser stays, no failure notice (a choice, not an error) → Task 3's `dismissed` outcome + Task 5's shell test.
4. **A 401 from `GET /auth/sign-in-methods`** (token expired while the view is open) → the account view shows its signed-out state, never throws → Task 6/7.
5. **An options answer that is not WebAuthn JSON** (proxy HTML, older API) → `unreachable` outcome, generic notice, no ceremony attempted → Task 3.

---

### Task 1: `/auth/methods` learns the passkeys flag, tolerantly

**Files:**
- Modify: `frontend/src/ui/auth-methods.ts`
- Test: `frontend/test/ui/auth-methods.test.ts`

**Interfaces:**
- Produces: `AuthMethods` gains `passkeys: boolean`; `isAuthMethods` accepts an absent `passkeys` (older API) but refuses a non-boolean one; `read()` normalizes absent to `false`.

- [ ] **Step 1: Write the failing tests** — extend the existing matrix:

```ts
it('accepts an answer without the passkeys flag, reading it as false', async () => {
  const api = authMethodsApi('/api', answering(json(200, { google: true, github: true, email: true })))
  expect(await api.read()).toEqual({ google: true, github: true, email: true, passkeys: false })
})

it('accepts and keeps a passkeys flag', () => {
  expect(isAuthMethods({ ...ALL, passkeys: true })).toBe(true)
})

it.each([['a passkeys flag that is not a boolean', { ...ALL, passkeys: 'yes' }]])(
  'refuses %s',
  (_name, body) => expect(isAuthMethods(body)).toBe(false),
)
```

(`ALL` becomes `{ google: true, github: true, email: true, passkeys: true }`; the 200 test's expectation follows.)

- [ ] **Step 2: Run to verify failure** — `npx vitest run test/ui/auth-methods.test.ts` from `frontend/` — FAIL (type + guard).
- [ ] **Step 3: Implement** — `passkeys: boolean` on the type; guard: the three required booleans unchanged, plus `(v.passkeys === undefined || typeof v.passkeys === 'boolean')`; `read()` answers `{ ...body, passkeys: body.passkeys ?? false }`. Module doc gains one sentence: absent means an older API, read as false.
- [ ] **Step 4: Run** — PASS. **Step 5: Commit** — `feat(ui): the methods answer carries a tolerant passkeys flag`

### Task 2: The webauthn-json helper

**Files:**
- Create: `frontend/src/ui/webauthn-json.ts`
- Test: `frontend/test/ui/webauthn-json.test.ts`

**Interfaces:**
- Produces:

```ts
export function b64urlToBuffer(value: string): ArrayBuffer
export function bufferToB64url(value: ArrayBuffer): string
/** Request options JSON → what navigator.credentials.get wants ({ publicKey }). undefined when not the shape. */
export function parseRequestOptions(body: unknown): CredentialRequestOptions | undefined
/** Creation options JSON → what navigator.credentials.create wants. undefined when not the shape. */
export function parseCreationOptions(body: unknown): CredentialCreationOptions | undefined
/** A finished get() ceremony → the completion POST's JSON body. */
export function assertionToJSON(credential: PublicKeyCredential): unknown
/** A finished create() ceremony → the registration POST's JSON body. */
export function attestationToJSON(credential: PublicKeyCredential): unknown
```

- [ ] **Step 1: Write the failing tests** — b64url round-trips (empty, 1–3 byte tails, `-`/`_` alphabet, no padding); `parseRequestOptions` decodes `challenge` and passes `rpId`/`userVerification`/`timeout` through, answers `undefined` for HTML/null/missing challenge; `parseCreationOptions` additionally decodes `user.id` and each `excludeCredentials[].id`; `assertionToJSON`/`attestationToJSON` encode `rawId` and every response buffer (`clientDataJSON`, `authenticatorData`, `signature`, `userHandle` — null stays null; `attestationObject`) with `type` and `id` passed through, fed from hand-built objects with known bytes.
- [ ] **Step 2: Run to verify failure.** **Step 3: Implement** (~60 lines, pure; no dependency). **Step 4: Run — PASS.**
- [ ] **Step 5: Commit** — `feat(ui): WebAuthn JSON helper — base64url and ceremony shapes`

### Task 3: The passkey sign-in client

**Files:**
- Create: `frontend/src/ui/passkey-signin.ts`
- Modify: `frontend/src/ui/composition.ts` (factory beside `emailSignIn`'s)
- Test: `frontend/test/ui/passkey-signin.test.ts`

**Interfaces:**
- Consumes: Task 2's helper; `isTokenResponse`, `rememberAccessToken`, `forgetTokens`, `RefreshTokenStore` from `./tokens.js` (exactly `email-signin.ts`'s adoption block).
- Produces:

```ts
/** The subset of navigator.credentials the ceremonies need. Injected, so tests need no authenticator. */
export interface CredentialsLike {
  get(options: CredentialRequestOptions): Promise<Credential | null>
  create(options: CredentialCreationOptions): Promise<Credential | null>
}

export type PasskeySignInOutcome =
  | { kind: 'signed-in'; expiresIn: number }
  | { kind: 'dismissed' }        // NotAllowedError: the user closed the sheet — a choice, not an error
  | { kind: 'failed' }           // 401: the one indistinguishable refusal
  | { kind: 'unavailable' }      // 404: this deployment has no passkeys
  | { kind: 'unreachable' }      // network, 5xx, or an answer that is not the contract's

export interface PasskeySignIn { signIn(): Promise<PasskeySignInOutcome> }
export function passkeySignIn(apiBase: string, store: RefreshTokenStore,
  credentials: CredentialsLike, fetchImpl?: typeof fetch): PasskeySignIn
```

composition.ts: `export function passkeyAuth(store: RefreshTokenStore, credentials: CredentialsLike = navigator.credentials, fetchImpl = fetch): PasskeySignIn` — mirroring the email factory's shape (read it there and match parameter order).

- [ ] **Step 1: Write the failing tests** — fake fetch + fake credentials: options 200 + `get()` answering a hand-built credential + completion 200 token pair → `signed-in`, access remembered, refresh written (spy the store); completion 401 → `failed`, tokens forgotten; options 404 → `unavailable` with **no** `get()` call; options HTML body → `unreachable`, no ceremony (Review Focus 5); `get()` rejecting `DOMException('NotAllowedError')` → `dismissed`, no completion POST; `get()` rejecting anything else → `unreachable`; store.write throwing → tokens forgotten, `unreachable` (the half-sign-in rule).
- [ ] **Step 2: Run to verify failure.** **Step 3: Implement** — `POST /auth/passkey/options` (empty JSON body) with the same throw-free `post` helper shape as `email-signin.ts`; `parseRequestOptions`; `credentials.get`; `assertionToJSON`; `POST /auth/passkey`; adopt the pair exactly as `emailSignIn.complete` does (same comments' intent, same forget-on-half rule). The options POST must send no body-dependent headers beyond `content-type`; cookies ride same-origin automatically.
- [ ] **Step 4: Run — PASS.** **Step 5: Commit** — `feat(ui): passkey sign-in client — ceremony to token pair, outcomes only`

### Task 4: The chooser's passkey button

**Files:**
- Modify: `frontend/src/ui/sign-in-dialog.ts`
- Modify: `frontend/xliff/de.xlf` + `frontend/src/ui/generated/locales/de.ts` (via `npm run i18n:extract` / `i18n:build`)
- Test: `frontend/test/ui/sign-in-dialog.browser.test.ts`

**Interfaces:**
- Produces: the chooser step variant becomes `{ step: 'chooser'; google: boolean; github: boolean; email: boolean; passkey: boolean }`; `SignInActions` gains `onPasskey(): void`; button `data-passkey-sign-in` between GitHub and email, `appearance="outlined"`, `?disabled=${!online}`, `msg('Sign in with a passkey')`.

- [ ] **Step 1: Write the failing tests** — extend `ALL_ON` with `passkey: true` (every existing chooser row follows); order test now expects google/github/passkey/email; hides-when-lacking matrix gains the passkey row; wiring test: clicking `[data-passkey-sign-in]` calls `onPasskey` once and nothing else; German-360 matrix gains the row `'chooser, its passkey button' → 'Mit Passkey anmelden'`.
- [ ] **Step 2: Run to verify failure.** **Step 3: Implement** the variant, the action and the button; run `npm run i18n:extract`, fill `de.xlf` (`Sign in with a passkey` → `Mit Passkey anmelden`), `npm run i18n:build`, **commit the generated `de.ts` too**.
- [ ] **Step 4: Run** — the dialog suite PASSES. **Step 5: Commit** — `feat(ui): the chooser offers a passkey, in both languages`

### Task 5: Shell wiring — flag, support gate, ceremony, outcomes

**Files:**
- Modify: `frontend/src/ui/app-shell.ts`
- Test: `frontend/test/ui/sign-in.browser.test.ts`

**Interfaces:**
- Consumes: Task 1's flag, Task 3's `PasskeySignIn` + `passkeyAuth`, Task 4's step/action.
- Produces: shell properties (both `{ attribute: false }`) `passkeyAuth: PasskeySignIn | undefined` (test seam; default built in the handler via composition's factory with the shell's refresh-token store — find where `emailAuth` builds and mirror it) and `passkeySupport: () => boolean` defaulting to `() => typeof PublicKeyCredential !== 'undefined'`; `chooserStep()` gains `passkey: (methods?.passkeys ?? false) && this.passkeySupport()`; `onPasskey` handler; the chooser focus selector list gains `[data-passkey-sign-in]` after `[data-github-sign-in]`.

- [ ] **Step 1: Write the failing tests** (the `emailShell` harness; add `.passkeyAuth` and `.passkeySupport` bindings beside `.authMethods`):
  - gating matrix: methods `passkeys: true` + support true → button; `passkeys: true` + support false → none (Review Focus 2); `passkeys: false` + support true → none; unreadable methods → none.
  - `signed-in` outcome → dialog closed and the same signed-in transition email's verify success drives (assert what that test asserts — read the existing `'verifying the code signs in'` test and pin the same observable).
  - `dismissed` → dialog open on the chooser, status region empty (Review Focus 3).
  - `failed`/`unreachable` → chooser intact, status region carries the generic failure line (`msg('That didn't work. Please try again.')` — reuse the existing generic failure copy if one exists; read the email outcome handling and reuse its string).
- [ ] **Step 2: Run to verify failure.** **Step 3: Implement** — `onPasskey` async handler: keep the chooser step, run `(this.passkeyAuth ?? passkeyAuth(store)).signIn()`, then by outcome: `signed-in` → the email-verify success path (same method it calls); `dismissed` → nothing; `failed`/`unreachable` → set the notice. Guard staleness the piece-2 way: apply outcomes only while `this.signingIn?.step === 'chooser'`.
- [ ] **Step 4: Run** — the shell suite PASSES. **Step 5: Commit** — `feat(ui): passkey sign-in from the chooser`

### Task 6: The sign-in-methods client

**Files:**
- Create: `frontend/src/ui/sign-in-methods.ts`
- Modify: `frontend/src/ui/composition.ts` (factory)
- Test: `frontend/test/ui/sign-in-methods.test.ts`

**Interfaces:**
- Consumes: Task 2's helper, Task 3's `CredentialsLike`, `accessToken` from `./tokens.js` (the `profileApi` bearer idiom).
- Produces:

```ts
export interface Passkey { id: string; label: string; createdAt: string; lastUsedAt: string }
export interface SignInMethods { google: boolean; github: boolean; email: boolean; passkeys: Passkey[] }

export type MethodsOutcome =
  | { kind: 'methods'; methods: SignInMethods }
  | { kind: 'signed-out' }       // no token held, or 401
  | { kind: 'unreachable' }
export type AddOutcome =
  | { kind: 'added'; passkey: Passkey }
  | { kind: 'dismissed' } | { kind: 'full' } /* 409 */ | { kind: 'signed-out' } | { kind: 'unreachable' }
export type ChangeOutcome = { kind: 'done' } | { kind: 'missing' } /* 404 */ | { kind: 'signed-out' } | { kind: 'unreachable' }

export interface SignInMethodsApi {
  read(): Promise<MethodsOutcome>
  add(credentials: CredentialsLike): Promise<AddOutcome>
  rename(id: string, label: string): Promise<ChangeOutcome>
  remove(id: string): Promise<ChangeOutcome>
}
export function signInMethodsApi(apiBase: string, fetchImpl?: typeof fetch): SignInMethodsApi
```

- [ ] **Step 1: Write the failing tests** — fake fetch: `read` 200 shape-checked (a body missing `passkeys` → `unreachable`), 401 → `signed-out`, no token → `signed-out` without a request; `add` drives options → `create()` → `POST /auth/passkeys` (201 → `added`; 409 → `full`; `NotAllowedError` → `dismissed`, no POST); `rename`/`remove` status mapping (200/204 → `done`, 404 → `missing`, 401 → `signed-out`); every request carries the bearer header.
- [ ] **Step 2: Run to verify failure.** **Step 3: Implement.** **Step 4: Run — PASS.**
- [ ] **Step 5: Commit** — `feat(ui): the account's sign-in-methods client`

### Task 7: The Account view

**Files:**
- Create: `frontend/src/ui/views/account.ts` (`<account-view>`, light DOM, the `settings.ts` registration pattern)
- Modify: `frontend/src/ui/app-shell.ts` (route entry beside `settings`; import) and the navigation template that renders the Settings link + sign-out (grep `renderSignOut` usages and the nav items around them) — an **Account** item, shown only when signed in, above Settings.
- Modify: `frontend/xliff/de.xlf` + generated `de.ts`
- Test: `frontend/test/ui/account.browser.test.ts`

**Interfaces:**
- Consumes: Task 6's api (injected as a property, the `settings.ts`/`emailShell` seam style), Task 3's `CredentialsLike` (injected, default `navigator.credentials`), the cached profile (email/plan) the way the header reads it (grep `renderAccount` for the source).
- Produces: a view with — the account's email and plan; a **Sign-in methods** card: one read-only row per provider (Google / GitHub / Email, each „linked/nicht verknüpft" state text, no controls); a passkey list (label, added date, last used via `<wa-format-date>`), each row with Rename (inline `<wa-input>` swap, Enter/button commits) and Delete (immediate — always safe by construction — with a status announcement); an **Add a passkey** button (hidden when the view's own injected `passkeySupport: () => boolean` property — same default as the shell's — answers false); a persistent `role="status"` region for outcomes; a signed-out state ("Sign in to manage how you sign in." — shown for `signed-out` outcomes, Review Focus 4).

**Copy (en → de):** `Account` → `Konto`; `Sign-in methods` → `Anmeldemethoden`; `Linked` → `Verknüpft`; `Not linked` → `Nicht verknüpft`; `Passkeys` → `Passkeys`; `Add a passkey` → `Passkey hinzufügen`; `Rename` → `Umbenennen`; `Delete` → `Löschen`; `Added` → `Hinzugefügt`; `Last used` → `Zuletzt verwendet`; `That didn't work. Please try again.` → reuse the existing generic failure string; `Sign in to manage how you sign in.` → `Melden Sie sich an, um Ihre Anmeldemethoden zu verwalten.`

- [ ] **Step 1: LOAD `webawesome-design` + `webawesome` SKILLS**, then write the failing browser tests: renders the three provider rows from a stubbed `methods` outcome (linked states match the booleans); passkey rows show label and dates; add → api.add called, `added` appends the row and announces; `dismissed` announces nothing; `full` announces the limit line; rename commits a new label through the api; delete removes the row and announces; `signed-out` outcome → the signed-out state; German at 360 px (nav + the view's headings and buttons).
- [ ] **Step 2: Run to verify failure.** **Step 3: Implement** the view + route + nav item; i18n extract/build; generated `de.ts` committed.
- [ ] **Step 4: Run** — the account suite + the full browser suite PASS. **Step 5: Commit** — `feat(ui): the Account view — how this account signs in`

### Task 8: Contract mirror, full verify and PR

**Files:**
- Modify: `openapi.yaml` (repo root)

- [ ] **Step 1: Mirror the contract.** Apply the backend plan Task 4's YAML **verbatim** (the seven operations after the GitHub callback block, `AuthMethods.passkeys`, the `Passkey` and `SignInMethods` schemas) to the root `openapi.yaml`. The mirror rule is byte-identity with the backend's contract of record: before the PRs merge, diff against the backend branch's file and reconcile any drift with the peer session (piece 2's callback-fix precedent — neither file wins by default, the backend's is the record).
- [ ] **Step 2:** From `frontend/`: bare `npm run verify` — green, zero warnings, log read (coverage gate, build, i18n, offline checks included). `npm run check:i18n` clean.
- [ ] **Step 3: Commit** — `docs(contract): mirror passkey sign-in, management and the methods flag`
- [ ] **Step 4:** Push `feat/passkeys`, PR to `main` via `--body-file` (what changed, merge order: after the backend PR — the chooser hides passkeys against an older API either way; attribution lines). Do not merge.

---

## Deliberate scope notes

- No conditional mediation; no passkey-born accounts; providers stay read-only.
- Spec Testing list → owning test: chooser gating matrix (Task 5), ceremony success/failure through the seam (Tasks 3 + 5), sign-in-methods section list/add/rename/delete/empty (Task 7), German 360 px with four buttons (Task 4) and the Account view (Task 7), helper round-trips (Task 2).
- The Account view deliberately reads email/plan from the cached profile rather than adding a fetch: the header already solves that problem; follow it.
