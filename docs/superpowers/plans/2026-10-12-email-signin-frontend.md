# Email Sign-In (Frontend) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. **UI tasks: load the `webawesome-design` and `webawesome` skills before writing, and say so in every UI subagent's dispatch (project CLAUDE.md).**

**Goal:** A sign-in chooser (Google, or an emailed one-time code) in the app shell, signing the user in without leaving the page.

**Architecture:** The header's "Sign in" opens a dialog owned by `app-shell` (the `upgrade-dialog` pattern: plain template functions, shell-owned state). The email path calls `POST /auth/email`, holds the returned challenge id in component state, verifies the code at `POST /auth/email/{challenge}`, and — since that answers the same body as `POST /auth/token` — remembers the access token, stores the refresh token, and runs the shell's ordinary `refreshed` transition. No reload, no redirect.

**Tech Stack:** Lit (light DOM) + `@lit/localize` (en/de, Sie), Web Awesome Pro (`wa-dialog`, `wa-input`, `wa-otp-input`, `wa-button`, utilities), Vitest browser tests.

**Spec:** `docs/superpowers/specs/2026-10-12-email-signin-design.md`. Backend counterpart: `docs/superpowers/plans/2026-10-12-email-signin-backend.md` (ships first; this UI hides the email option on a 404, so merging before the API deploy is safe, just inert).

## Global Constraints

- Repo `/Users/stw/Code/matter-manager`, branch `feat/email-signin` (already carries spec and plans).
- **No address, challenge id or code in logs, console output or error messages.** Tokens follow `tokens.ts` law: access token in memory, refresh token only via `RefreshTokenStore`.
- **Copy is localized** (`msg()`), German in formal Sie; the catalogue check (`npm run check:i18n`) is part of verify and must stay green — run `npm run i18n:extract` after copy changes and translate every new `<target>` in `frontend/xliff/de.xlf` by hand.
- **Accessibility as #224 settled it:** results announced in a persistent `role="status"` region, focus moves with each step and returns on close (account control first, scheme toggle as fallback), labels on every control, German layout holds at 360 px.
- Web Awesome idiom: utilities (`wa-stack`, `wa-gap-*`) over custom flex, tokens over raw values, one filled brand button per surface, component styling only through documented attributes/parts.
- **Verify bar:** `npm run verify` in `frontend/` green with zero warnings (it includes i18n, typecheck, coverage, build and the deploy checks).
- Commits: conventional, ending `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`.

## Review Focus

