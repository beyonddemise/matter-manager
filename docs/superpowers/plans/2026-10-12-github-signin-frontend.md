# GitHub Sign-In (Frontend) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. **UI tasks: load the `webawesome-design` and `webawesome` skills before writing (project CLAUDE.md).**

**Goal:** The sign-in chooser renders from `GET /auth/methods` and gains "Sign in with GitHub", which redirects exactly as Google does.

**Architecture:** A throw-free `authMethods` client (the `plans.ts` pattern, no cache: signing in needs a connection anyway). The shell fetches it when the chooser opens and derives which buttons show; unreadable means today's chooser exactly (Google + optimistic email, no GitHub). The GitHub button is a full-page navigation to `${API_BASE}/auth/github`; the return trip is the existing handoff → token exchange, so no new session code.

**Tech Stack:** Lit (light DOM) + `@lit/localize` (en/de, Sie), Web Awesome Pro, Vitest browser tests.

**Spec:** `docs/superpowers/specs/2026-10-12-github-signin-design.md`. Backend counterpart ships first; against an older API the chooser falls back, so merge order is safe.

## Global Constraints

- Repo `/Users/stw/Code/matter-manager`, branch `feat/github-signin` (already carries the spec and both plans).
- Copy localized (`msg()`, Sie); `npm run i18n:extract` after copy changes, translate every new `<target>` in `frontend/xliff/de.xlf` by hand, `npm run i18n:build`.
- Google stays the surface's one filled brand button; GitHub and email are outlined/plain.
- Accessibility as piece 1 settled it: persistent status region, focus steps, German at 360 px.
- Verify bar: `npm run verify` in `frontend/` green with zero warnings.
- Commits: conventional, ending `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`.

## Review Focus

1. **Methods unreachable or 404 (older API)** must yield exactly today's chooser — Google plus the optimistic email option, never a GitHub button → Task 2's fallback test.
2. **A methods answer landing after the dialog closed** must not reopen or mutate it → Task 2's stale-answer test (the piece-1 attempt-counter pattern).
3. **`email: false` in a readable answer** must hide the email option even though its 404-hiding would also catch it later → Task 2's matrix test.
4. **`google: false`** (mail-only deployment) must leave a usable chooser: the email option still renders and still works → Task 2's matrix test.
5. **Three buttons in German at 360 px** must not overflow → Task 3's layout test.

---

### Task 1: The auth-methods client

**Files:**
- Create: `frontend/src/ui/auth-methods.ts`
- Modify: `frontend/src/ui/composition.ts` (one wiring function + `beginGitHubSignIn`)
- Test: `frontend/test/ui/auth-methods.test.ts`

**Interfaces:**
- Produces:

```ts
export interface AuthMethods {
  readonly google: boolean
  readonly github: boolean
  readonly email: boolean
}
export function isAuthMethods(body: unknown): body is AuthMethods
export interface AuthMethodsApi {
  read(): Promise<AuthMethods | undefined>
}
export function authMethodsApi(baseUrl: string, fetchImpl: typeof fetch = fetch): AuthMethodsApi
```

and in `composition.ts`: `export function authMethods(fetchImpl: typeof fetch = fetch): AuthMethodsApi` wiring `API_BASE`, plus, beside `beginSignIn`:

```ts
/**
 * Starts the GitHub sign-in journey — a full-page navigation for the reason `beginSignIn` gives.
 *
 * @param go injected so a test does not navigate the page it is running in
 */
export function beginGitHubSignIn(
  go: (url: string) => void = (url) => window.location.assign(url),
): void {
  go(`${API_BASE}/auth/github`)
}
```

- [ ] **Step 1: Write the failing tests**

```ts
import { describe, expect, it } from 'vitest'
import { type AuthMethods, authMethodsApi, isAuthMethods } from '../../src/ui/auth-methods.js'

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

const answering =
  (response: Response | Error) =>
  (async () => {
    if (response instanceof Error) throw response
    return response
  }) as unknown as typeof fetch

const ALL: AuthMethods = { google: true, github: true, email: true }

describe('whether a body is an auth-methods answer', () => {
  it('accepts the contract shape', () => {
    expect(isAuthMethods(ALL)).toBe(true)
    expect(isAuthMethods({ google: true, github: false, email: false })).toBe(true)
  })

  it.each([
    ['a proxy error page', '<html>'],
    ['null', null],
    ['a missing flag', { google: true, github: true }],
    ['a flag that is not a boolean', { ...ALL, github: 'yes' }],
  ])('refuses %s', (_name, body) => {
    expect(isAuthMethods(body)).toBe(false)
  })
})

describe('authMethodsApi', () => {
  it('reads GET /auth/methods, without a token', async () => {
    let asked: string | undefined
    const api = authMethodsApi('/api', ((url: string) => {
      asked = url
      return Promise.resolve(json(200, ALL))
    }) as unknown as typeof fetch)
    expect(await api.read()).toEqual(ALL)
    expect(asked).toBe('/api/auth/methods')
  })

  it.each([
    ['a 404 from an older API', json(404, { title: 'Not Found' })],
    ['a 500', json(500, {})],
    ['a 200 that is not the shape', json(200, { methods: ['google'] })],
    ['a network failure', new TypeError('fetch failed')],
  ])('answers undefined, without throwing, for %s', async (_name, response) => {
    await expect(authMethodsApi('/api', answering(response)).read()).resolves.toBeUndefined()
  })
})
```

- [ ] **Step 2: Run to verify failure** — `npx vitest run test/ui/auth-methods.test.ts` (in `frontend/`) — FAIL: module missing.
- [ ] **Step 3: Implement** `auth-methods.ts` (module doc in the house voice: what it answers, why `read` never throws — the caller's fallback is the same for every failure, the `plans.ts` argument; why there is **no** cache: a chooser offline cannot sign in whatever it shows, so a cached answer would only offer buttons that cannot work):

```ts
export interface AuthMethods {
  readonly google: boolean
  readonly github: boolean
  readonly email: boolean
}

/** Checked by shape at the trust boundary, as `isPlanMatrix` is. */
export function isAuthMethods(body: unknown): body is AuthMethods {
  if (typeof body !== 'object' || body === null) return false
  const value = body as Record<string, unknown>
  return (
    typeof value.google === 'boolean' &&
    typeof value.github === 'boolean' &&
    typeof value.email === 'boolean'
  )
}

export interface AuthMethodsApi {
  /** The deployment's sign-in methods, or `undefined` when there is no readable answer. */
  read(): Promise<AuthMethods | undefined>
}

export function authMethodsApi(baseUrl: string, fetchImpl: typeof fetch = fetch): AuthMethodsApi {
  const base = baseUrl.replace(/\/+$/, '')
  return {
    async read(): Promise<AuthMethods | undefined> {
      let body: unknown
      try {
        const response = await fetchImpl(`${base}/auth/methods`, {
          headers: { accept: 'application/json' },
        })
        if (!response.ok) return undefined
        body = await response.json()
      } catch {
        return undefined
      }
      return isAuthMethods(body) ? body : undefined
    },
  }
}
```

- [ ] **Step 4: Run** — PASS. Also `npx tsc --noEmit`.
- [ ] **Step 5: Commit** — `feat(ui): auth-methods client — what this deployment can sign in with`

### Task 2: The chooser renders from methods (UI — load both skills first)

**Files:**
- Modify: `frontend/src/ui/sign-in-dialog.ts` (chooser step shape + GitHub button)
- Modify: `frontend/src/ui/app-shell.ts` (fetch on open, derive the chooser, `onGitHub`)
- Test: `frontend/test/ui/sign-in-dialog.browser.test.ts` (chooser tests updated), `frontend/test/ui/sign-in.browser.test.ts` (shell matrix, fallback, stale answer)

**Interfaces:**
- Consumes: `authMethods()`, `beginGitHubSignIn` (Task 1), the piece-1 dialog and shell state.
- Produces (breaking change to the piece-1 types, all consumers updated here):

```ts
export type SignInStep =
  | { step: 'chooser'; google: boolean; github: boolean; email: boolean }
  | { step: 'email'; busy: boolean }
  | { step: 'code'; email: string; busy: boolean; resendWaitSeconds: number }

export interface SignInActions {
  onGoogle(): void
  onGitHub(): void
  onEmail(): void
  // onSendCode / onVerify / onResend / onBack / onClose unchanged
}
```

The shell derives the chooser from its state — one function, so the fallback rule lives in one
place:

```ts
/** What the chooser offers: the deployment's answer when heard, today's optimism otherwise. */
private chooserStep(): SignInStep {
  const methods = this.signInMethods
  return {
    step: 'chooser',
    google: methods?.google ?? true,
    // Never without a readable answer: the button is a full-page navigation that cannot hide
    // behind a 404 the way the email option's fetch does.
    github: methods?.github ?? false,
    // The 404-hiding stays as belt and braces for the in-between deployments.
    email: (methods?.email ?? true) && !this.emailUnavailable,
  }
}
```

- [ ] **Step 1: Write the failing tests.**

  Dialog (`sign-in-dialog.browser.test.ts`): update the two chooser tests to the new shape and add:
  - the chooser with `{google: true, github: true, email: true}` renders `[data-google-sign-in]` (the one filled brand button), `[data-github-sign-in]` (outlined) and `[data-email-option]`, in that order;
  - `{github: false}` renders no `[data-github-sign-in]`; `{email: false}` no `[data-email-option]`; `{google: false, github: false, email: true}` still renders the email option (Review Focus 4);
  - clicking `[data-github-sign-in]` calls `onGitHub` once and nothing else.

  Shell (`sign-in.browser.test.ts`): the `emailShell` harness gains `.authMethods=${options.methods ?? { read: async () => undefined }}` and a `signInGitHub` spy; tests:
  - `offers GitHub when the deployment does`: methods answers all-true → open the chooser (waitUntil `[data-github-sign-in]`), click it → the `signInGitHub` spy called once, dialog closed (the Google test's shape);
  - `falls back to today's chooser when methods cannot be read`: methods answers undefined → `[data-google-sign-in]` and `[data-email-option]` present, `[data-github-sign-in]` absent (Review Focus 1);
  - `hides the email option when the deployment says so`: methods `{google: true, github: true, email: false}` → no `[data-email-option]` (Review Focus 3);
  - `a methods answer after the dialog closed changes nothing`: a deferred `read()`; open, close, then resolve all-true → no dialog reappears, and reopening shows GitHub (the answer was kept, only the mutation was gated) (Review Focus 2).
- [ ] **Step 2: Run to verify failure.**
- [ ] **Step 3: Implement.**
  - `sign-in-dialog.ts`: the chooser takes the three booleans; the GitHub button between Google and email:

    ```ts
    ${
      state.github
        ? html`<wa-button data-github-sign-in appearance="outlined" ?disabled=${!online} @click=${actions.onGitHub}>
            ${msg('Sign in with GitHub')}
          </wa-button>`
        : ''
    }
    ```

    Google and email render iff their flags, with their existing attributes unchanged.
  - `app-shell.ts`: new state `signInMethods?: AuthMethods` (plain private — the chooser re-derives per render; trigger `requestUpdate` via assigning the reactive `signingIn`), seams `authMethods?: AuthMethodsApi` and `signInGitHub?: () => void` (properties `{ attribute: false }`). `onSignIn` sets the chooser from `chooserStep()` and kicks `void this.loadSignInMethods()` (single-flight like the plan matrix: hold the promise, clear in `finally`); the loader re-derives the open chooser when an answer lands and the dialog still shows the chooser — gated by the piece-1 `signInAttempt` counter. `onBack` re-derives through `chooserStep()` too (so a methods answer heard mid-flow reaches the chooser on the way back). `signInActions.onGitHub`: `this.closeSignIn(); (this.signInGitHub ?? beginGitHubSignIn)()` — the Google branch's shape. The `unavailable` outcome keeps setting `emailUnavailable = true` and now re-derives via `chooserStep()` instead of hand-building the chooser.
- [ ] **Step 4: Run** — both files, then `npx vitest run` whole suite — PASS.
- [ ] **Step 5: Commit** — `feat(ui): the sign-in chooser renders what the deployment serves, GitHub included`

### Task 3: German copy and the 360 px check

**Files:**
- Modify: `frontend/xliff/de.xlf` (+ `npm run i18n:build` output)
- Test: `frontend/test/ui/sign-in-dialog.browser.test.ts` (the German 360 px suite's chooser case)

**German target** (the only new string): `Sign in with GitHub` → `Mit GitHub anmelden`.

- [ ] **Step 1:** `npm run i18n:extract`, fill the one `<target>`, `npm run i18n:build`, `npm run check:i18n` — ok.
- [ ] **Step 2:** Extend the German-360px chooser case to the three-button chooser (`{google: true, github: true, email: true}`), assert `Mit GitHub anmelden` present and the existing no-sideways-scroll checks hold.
- [ ] **Step 3: Run the dialog suite** — PASS. **Commit** — `feat(i18n): German copy for the GitHub option`

### Task 4: Contract mirror, full verify, PR

- [ ] **Step 1:** Mirror into the root `openapi.yaml`, verbatim from the backend contract (its Task 4): the `/auth/methods`, `/auth/github`, `/auth/github/callback` operations and the `AuthMethods` schema, at the same relative positions (methods before the Google pair; the GitHub pair after it; the schema beside `EmailSignInStart`). `python3 -c "import yaml; yaml.safe_load(open('openapi.yaml'))"` — ok. (The root file is the documented mirror of the Java contract — the piece-1 execution note; the two must say the same thing.)
- [ ] **Step 2:** `npm run verify` in `frontend/` — green, zero warnings (run the bare command; read the log, not just the exit).
- [ ] **Step 3:** Push `feat/github-signin`, open the PR to `main` with `--body-file`; body states the merge-order note (safe before the backend deploy: no readable `/auth/methods` means today's chooser) and ends with `🤖 Generated with [Claude Code](https://claude.com/claude-code)`. Do not merge.

---

## Deliberate scope notes

- No GitHub icon asset: the button is text, like the email option — brand icons are a design
  decision for all providers at once (piece 3's chooser will revisit).
- The methods answer is not cached and not announced; it only shapes the chooser.
- `identity.ts` stays untouched: attribution follows the profile, not the provider.