1. **A 404 from `POST /auth/email`** (backend not deployed / mail unconfigured) must not strand the dialog — the email option hides and Google remains → Task 4's unavailable test.
2. **Double-submit of the code** (Enter plus click, or `wa-complete` firing twice) must not fire two verifies → the in-flight guard and its test (Task 4).
3. **Going offline between start and verify** must surface as the offline message, not an eternal spinner → Task 4's unreachable test.
4. **A stale answer after the dialog closed** (user cancels while verify is in flight) must not mutate shell state → the generation guard test (Task 4, the #224 `waitlistChanges` pattern).
5. **Sign-in succeeding must start sync in place** — session flips to `signed-in`, replication and backfill start exactly once → Task 4's shell transition test.

---

### Task 1: The token-pair guard moves where both consumers live

**Files:**
- Modify: `frontend/src/ui/tokens.ts` (gains `isTokenResponse`)
- Modify: `frontend/src/ui/composition.ts:194-218` (imports it instead of owning it)
- Test: `frontend/test/ui/tokens.test.ts`

**Interfaces:**
- Produces: `export function isTokenResponse(body: unknown): body is TokenResponse` — exactly the current implementation and doc comment from `composition.ts`, including the `EXPIRY_MARGIN_SECONDS` floor. Task 2 consumes it.

- [ ] **Step 1: Write the failing test** (append to `tokens.test.ts`)

```ts
import { EXPIRY_MARGIN_SECONDS, isTokenResponse } from '../../src/ui/tokens.js'

describe('isTokenResponse', () => {
  const good = { accessToken: 'a', expiresIn: 300, refreshToken: 'r' }
  it('accepts a real pair and rejects every mutilation', () => {
    expect(isTokenResponse(good)).toBe(true)
    expect(isTokenResponse({})).toBe(false)
    expect(isTokenResponse({ ...good, accessToken: '' })).toBe(false)
    expect(isTokenResponse({ ...good, refreshToken: '' })).toBe(false)
    expect(isTokenResponse({ ...good, expiresIn: Number.NaN })).toBe(false)
    expect(isTokenResponse({ ...good, expiresIn: EXPIRY_MARGIN_SECONDS })).toBe(false)
    expect(isTokenResponse(null)).toBe(false)
  })
})
```

- [ ] **Step 2: Run to verify failure** — `npx vitest run test/ui/tokens.test.ts` (in `frontend/`) — FAIL: no export.
- [ ] **Step 3: Move the function** verbatim (with its comment block) from `composition.ts` into `tokens.ts`, exported; `composition.ts` imports it from `./tokens.js`. No behavior change.
- [ ] **Step 4: Run** — `npx vitest run test/ui/tokens.test.ts test/ui/composition.test.ts` — PASS.
- [ ] **Step 5: Commit** — `refactor(ui): export the token-pair guard from tokens.ts`

### Task 2: The email sign-in client

**Files:**
- Create: `frontend/src/ui/email-signin.ts`
- Modify: `frontend/src/ui/composition.ts` (one wiring function, the `profile()`/`projects()` pattern)
- Test: `frontend/test/ui/email-signin.test.ts`

**Interfaces:**
- Consumes: `isTokenResponse`, `rememberAccessToken` (`tokens.ts`), `RefreshTokenStore`.
- Produces:

```ts
export type StartOutcome =
  | { kind: 'challenge'; challenge: string }
  | { kind: 'refused' } // 400: not an address the server takes
  | { kind: 'throttled' } // 429: too many codes
  | { kind: 'unavailable' } // 404: this deployment has no email sign-in
  | { kind: 'unreachable' }

export type VerifyOutcome =
  | { kind: 'signed-in'; expiresIn: number }
  | { kind: 'failed' } // 401, one kind for every refusal, as the contract answers
  | { kind: 'unreachable' }

export interface EmailSignIn {
  start(email: string, locale: string): Promise<StartOutcome>
  complete(challenge: string, code: string): Promise<VerifyOutcome>
}

export function emailSignIn(
  apiBase: string,
  store: RefreshTokenStore,
  fetchImpl: typeof fetch = fetch,
): EmailSignIn
```

and in `composition.ts`: `export function emailSignInClient(fetchImpl: typeof fetch = fetch): EmailSignIn` wiring `API_BASE` and `pouchRefreshTokenStore(localDatabase())`.

- [ ] **Step 1: Write the failing tests**

```ts
import { describe, expect, it } from 'vitest'
import { emailSignIn } from '../../src/ui/email-signin.js'
import { accessToken, forgetTokens } from '../../src/ui/tokens.js'

const answer = (status: number, body?: unknown) =>
  Promise.resolve(
    new Response(body === undefined ? null : JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json' },
    }),
  )

function memoryStore() {
  let token: string | undefined
  return {
    written: () => token,
    read: async () => token,
    write: async (t: string) => void (token = t),
    clear: async () => void (token = undefined),
  }
}

describe('startEmailSignIn', () => {
  it('answers the challenge and sends address and locale', async () => {
    let sent: RequestInit | undefined
    const client = emailSignIn('https://api', memoryStore(), (url, init) => {
      expect(url).toBe('https://api/auth/email')
      sent = init
      return answer(202, { challenge: 'c-1' })
    })
    expect(await client.start('ada@example.com', 'de')).toEqual({ kind: 'challenge', challenge: 'c-1' })
    expect(JSON.parse(sent?.body as string)).toEqual({ email: 'ada@example.com', locale: 'de' })
  })

  it.each([
    [400, 'refused'],
    [404, 'unavailable'],
    [429, 'throttled'],
    [500, 'unreachable'],
  ])('maps %s to %s', async (status, kind) => {
    const client = emailSignIn('https://api', memoryStore(), () => answer(status, {}))
    expect((await client.start('a@b.co', 'en')).kind).toBe(kind)
  })

  it('a thrown fetch is unreachable, and a 202 without a challenge too', async () => {
    const down = emailSignIn('https://api', memoryStore(), () => Promise.reject(new Error('x')))
    expect((await down.start('a@b.co', 'en')).kind).toBe('unreachable')
    const odd = emailSignIn('https://api', memoryStore(), () => answer(202, {}))
    expect((await odd.start('a@b.co', 'en')).kind).toBe('unreachable')
  })
})

describe('completeEmailSignIn', () => {
  it('on 200 remembers the access token, stores the refresh token, reports signed-in', async () => {
    forgetTokens()
    const store = memoryStore()
    const client = emailSignIn('https://api', store, (url) => {
      expect(url).toBe('https://api/auth/email/c-1')
      return answer(200, { accessToken: 'acc', expiresIn: 300, refreshToken: 'ref' })
    })
    expect(await client.complete('c-1', '123456')).toEqual({ kind: 'signed-in', expiresIn: 300 })
    expect(accessToken()).toBe('acc')
    expect(store.written()).toBe('ref')
    forgetTokens()
  })

  it('a 401 is failed and stores nothing; a token-shaped lie is unreachable', async () => {
    forgetTokens()
    const store = memoryStore()
    const refused = emailSignIn('https://api', store, () => answer(401, { title: 'Sign-in failed' }))
    expect((await refused.complete('c-1', '000000')).kind).toBe('failed')
    expect(accessToken()).toBeUndefined()
    expect(store.written()).toBeUndefined()
    const lying = emailSignIn('https://api', store, () => answer(200, { accessToken: '' }))
    expect((await lying.complete('c-1', '123456')).kind).toBe('unreachable')
    expect(store.written()).toBeUndefined()
  })
})
```

- [ ] **Step 2: Run to verify failure** — `npx vitest run test/ui/email-signin.test.ts` — FAIL: module missing.
- [ ] **Step 3: Implement** (`email-signin.ts`; module doc in the house voice — what it is, why outcomes not exceptions):

```ts
import { isTokenResponse, type RefreshTokenStore, rememberAccessToken } from './tokens.js'

// (outcome types as in Interfaces above)

export function emailSignIn(
  apiBase: string,
  store: RefreshTokenStore,
  fetchImpl: typeof fetch = fetch,
): EmailSignIn {
  const post = async (path: string, body: unknown): Promise<Response | undefined> => {
    try {
      return await fetchImpl(`${apiBase}${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      })
    } catch {
      return undefined
    }
  }

  return {
    async start(email, locale) {
      const response = await post('/auth/email', { email, locale })
      if (response === undefined) return { kind: 'unreachable' }
      if (response.status === 400) return { kind: 'refused' }
      if (response.status === 404) return { kind: 'unavailable' }
      if (response.status === 429) return { kind: 'throttled' }
      if (!response.ok) return { kind: 'unreachable' }
      let body: unknown
      try {
        body = await response.json()
      } catch {
        return { kind: 'unreachable' }
      }
      const challenge = (body as { challenge?: unknown }).challenge
      // A 202 without a challenge is a server fault, not a flow state.
      if (typeof challenge !== 'string' || challenge === '') return { kind: 'unreachable' }
      return { kind: 'challenge', challenge }
    },

    async complete(challenge, code) {
      const response = await post(`/auth/email/${encodeURIComponent(challenge)}`, { code })
      if (response === undefined) return { kind: 'unreachable' }
      if (response.status === 401) return { kind: 'failed' }
      if (!response.ok) return { kind: 'unreachable' }
      let body: unknown
      try {
        body = await response.json()
      } catch {
        return { kind: 'unreachable' }
      }
      // The same trust boundary the refresher guards: a 200 that is not a token pair is a
      // server fault, and believing it would store a session that cannot speak.
      if (!isTokenResponse(body)) return { kind: 'unreachable' }
      rememberAccessToken(body)
      await store.write(body.refreshToken)
      return { kind: 'signed-in', expiresIn: body.expiresIn }
    },
  }
}
```

In `composition.ts`, next to `profile()`:

```ts
/** Email sign-in, wired to the API and this device's refresh-token store. */
export function emailSignInClient(fetchImpl: typeof fetch = fetch): EmailSignIn {
  return emailSignIn(API_BASE, pouchRefreshTokenStore(localDatabase()), fetchImpl)
}
```

- [ ] **Step 4: Run** — `npx vitest run test/ui/email-signin.test.ts` — PASS.
- [ ] **Step 5: Commit** — `feat(ui): email sign-in client (start, verify, adopt the token pair)`

### Task 3: The sign-in dialog (UI — load `webawesome-design` + `webawesome` first)

**Files:**
- Create: `frontend/src/ui/sign-in-dialog.ts`
- Modify: `frontend/src/ui/main.ts` (add `import '@awesome.me/webawesome-pro/dist/components/otp-input/otp-input.js'` in its alphabetical slot)
- Modify: `frontend/src/ui/styles/app.css` only if a wrap rule is needed at 360 px (the #224 `wa-button::part(base)` precedent)
- Test: `frontend/test/ui/sign-in-dialog.browser.test.ts`

**Interfaces:**
- Consumes: nothing from Tasks 1–2 directly — it is a pure view, like `upgrade-dialog.ts`.
- Produces:

```ts
export type SignInStep =
  | { step: 'chooser'; emailUnavailable: boolean }
  | { step: 'email'; busy: boolean }
  | { step: 'code'; email: string; busy: boolean; resendWaitSeconds: number }

export interface SignInActions {
  onGoogle(): void
  onSendCode(email: string): void
  onVerify(code: string): void
  onResend(): void
  onBack(): void
  onClose(): void
}

export function renderSignInDialog(
  state: SignInStep,
  notice: string, // the status/error line; '' when none — rendered in the persistent status region
  actions: SignInActions,
): TemplateResult
```

- [ ] **Step 1: Write the failing browser tests** (the `shell-projects.browser.test.ts` conventions: real CSS, light DOM queries by `data-` attributes)

```ts
// Renders each step, asserting against data- attributes, with recording actions.
it('the chooser offers Google and email, and only Google when email is unavailable', …)
// chooser: [data-google-sign-in] is the one filled brand button; [data-email-option] present;
// with emailUnavailable: true the email option is absent and nothing else changed.
it('the email step takes an address and disables Send while busy', …)
// [data-email-input] (wa-input type=email with a label), [data-send-code] disabled when busy.
it('the code step shows the address, a six-segment otp input, resend with a countdown', …)
// [data-code-input] is wa-otp-input with length 6; the shown address equals state.email;
// [data-resend] disabled while resendWaitSeconds > 0 and its text carries the number.
it('the status region exists in every step and carries the notice', …)
// [data-sign-in-status][role="status"] present with state '' and with a notice.
it('entering six digits calls onVerify once with the code', …)
// set the otp input's value, dispatch its wa-complete event, assert the recorded call.
```

Write these as real tests (render into a container, query, assert), mirroring how the existing browser suites mount template functions; each bullet's `data-` contract is the assertion.

- [ ] **Step 2: Run to verify failure** — `npx vitest run test/ui/sign-in-dialog.browser.test.ts` — FAIL: module missing.
- [ ] **Step 3: Implement the view.** Shape (follow `upgrade-dialog.ts` idiom exactly — plain functions, `msg()` everywhere, utilities over custom CSS):

```ts
export function renderSignInDialog(state, notice, actions): TemplateResult {
  return html`<wa-dialog
    data-sign-in-dialog
    open
    label=${msg('Sign in')}
    @wa-after-hide=${actions.onClose}
  >
    <div class="wa-stack wa-gap-m">
      ${body(state, actions)}
      <output data-sign-in-status role="status" class="app-status-line">${notice}</output>
    </div>
  </wa-dialog>`
}
```

with `body` per step:

- **chooser:** a `wa-stack`: `<wa-button data-google-sign-in variant="brand" @click=${actions.onGoogle}>${msg('Sign in with Google')}</wa-button>`, and unless `emailUnavailable`, `<wa-button data-email-option appearance="outlined" @click=…>${msg('Sign in with email')}</wa-button>` (the Google button is the surface's one filled brand button).
- **email:** `<wa-input data-email-input type="email" required label=${msg('Email address')} autocomplete="email">` plus `<wa-button data-send-code variant="brand" ?disabled=${state.busy} @click=${…}>${msg('Send code')}</wa-button>` and a plain `data-back` button (`msg('Back')`); submit on Enter via the input's `@keydown`.
- **code:** `${msg(str`Enter the code we sent to ${state.email}.`)}`, `<wa-otp-input data-code-input length="6" label=${msg('Sign-in code')} @wa-complete=${(e) => actions.onVerify((e.target as { value: string }).value)}></wa-otp-input>`, `<wa-button data-verify variant="brand" ?disabled=${state.busy} …>${msg('Sign in')}</wa-button>`, and `<wa-button data-resend appearance="plain" ?disabled=${state.resendWaitSeconds > 0} @click=${actions.onResend}>` with text `msg('Send a new code')` or `msg(str`Send a new code (${state.resendWaitSeconds})`)`.

(`wa-otp-input` defaults: `type="numeric"`, `autocomplete="one-time-code"` — leave both.)

- [ ] **Step 4: Run** — `npx vitest run test/ui/sign-in-dialog.browser.test.ts` — PASS.
- [ ] **Step 5: Commit** — `feat(ui): sign-in dialog with Google and email-code steps`

### Task 4: Shell integration (UI — load both skills first)

**Files:**
- Modify: `frontend/src/ui/app-shell.ts` (`onSignIn` at ~:657, new dialog state, the adopt-session transition)
- Modify: `frontend/src/ui/shell-header.ts` only if the account region needs a focus anchor it lacks
- Test: `frontend/test/ui/app-shell.browser.test.ts` (extend)

**Interfaces:**
- Consumes: `renderSignInDialog` (Task 3), `emailSignInClient` (Task 2), `beginSignIn`, the private `onTokenOutcome` transition, the #224 focus-return helper already in `app-shell`.
- Produces: shell behavior only.

- [ ] **Step 1: Write the failing tests** (extend `app-shell.browser.test.ts`, which already stubs `signIn`, fetch and the refresher):

```ts
it('Sign in opens the chooser; Google in the dialog starts the redirect', …)
// click [data-sign-in]; expect [data-sign-in-dialog]; click [data-google-sign-in];
// the injected signIn stub recorded one call; the dialog closed.
it('the email path signs in in place: session flips, header shows the account', …)
// stub fetch: 202 {challenge}, then 200 token pair, then whatever /profile needs;
// walk email → code → verify; expect session 'signed-in', sync started once
// (the suite's replication spy), the dialog closed, focus on the account control,
// and the status region to have announced msg('Signed in.').
it('a 404 at start hides the email option and keeps Google', …)
it('a wrong code shows the one failure message and keeps the code step', …)
// also: a second verify while one is in flight sends one request (in-flight guard).
it('an answer arriving after the dialog closed changes nothing', …)
// open, send code, close the dialog, then resolve the pending verify: session unchanged
// (the #224 generation-guard pattern).
it('offline during verify says the service is unreachable', …)
```

- [ ] **Step 2: Run to verify failure.**
- [ ] **Step 3: Implement in `app-shell`:**
  - Reactive state `signingIn: SignInStep | undefined` plus `signInNotice: string`, a `signInChallenge: { id: string; email: string } | undefined`, a generation counter (the `waitlistChanges` pattern), and a resend-countdown interval that ticks `resendWaitSeconds` down from 60.
  - `onSignIn` becomes "open the chooser" (`this.signingIn = { step: 'chooser', emailUnavailable: false }`); the dialog's `onGoogle` calls `(this.signIn ?? beginSignIn)()` — the stubbed-injection seam stays what it is.
  - `onSendCode(email)`: guard `busy`, call `emailSignInClient().start(email, getLocale())`; `challenge` → code step + hold `{id, email}` + start the 60 s countdown; `unavailable` → back to chooser with `emailUnavailable: true` and notice `msg('Email sign-in is not available yet.')`; `refused` → notice `msg('That does not look like an email address.')`; `throttled` → notice `msg('Too many codes requested. Please wait a few minutes.')`; `unreachable` → the shell's existing offline wording.
  - `onVerify(code)`: guard `busy` and generation; `complete(id, code)`; `signed-in` → close the dialog, announce `msg('Signed in.')`, return focus (account control, scheme-toggle fallback — reuse the #224 helper), and run the refreshed transition: `this.onTokenOutcome({ kind: 'refreshed', expiresIn })` — the running refresher takes over before expiry, since the stored refresh token is now this session's. `failed` → notice `msg("That code didn't work. It may have expired — request a new one.")`, clear the otp input. `unreachable` → offline wording.
  - `onResend`: re-run `onSendCode` with the held address when the countdown is 0.
  - Render: add `renderSignInDialog(...)` to the shell's template beside the upgrade dialog's render call, when `signingIn` is set and `session !== 'signed-in'`.
- [ ] **Step 4: Run** — the extended app-shell suite, then the whole browser suite — PASS.
- [ ] **Step 5: Commit** — `feat(ui): sign in with an emailed code from the shell, in place`

### Task 5: Localization and the 360 px check

**Files:**
- Modify: `frontend/xliff/de.xlf` (regenerate + translate), `frontend/src/ui/generated/locales/de.ts` (via `npm run i18n:build`)
- Test: the existing German-layout browser test file for dialogs (where the #224 360 px checks live) — add the sign-in dialog

**German targets** (formal Sie; translate exactly these new sources):

| English source | German target |
| --- | --- |
| Sign in with Google | Mit Google anmelden |
| Sign in with email | Mit E-Mail anmelden |
| Email address | E-Mail-Adresse |
| Send code | Code senden |
| Back | Zurück |
| Enter the code we sent to ${email}. | Geben Sie den Code ein, den wir an ${email} gesendet haben. |
| Sign-in code | Anmeldecode |
| Send a new code | Neuen Code senden |
| Send a new code (${resendWaitSeconds}) | Neuen Code senden (${resendWaitSeconds}) |
| Signed in. | Angemeldet. |
| That does not look like an email address. | Das sieht nicht nach einer E-Mail-Adresse aus. |
| Too many codes requested. Please wait a few minutes. | Zu viele Codes angefordert. Bitte warten Sie einige Minuten. |
| That code didn't work. It may have expired — request a new one. | Der Code hat nicht funktioniert. Er ist möglicherweise abgelaufen – fordern Sie einen neuen an. |
| Email sign-in is not available yet. | Die Anmeldung per E-Mail ist noch nicht verfügbar. |

("Sign in" itself already exists in the catalogue.)

- [ ] **Step 1:** `npm run i18n:extract`, fill every new `<target>` from the table, `npm run i18n:build`, `npm run check:i18n` — ok.
- [ ] **Step 2:** Add the German 360 px test: render the dialog's three steps at 360×640 with `de`, assert no horizontal overflow (the existing #224 layout-test helper and its real-CSS setup). If a long German button wraps badly, fix through `wa-button::part(base) { white-space: normal; }` scoped to the dialog (the #224 precedent) — never a smaller font.
- [ ] **Step 3: Run** the layout suite — PASS. **Commit** — `feat(i18n): German copy for email sign-in`

### Task 6: Full verify and the PR

- [ ] **Step 1:** `npm run verify` in `frontend/` — green, zero warnings. The root `openapi.yaml` is the retiring TS contract: **do not** add the email routes to it; the contract of record for this feature is the Java repo's (backend plan Task 6).
- [ ] **Step 2:** Push `feat/email-signin`, open the PR to `main` with `--body-file`; body states the deploy-order note (safe to merge before the API deploy: the email option hides itself on 404) and ends with `🤖 Generated with [Claude Code](https://claude.com/claude-code)`. Do not merge.

---

## Execution notes (deviations ruled during implementation and review)

- **Task 4's "run the refreshed transition" was wrong as written**: a refresher that answered
  `signed-out` arms nothing more, so faking `{kind: 'refreshed'}` would flip the session and let
  the 300-second token die unrefreshed. The implementation instead **stops and restarts the
  refresher**; its first exchange presents the just-stored refresh token and the ordinary
  transition follows. (Final review, Critical.)
- A verify success arriving after the dialog closed is **committed**, not dropped: the client
  already holds and stored the tokens. Only dialog-local notices stay behind the attempt guard.
- `SignInActions` gained `onEmail()` (the chooser→email transition the interface lacked); a 400
  from verify reads as `failed`; the dialog honors `online` with the #224 convention; focus moves
  into each step's first control.
- **Task 6's openapi note is superseded**: since PR #251/#254 the root `openapi.yaml` is the
  documented mirror of the Java contract, so the email operations were mirrored into it from
  `matter-manager-backend` (its PR #7).

## Deliberate scope notes

- No "linked sign-in methods" UI, no passkeys, no Apple (pieces 3–4).
- The email option is optimistic: shown until a start answers 404, then hidden for the session. No capability probe.
- `identity.ts` (`currentAuthor`) is untouched: attribution still follows the profile, not the sign-in method.
