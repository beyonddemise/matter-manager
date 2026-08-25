# Application Shell and Routing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the first front-end code — a `<wa-page>` shell with hash routing, a light/dark preference, and a device-list placeholder — so every later M2/M3 view has somewhere to render.

**Architecture:** `<wa-page>` owns layout, sticky regions, the desktop sidebar and the mobile drawer. Routing splits into a pure `matchRoute` (tested in node), a route registry that navigation renders from, and a Lit outlet. Colour-scheme logic is pure and injectable so it tests without a browser.

**Tech Stack:** Lit 3, `@lit/localize`, Web Awesome Pro 3.12, Vite 8, Vitest 4 (node + browser mode), `@open-wc/testing-helpers`, Playwright as the browser provider.

**Spec:** `docs/superpowers/specs/2026-08-26-application-shell-design.md`

## Global Constraints

- **No raw values.** No hex, `px` or `rem` literals in `packages/web`. Colour, spacing, radius, font size and shadow come from `--wa-*` tokens.
- **No hand-rolled layout.** Use `wa-stack`, `wa-cluster`, `wa-grid`, `wa-split` rather than bespoke flexbox/grid.
- **Never style a `<wa-*>` without reading its reference first** — `.claude/skills/webawesome/references/components/<name>.md`. Style through attributes → the component's own tokens → its documented `::part()`. Never set `background`/`color`/`border` on a `<wa-button>` host.
- **Navigation is written once** into `slot="navigation"`. Never duplicate it, never hand-roll a `<wa-drawer>` or a toggle.
- **Every user-visible string** is wrapped in `msg()` from `@lit/localize`, from the first line.
- **Custom elements never self-close:** `<wa-button></wa-button>`.
- **Theme classes:** `wa-theme-glossy wa-palette-anodized` on `<html>`, plus `wa-light` or `wa-dark`.
- **Runtime dependencies** must already appear in `dependency-policy.json`. `lit`, `@lit/localize` and `@awesome.me/webawesome-pro` do. Anything else is a policy change and a review gate.
- **Coverage gates:** `packages/core/src/**` stays at 90%; `packages/web/src/**` is 70%.
- **Components render into the light DOM** (`createRenderRoot() { return this }`). Web Awesome's
  utility classes — `wa-stack`, `wa-cluster`, `wa-split`, `wa-gap-*`, `wa-mobile-only` — are
  plain global selectors in `utilities/layout.css`, and document stylesheets do not cross a
  shadow boundary. Inside a shadow root they silently do nothing. `--wa-*` custom properties
  *do* inherit through shadow DOM, which makes this easy to get half-right: tokens work, layout
  quietly does not. App-specific CSS therefore lives in `src/styles/app.css`, not in
  `static styles`, which Lit only adopts into shadow roots.
- Commit after every task. Run `npm run verify` before each commit.

---

### Task 1: Web package scaffolding and the browser test project

Establishes that a browser test can run at all. Everything after this depends on it.

**Files:**
- Modify: `packages/web/package.json`
- Create: `packages/web/tsconfig.json`
- Create: `packages/web/vite.config.ts`
- Modify: `vitest.config.ts`
- Create: `packages/web/test/smoke.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: a `web` Vitest project running in Chromium; per-glob coverage thresholds.

- [ ] **Step 1: Install dependencies**

```bash
npm install --workspace @matter-manager/web lit @lit/localize
npm install --workspace @matter-manager/web --save-dev \
  @vitest/browser@4.1.11 playwright @open-wc/testing-helpers
npx playwright install chromium
```

- [ ] **Step 2: Create the package tsconfig**

`packages/web/tsconfig.json`:

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "outDir": "dist",
    "rootDir": ".",
    "lib": ["ES2023", "DOM", "DOM.Iterable"],
    "types": ["vite/client"],
    "experimentalDecorators": false,
    "useDefineForClassFields": false
  },
  "include": ["src/**/*.ts", "test/**/*.ts", "vite.config.ts"]
}
```

`useDefineForClassFields: false` is required by Lit's `@property` decorators; without it, class fields shadow the reactive accessors and updates silently stop working.

- [ ] **Step 3: Create the Vite config**

`packages/web/vite.config.ts`:

```ts
import { defineConfig } from 'vite'

export default defineConfig({
  root: __dirname,
  build: { outDir: 'dist', emptyOutDir: true },
})
```

- [ ] **Step 4: Add the web project and per-glob coverage to the root Vitest config**

In `vitest.config.ts`, add a second entry to `test.projects` after the `core` entry:

```ts
      {
        test: {
          name: 'web',
          root: './packages/web',
          include: ['test/**/*.test.ts'],
          browser: {
            enabled: true,
            provider: 'playwright',
            headless: true,
            instances: [{ browser: 'chromium' }],
          },
        },
      },
```

and replace the `coverage.thresholds` block with per-glob gates:

```ts
      thresholds: {
        'packages/core/src/**': {
          statements: 90,
          branches: 90,
          functions: 90,
          lines: 90,
        },
        'packages/web/src/**': {
          statements: 70,
          branches: 70,
          functions: 70,
          lines: 70,
        },
      },
```

Per-glob rather than global: `core`'s 90% must not silently become the bar for UI code, and `web`'s 70% must not silently weaken `core`.

- [ ] **Step 5: Write a smoke test that proves the browser project runs**

`packages/web/test/smoke.test.ts`:

```ts
import { expect, it } from 'vitest'

it('runs in a real browser with a DOM and custom element support', () => {
  const element = document.createElement('div')
  element.textContent = 'hello'
  document.body.append(element)

  expect(document.body.contains(element)).toBe(true)
  expect(typeof customElements.define).toBe('function')
  expect(typeof window.matchMedia).toBe('function')

  element.remove()
})
```

`customElements` and `matchMedia` are asserted because a jsdom-style environment would provide the DOM but not necessarily both, and the whole point of this project is that it is a real browser.

- [ ] **Step 6: Run the test and confirm it passes in Chromium**

Run: `npx vitest run --project web`
Expected: PASS, and the output names the browser (`chromium`).

- [ ] **Step 7: Prove the coverage gate is real (lesson L8)**

Temporarily add `packages/web/src/unused.ts` containing `export const unused = () => 1`, then run `npx vitest run --coverage`. Expected: the `web` gate FAILS, because a module no test imports counts against it. Delete the file and re-run; expected PASS.

A gate that has never been observed failing has not been shown to be a gate.

- [ ] **Step 8: Commit**

```bash
git add packages/web vitest.config.ts package-lock.json package.json
git commit -m "chore: web package scaffolding and browser test project"
```

---

### Task 2: `matchRoute`

The highest-risk logic in the story and entirely pure, so it is tested in node at `core`-level rigour.

**Files:**
- Create: `packages/web/src/router/match.ts`
- Create: `packages/web/test/router/match.test.ts`
- Modify: `vitest.config.ts` (route node-environment tests away from the browser project)

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `interface Route { readonly path: string; readonly view: string; readonly label?: () => string; readonly icon?: string }`
  - `interface RouteMatch { readonly route: Route; readonly params: Readonly<Record<string, string>> }`
  - `function matchRoute(hash: string, routes: readonly Route[]): RouteMatch | null`

- [ ] **Step 1: Give the node-environment tests their own project**

`match.test.ts` must not run in the browser. In `vitest.config.ts`, change the `web` project's `include` to `['test/**/*.browser.test.ts']` and add a third project:

```ts
      {
        test: {
          name: 'web-node',
          root: './packages/web',
          environment: 'node',
          include: ['test/**/*.test.ts'],
          exclude: ['test/**/*.browser.test.ts'],
        },
      },
```

Rename `packages/web/test/smoke.test.ts` to `packages/web/test/smoke.browser.test.ts` and re-run `npx vitest run` to confirm both projects are collected.

- [ ] **Step 2: Write the failing tests**

`packages/web/test/router/match.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { matchRoute, type Route } from '../../src/router/match.js'

const ROUTES: readonly Route[] = [
  { path: '/', view: 'device-list' },
  { path: '/devices/:id', view: 'device-detail' },
  { path: '/devices/:id/remarks', view: 'device-remarks' },
]

describe('matchRoute', () => {
  it.each([['', '/'], ['#', '/'], ['#/', '/'], ['/', '/']])(
    'treats %o as the root route',
    (hash) => {
      expect(matchRoute(hash, ROUTES)?.route.view).toBe('device-list')
    },
  )

  it('matches a static path', () => {
    expect(matchRoute('#/devices/abc', ROUTES)?.route.view).toBe('device-detail')
  })

  it('captures a path parameter', () => {
    expect(matchRoute('#/devices/abc', ROUTES)?.params).toEqual({ id: 'abc' })
  })

  it('captures parameters in a longer path', () => {
    const match = matchRoute('#/devices/abc/remarks', ROUTES)
    expect(match?.route.view).toBe('device-remarks')
    expect(match?.params).toEqual({ id: 'abc' })
  })

  it('decodes percent-encoded parameters', () => {
    expect(matchRoute('#/devices/Ground%20Floor', ROUTES)?.params).toEqual({
      id: 'Ground Floor',
    })
  })

  it('ignores a query string', () => {
    expect(matchRoute('#/devices/abc?from=search', ROUTES)?.params).toEqual({ id: 'abc' })
  })

  it('ignores a trailing slash', () => {
    expect(matchRoute('#/devices/abc/', ROUTES)?.route.view).toBe('device-detail')
  })

  it.each([
    ['an unknown path', '#/nope'],
    ['a path too long for any route', '#/devices/abc/remarks/extra'],
    ['a path too short for any route', '#/devices'],
  ])('returns null for %s', (_label, hash) => {
    expect(matchRoute(hash, ROUTES)).toBeNull()
  })

  it('returns the first matching route when two could match', () => {
    // Order is the tie-breaker, so a registry author can put a specific path
    // before a parameterised one and rely on it winning.
    const overlapping: readonly Route[] = [
      { path: '/devices/new', view: 'device-create' },
      { path: '/devices/:id', view: 'device-detail' },
    ]
    expect(matchRoute('#/devices/new', overlapping)?.route.view).toBe('device-create')
  })

  it('does not treat a parameter as matching an empty segment', () => {
    expect(matchRoute('#/devices//remarks', ROUTES)).toBeNull()
  })

  it('returns null for an empty route table', () => {
    expect(matchRoute('#/', [])).toBeNull()
  })
})
```

- [ ] **Step 3: Run the tests and watch them fail**

Run: `npx vitest run --project web-node`
Expected: FAIL — `Cannot find module '../../src/router/match.js'`.

- [ ] **Step 4: Implement `matchRoute`**

`packages/web/src/router/match.ts`:

```ts
/**
 * Hash-route matching, as a pure function over strings.
 *
 * Pure and browser-free on purpose: an off-by-one in path segmentation produces a
 * plausible wrong view rather than an error, which is exactly the class of bug that needs
 * exhaustive, fast tests rather than a rendered page to find.
 *
 * @module
 */

/** One entry in the route registry. An entry with a `label` also appears in the navigation. */
export interface Route {
  /** Leading-slash path, with `:name` marking a parameter segment. */
  readonly path: string
  /** Key into the shell's view map. */
  readonly view: string
  /** Navigation label. A function so it re-evaluates when the locale changes. */
  readonly label?: () => string
  /** Web Awesome icon name for the navigation entry. */
  readonly icon?: string
}

/** A route and the parameters captured from the path. */
export interface RouteMatch {
  readonly route: Route
  readonly params: Readonly<Record<string, string>>
}

/**
 * Splits a path into segments, ignoring one trailing slash.
 *
 * Empty segments are KEPT. Filtering them out collapses `/devices//remarks` to two segments,
 * which then matches `/devices/:id` and binds `id` to `remarks` — the exact case the tests
 * below require to return `null`.
 */
function segments(path: string): string[] {
  const trimmed = path.endsWith('/') ? path.slice(0, -1) : path
  return trimmed.split('/')
}

/**
 * Finds the first route matching a location hash.
 *
 * Accepts `''`, `'#'`, `'#/'` and `'/'` as the root, because that is the range of values a
 * browser reports for "no hash" depending on how the page was reached.
 *
 * @returns The match, or `null` when nothing matched. `null` rather than a not-found route,
 *   because "nothing matched" and "the user asked for the not-found page" are different facts.
 */
export function matchRoute(hash: string, routes: readonly Route[]): RouteMatch | null {
  const withoutQuery = hash.split('?')[0] ?? ''
  const path = withoutQuery.startsWith('#') ? withoutQuery.slice(1) : withoutQuery
  const actual = segments(path)

  for (const route of routes) {
    const expected = segments(route.path)
    if (expected.length !== actual.length) continue

    const params: Record<string, string> = {}
    let matched = true

    for (const [index, part] of expected.entries()) {
      const value = actual[index] as string
      if (part.startsWith(':')) {
        // An empty segment (from a doubled `/`) is never a valid parameter value. Without
        // this guard the length check alone cannot tell an empty capture from a real one.
        if (value === '') {
          matched = false
          break
        }
        params[part.slice(1)] = decodeURIComponent(value)
      } else if (part !== value) {
        matched = false
        break
      }
    }

    if (matched) return { route, params }
  }

  return null
}
```

**Corrected after implementation.** The first draft of this plan filtered empty segments out, which made `#/devices//remarks` collapse to two segments and match `/devices/:id` with `id='remarks'` — contradicting this task's own test. Keeping empty segments and rejecting an empty parameter capture is what actually satisfies it. Do not add a leading-slash strip either: `#devices/abc` must fall through to `null` rather than silently resolving to a real view.

- [ ] **Step 5: Run the tests and watch them pass**

Run: `npx vitest run --project web-node`
Expected: PASS, 13 tests.

- [ ] **Step 6: Mutation-probe the matcher**

```bash
cat > /tmp/m-match.json <<'JSON'
[
  ["query string not stripped", "hash.split('?')[0] ?? ''", "hash"],
  ["hash prefix not stripped", "withoutQuery.startsWith('#') ? withoutQuery.slice(1) : withoutQuery", "withoutQuery"],
  ["length check removed", "    if (expected.length !== actual.length) continue\n", ""],
  ["empty segments kept", "path.split('/').filter((segment) => segment !== '')", "path.split('/')"],
  ["parameter prefix wrong", "part.startsWith(':')", "part.startsWith('$')"],
  ["no decode", "decodeURIComponent(value)", "value"],
  ["returns first route regardless", "    if (matched) return { route, params }\n", "    return { route, params }\n"]
]
JSON
python3 scripts/mutation-probe.py packages/web/src/router/match.ts packages/web/test/router "/tmp/m-match.json"
```

Expected: `7/7 caught`. If any survives, find the input that distinguishes the two versions before deleting anything — a survivor means redundant code **or** a missing test (lesson L19).

- [ ] **Step 7: Commit**

```bash
npm run verify
git add packages/web/src/router packages/web/test/router vitest.config.ts packages/web/test/smoke.browser.test.ts
git commit -m "feat: hash route matching"
```

---

### Task 3: The route registry

**Files:**
- Create: `packages/web/src/router/routes.ts`
- Create: `packages/web/test/router/routes.test.ts`

**Interfaces:**
- Consumes: `Route` from `../src/router/match.js`.
- Produces: `ROUTES: readonly Route[]`, `NAV_ROUTES: readonly Route[]`.

- [ ] **Step 1: Write the failing tests**

`packages/web/test/router/routes.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { matchRoute } from '../../src/router/match.js'
import { NAV_ROUTES, ROUTES } from '../../src/router/routes.js'

describe('the route registry', () => {
  it('routes the root path to the device list', () => {
    expect(matchRoute('#/', ROUTES)?.route.view).toBe('device-list')
  })

  it('gives every route a unique path', () => {
    const paths = ROUTES.map((route) => route.path)
    expect(new Set(paths).size).toBe(paths.length)
  })

  it('gives every route a view', () => {
    for (const route of ROUTES) expect(route.view).not.toBe('')
  })

  it('lists exactly the labelled routes in the navigation', () => {
    expect(NAV_ROUTES).toEqual(ROUTES.filter((route) => route.label !== undefined))
  })

  it('has at least one navigation entry, or the shell has no navigation to render', () => {
    expect(NAV_ROUTES.length).toBeGreaterThan(0)
  })

  it('gives every navigation entry a label and an icon', () => {
    for (const route of NAV_ROUTES) {
      expect(typeof route.label?.()).toBe('string')
      expect(route.label?.()).not.toBe('')
      expect(route.icon).toBeTruthy()
    }
  })

  it('registers no route whose view the shell cannot render', () => {
    // M2 registers only views that exist. Registering /devices/:id before M2-7 builds
    // its view would match a path and then fail to render, which is worse than not
    // matching it — an unregistered path correctly falls through to not-found.
    expect(ROUTES.map((route) => route.view)).toEqual(['device-list'])
  })
})
```

- [ ] **Step 2: Run the tests and watch them fail**

Run: `npx vitest run --project web-node`
Expected: FAIL — `Cannot find module '../../src/router/routes.js'`.

- [ ] **Step 3: Implement the registry**

`packages/web/src/router/routes.ts`:

```ts
/**
 * The route registry, and the extension point for the whole application.
 *
 * Navigation renders *from* this table, so adding a section is one entry plus one view file
 * rather than an edit to the shell. An entry with a `label` appears in the navigation; one
 * without is reachable but unlisted.
 *
 * Only routes whose view exists belong here. Registering a path before its view is built
 * makes the shell match and then fail to render, which is worse than not matching at all.
 *
 * @module
 */

import { msg } from '@lit/localize'
import type { Route } from './match.js'

export const ROUTES: readonly Route[] = [
  { path: '/', view: 'device-list', label: () => msg('Devices'), icon: 'lightbulb' },
]

/** The routes that appear in the navigation, in registry order. */
export const NAV_ROUTES: readonly Route[] = ROUTES.filter((route) => route.label !== undefined)
```

- [ ] **Step 4: Run the tests and watch them pass**

Run: `npx vitest run --project web-node`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
npm run verify
git add packages/web/src/router/routes.ts packages/web/test/router/routes.test.ts
git commit -m "feat: route registry"
```

---

### Task 4: Colour scheme preference

Pure logic plus one thin DOM-applying function, so nearly all of it tests in node.

**Files:**
- Create: `packages/web/src/scheme.ts`
- Create: `packages/web/test/scheme.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `type SchemePreference = 'light' | 'dark' | 'system'`
  - `type Scheme = 'light' | 'dark'`
  - `const SCHEME_STORAGE_KEY = 'matter-manager.scheme'`
  - `function resolveScheme(preference: SchemePreference, systemPrefersDark: boolean): Scheme`
  - `function readPreference(storage: Pick<Storage, 'getItem'>): SchemePreference`
  - `function writePreference(storage: Pick<Storage, 'setItem'>, preference: SchemePreference): void`
  - `function applyScheme(root: Element, scheme: Scheme): void`

- [ ] **Step 1: Write the failing tests**

`packages/web/test/scheme.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import {
  applyScheme,
  readPreference,
  resolveScheme,
  SCHEME_STORAGE_KEY,
  type SchemePreference,
  writePreference,
} from '../src/scheme.js'

const storageWith = (value: string | null) => ({ getItem: () => value })

describe('resolveScheme', () => {
  it.each([
    ['light', false, 'light'],
    ['light', true, 'light'],
    ['dark', false, 'dark'],
    ['dark', true, 'dark'],
  ])('honours an explicit %s preference regardless of the system', (pref, dark, expected) => {
    expect(resolveScheme(pref as SchemePreference, dark)).toBe(expected)
  })

  it.each([
    [true, 'dark'],
    [false, 'light'],
  ])('follows the system when the preference is "system" (prefersDark=%s)', (dark, expected) => {
    expect(resolveScheme('system', dark)).toBe(expected)
  })
})

describe('readPreference', () => {
  it.each([['light'], ['dark'], ['system']])('reads a stored %s preference', (stored) => {
    expect(readPreference(storageWith(stored))).toBe(stored)
  })

  it('defaults to following the system when nothing is stored', () => {
    expect(readPreference(storageWith(null))).toBe('system')
  })

  it.each([['bright'], [''], ['DARK'], ['null']])(
    'falls back to "system" for the unrecognised stored value %o',
    (stored) => {
      // A value written by an older build, or edited by hand, must not leave the app with an
      // invalid scheme. Following the system is the one answer that is never wrong.
      expect(readPreference(storageWith(stored))).toBe('system')
    },
  )

  it('falls back to "system" when storage throws', () => {
    // Safari in private browsing throws on access rather than returning null.
    const hostile = {
      getItem() {
        throw new Error('denied')
      },
    }
    expect(readPreference(hostile)).toBe('system')
  })
})

describe('writePreference', () => {
  it('writes under the documented key', () => {
    const written: Array<[string, string]> = []
    writePreference({ setItem: (k, v) => written.push([k, v]) }, 'dark')
    expect(written).toEqual([[SCHEME_STORAGE_KEY, 'dark']])
  })

  it('does not throw when storage refuses the write', () => {
    const hostile = {
      setItem() {
        throw new Error('quota')
      },
    }
    expect(() => writePreference(hostile, 'dark')).not.toThrow()
  })
})

describe('applyScheme', () => {
  it('sets exactly one scheme class', () => {
    const root = document.createElement('html')
    root.className = 'wa-theme-glossy wa-palette-anodized wa-light'

    applyScheme(root, 'dark')

    expect(root.classList.contains('wa-dark')).toBe(true)
    expect(root.classList.contains('wa-light')).toBe(false)
  })

  it('leaves the theme and palette classes alone', () => {
    const root = document.createElement('html')
    root.className = 'wa-theme-glossy wa-palette-anodized wa-light'

    applyScheme(root, 'dark')

    expect(root.classList.contains('wa-theme-glossy')).toBe(true)
    expect(root.classList.contains('wa-palette-anodized')).toBe(true)
  })

  it('is idempotent', () => {
    const root = document.createElement('html')
    applyScheme(root, 'dark')
    applyScheme(root, 'dark')
    expect([...root.classList].filter((c) => c === 'wa-dark')).toHaveLength(1)
  })
})
```

`applyScheme` uses `document.createElement`, which the node environment does not provide — but this file is `scheme.test.ts`, collected by `web-node`. Move only the `applyScheme` block into `packages/web/test/scheme.browser.test.ts` with the same imports, so the pure tests stay in node and the DOM test runs in the browser.

- [ ] **Step 2: Run and watch both fail**

Run: `npx vitest run`
Expected: FAIL — `Cannot find module '../src/scheme.js'` in both projects.

- [ ] **Step 3: Implement**

`packages/web/src/scheme.ts`:

```ts
/**
 * The light/dark preference.
 *
 * Three states rather than two: "follow the system" is a distinct choice from "light", and
 * collapsing them means a user who has chosen light gets dark the moment their laptop does.
 *
 * Storage is passed in rather than reached for, so the logic tests without a browser and
 * without touching real `localStorage`.
 *
 * @module
 */

/** What the user chose. */
export type SchemePreference = 'light' | 'dark' | 'system'

/** What is actually applied to the document. */
export type Scheme = 'light' | 'dark'

/** Where the preference is stored. Namespaced, because the origin may host other things. */
export const SCHEME_STORAGE_KEY = 'matter-manager.scheme'

const PREFERENCES: ReadonlySet<string> = new Set(['light', 'dark', 'system'])

/** Turns a preference plus the system setting into the scheme to apply. */
export function resolveScheme(preference: SchemePreference, systemPrefersDark: boolean): Scheme {
  if (preference === 'system') return systemPrefersDark ? 'dark' : 'light'
  return preference
}

/**
 * Reads the stored preference, falling back to following the system.
 *
 * Anything unrecognised — written by an older build, or edited by hand — falls back rather
 * than being applied, because "system" is the one answer that is never wrong. Storage access
 * itself can throw (Safari in private browsing), which is treated the same way.
 */
export function readPreference(storage: Pick<Storage, 'getItem'>): SchemePreference {
  try {
    const stored = storage.getItem(SCHEME_STORAGE_KEY)
    return stored !== null && PREFERENCES.has(stored) ? (stored as SchemePreference) : 'system'
  } catch {
    return 'system'
  }
}

/** Stores the preference. A refused write is not worth breaking the page over. */
export function writePreference(
  storage: Pick<Storage, 'setItem'>,
  preference: SchemePreference,
): void {
  try {
    storage.setItem(SCHEME_STORAGE_KEY, preference)
  } catch {
    // Private browsing, or a full quota. The preference simply does not persist.
  }
}

/** Applies the scheme to the document element, leaving theme and palette classes untouched. */
export function applyScheme(root: Element, scheme: Scheme): void {
  root.classList.toggle('wa-dark', scheme === 'dark')
  root.classList.toggle('wa-light', scheme === 'light')
}
```

- [ ] **Step 4: Run and watch both pass**

Run: `npx vitest run`
Expected: PASS in both `web-node` and `web`.

- [ ] **Step 5: Mutation-probe**

```bash
cat > /tmp/m-scheme.json <<'JSON'
[
  ["system ignores the system setting", "return systemPrefersDark ? 'dark' : 'light'", "return 'light'"],
  ["explicit preference ignored", "  if (preference === 'system') return systemPrefersDark ? 'dark' : 'light'\n  return preference", "  return systemPrefersDark ? 'dark' : 'light'"],
  ["unrecognised value accepted", "stored !== null && PREFERENCES.has(stored)", "stored !== null"],
  ["read throw not caught", "  } catch {\n    return 'system'\n  }", "  } finally {\n  }"],
  ["light class not cleared", "  root.classList.toggle('wa-light', scheme === 'light')\n", ""]
]
JSON
python3 scripts/mutation-probe.py packages/web/src/scheme.ts packages/web/test "/tmp/m-scheme.json"
```

Expected: `5/5 caught`.

- [ ] **Step 6: Commit**

```bash
npm run verify
git add packages/web/src/scheme.ts packages/web/test/scheme.test.ts packages/web/test/scheme.browser.test.ts
git commit -m "feat: light and dark scheme preference"
```

---

### Task 5: The device-list and not-found views

Small, so that Task 6 has real elements to route to rather than placeholders inside the shell.

**Files:**
- Create: `packages/web/src/views/device-list.ts`
- Create: `packages/web/src/views/not-found.ts`
- Create: `packages/web/src/styles/app.css`
- Create: `packages/web/test/views.browser.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: custom elements `<device-list-view>` and `<not-found-view>`.

- [ ] **Step 1: Read the component references you are about to use**

Read `.claude/skills/webawesome/references/components/button.md` and `callout.md` before writing markup. You may not style a `<wa-*>` you have not looked up.

- [ ] **Step 2: Write the failing test**

`packages/web/test/views.browser.test.ts`:

```ts
import { fixture, html } from '@open-wc/testing-helpers'
import { expect, it } from 'vitest'
import '../src/views/device-list.js'
import '../src/views/not-found.js'

it('shows a heading and an empty state on the device list', async () => {
  const element = await fixture(html`<device-list-view></device-list-view>`)
  const heading = element.querySelector('h1')

  expect(heading?.textContent?.trim()).not.toBe('')
  expect(element.textContent).toContain('No devices')
})

it('renders into the light DOM so global utility classes apply', async () => {
  // wa-stack and friends are document-level CSS. A shadow root would leave them inert
  // while --wa-* tokens kept working, which is the half-right failure this pins.
  const element = await fixture(html`<device-list-view></device-list-view>`)
  expect(element.shadowRoot).toBeNull()
  expect(element.querySelector('.wa-stack')).not.toBeNull()
})

it('offers a way back from the not-found view', async () => {
  const element = await fixture(html`<not-found-view></not-found-view>`)
  const link = element.querySelector('a')

  // The issue requires a way back, not merely an apology.
  expect(link).not.toBeNull()
  expect(link?.getAttribute('href')).toBe('#/')
})

it('uses a real heading element rather than styled text', async () => {
  const element = await fixture(html`<not-found-view></not-found-view>`)
  expect(element.querySelector('h1')).not.toBeNull()
})
```

- [ ] **Step 3: Run and watch it fail**

Run: `npx vitest run --project web`
Expected: FAIL — modules not found.

- [ ] **Step 4: Implement the views**

`packages/web/src/views/device-list.ts`:

```ts
import { msg } from '@lit/localize'
import { html, LitElement } from 'lit'

/** The device list. M2-6 replaces the body; the shell does not change when it does. */
export class DeviceListView extends LitElement {
  // Light DOM: Web Awesome's utility classes are global CSS and do not cross a shadow
  // boundary. `static styles` is not used for the same reason — Lit only adopts it into
  // shadow roots. App CSS lives in styles/app.css.
  protected override createRenderRoot(): HTMLElement {
    return this
  }

  override render() {
    return html`
      <div class="wa-stack wa-gap-l">
        <h1>${msg('Devices')}</h1>
        <p class="empty">${msg('No devices yet.')}</p>
      </div>
    `
  }
}

customElements.define('device-list-view', DeviceListView)
```

`packages/web/src/views/not-found.ts`:

```ts
import { msg } from '@lit/localize'
import { html, LitElement } from 'lit'

/** Shown when no route matched. Offers a way back, per the story's second scenario. */
export class NotFoundView extends LitElement {
  protected override createRenderRoot(): HTMLElement {
    return this
  }

  override render() {
    return html`
      <div class="wa-stack wa-gap-m">
        <h1>${msg('Page not found')}</h1>
        <p>${msg('That address does not match anything in this application.')}</p>
        <a href="#/">${msg('Back to devices')}</a>
      </div>
    `
  }
}

customElements.define('not-found-view', NotFoundView)
```

`packages/web/src/styles/app.css` — every value a token, no raw literals:

```css
/* Application CSS. Global rather than per-component, because the components render into
   the light DOM so that Web Awesome's utility classes reach them. */

app-shell,
device-list-view,
not-found-view {
  display: block;
}

.app-empty {
  color: var(--wa-color-text-quiet);
}

.app-back {
  color: var(--wa-color-brand-on-quiet);
}

.app-header {
  padding: var(--wa-space-s) var(--wa-space-m);
}

.app-main {
  padding: var(--wa-space-l);
}

wa-page {
  --menu-width: 15rem;
}

/* Without this the sidebar track stays reserved on mobile, leaving an empty band. */
wa-page[view='mobile'] {
  --menu-width: auto;
}

.app-nav a {
  display: flex;
  align-items: center;
  gap: var(--wa-space-s);
  padding: var(--wa-space-s) var(--wa-space-m);
  border-radius: var(--wa-border-radius-m);
  color: var(--wa-color-text-normal);
  text-decoration: none;
}

.app-nav a[aria-current='page'] {
  background-color: var(--wa-color-brand-fill-quiet);
  color: var(--wa-color-brand-on-quiet);
}
```

Update the two views to use `class="app-empty"` and `class="app-back"` on the paragraph and
link respectively.

- [ ] **Step 5: Run and watch it pass**

Run: `npx vitest run --project web`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
npm run verify
git add packages/web/src/views packages/web/test/views.browser.test.ts
git commit -m "feat: device list and not-found views"
```

---

### Task 6: The shell

**Files:**
- Create: `packages/web/src/app-shell.ts`
- Create: `packages/web/test/app-shell.browser.test.ts`

**Interfaces:**
- Consumes: `matchRoute`, `ROUTES`, `NAV_ROUTES`, `applyScheme`, `readPreference`, `resolveScheme`, `writePreference`; the two view elements.
- Produces: custom element `<app-shell>`.

- [ ] **Step 1: Read the component references**

Read `.claude/skills/webawesome/references/components/page.md`, `button.md` and `icon.md`. Note `<wa-page>`'s slots, `--menu-width`, `data-toggle-nav` and `data-drawer="close"`.

- [ ] **Step 2: Write the failing tests**

`packages/web/test/app-shell.browser.test.ts`:

```ts
import { fixture, html } from '@open-wc/testing-helpers'
import { afterEach, beforeEach, expect, it } from 'vitest'
import '../src/app-shell.js'
import { NAV_ROUTES } from '../src/router/routes.js'

const shell = async () => await fixture(html`<app-shell></app-shell>`)

beforeEach(() => {
  window.location.hash = '#/'
})

afterEach(() => {
  window.location.hash = ''
})

it('renders the device list at the root path', async () => {
  const element = await shell()
  expect(element.querySelector('device-list-view')).not.toBeNull()
})

it('renders the not-found view for an unknown path', async () => {
  window.location.hash = '#/nope'
  const element = await shell()
  expect(element.querySelector('not-found-view')).not.toBeNull()
})

it('renders one navigation link per labelled route, and no more', async () => {
  // Guards the duplicated-navigation trap: slot="navigation" already renders in both
  // views, so a second copy would double these.
  const element = await shell()
  expect(element.querySelectorAll('nav a').length).toBe(NAV_ROUTES.length)
})

it('marks the current navigation entry', async () => {
  const element = await shell()
  const current = element.querySelector('nav a[aria-current="page"]')
  expect(current?.getAttribute('href')).toBe('#/')
})

it('closes the mobile drawer when a navigation link is tapped', async () => {
  const element = await shell()
  expect(element.querySelector('nav a')?.getAttribute('data-drawer')).toBe('close')
})

it('changes view when the hash changes, without remounting', async () => {
  const element = await shell()
  window.location.hash = '#/nope'
  await new Promise((resolve) => setTimeout(resolve, 0))
  await (element as unknown as { updateComplete: Promise<unknown> }).updateComplete

  expect(element.querySelector('not-found-view')).not.toBeNull()
  expect(element.querySelector('device-list-view')).toBeNull()
})

it('exposes exactly one navigation region', async () => {
  const element = await shell()
  expect(element.querySelectorAll('[slot="navigation"]').length).toBe(1)
})

it('renders into the light DOM so wa-page and the utilities work', async () => {
  const element = await shell()
  expect(element.shadowRoot).toBeNull()
  expect(element.querySelector('wa-page')).not.toBeNull()
})
```

- [ ] **Step 3: Run and watch it fail**

Run: `npx vitest run --project web`
Expected: FAIL — `Cannot find module '../src/app-shell.js'`.

- [ ] **Step 4: Implement the shell**

`packages/web/src/app-shell.ts`:

```ts
import { msg } from '@lit/localize'
import { html, LitElement, type TemplateResult } from 'lit'
import { matchRoute } from './router/match.js'
import { NAV_ROUTES, ROUTES } from './router/routes.js'
import { applyScheme, readPreference, resolveScheme, writePreference } from './scheme.js'
import './views/device-list.js'
import './views/not-found.js'

/** View id to markup. Explicit rather than dynamic, so an unknown view is a type error. */
const VIEWS: Readonly<Record<string, () => TemplateResult>> = {
  'device-list': () => html`<device-list-view></device-list-view>`,
}

/**
 * The application shell.
 *
 * `<wa-page>` owns the layout, the sticky regions, the desktop sidebar and the mobile drawer.
 * Navigation is written once into `slot="navigation"` and rendered in both views by the
 * component; there is deliberately no second copy and no hand-rolled drawer.
 */
export class AppShell extends LitElement {
  /**
   * Light DOM, and this is load-bearing rather than a preference.
   *
   * `<wa-page>` reads `--menu-width` and its own `view` attribute from document CSS, and the
   * `wa-stack` / `wa-cluster` / `wa-split` / `wa-mobile-only` utilities are global selectors.
   * None of that crosses a shadow boundary. Custom properties *do* inherit, so a shadow root
   * yields a page where the tokens look right and the layout silently does not happen.
   */
  protected override createRenderRoot(): HTMLElement {
    return this
  }

  static override properties = {
    hash: { state: true },
  }

  declare hash: string

  private readonly onHashChange = () => {
    this.hash = window.location.hash
  }

  constructor() {
    super()
    this.hash = window.location.hash
  }

  override connectedCallback(): void {
    super.connectedCallback()
    window.addEventListener('hashchange', this.onHashChange)
  }

  override disconnectedCallback(): void {
    window.removeEventListener('hashchange', this.onHashChange)
    super.disconnectedCallback()
  }

  private toggleScheme(): void {
    const prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches
    const next = resolveScheme(readPreference(localStorage), prefersDark) === 'dark'
      ? 'light'
      : 'dark'
    writePreference(localStorage, next)
    applyScheme(document.documentElement, next)
  }

  override render() {
    const match = matchRoute(this.hash, ROUTES)
    const view = match ? VIEWS[match.route.view] : undefined

    return html`
      <wa-page>
        <header slot="header" class="wa-split app-header">
          <div class="wa-cluster">
            <wa-button data-toggle-nav appearance="plain" class="wa-mobile-only">
              <wa-icon name="bars" label=${msg('Menu')}></wa-icon>
            </wa-button>
            <strong>${msg('Matter Manager')}</strong>
          </div>
          <wa-button
            appearance="plain"
            @click=${this.toggleScheme}
            label=${msg('Switch between light and dark')}
          >
            <wa-icon name="circle-half-stroke"></wa-icon>
          </wa-button>
        </header>

        <nav slot="navigation" class="wa-stack wa-gap-2xs app-nav">
          ${NAV_ROUTES.map(
            (route) => html`
              <a
                href="#${route.path}"
                data-drawer="close"
                aria-current=${match?.route === route ? 'page' : 'false'}
              >
                <wa-icon name=${route.icon ?? ''}></wa-icon>
                ${route.label?.()}
              </a>
            `,
          )}
        </nav>

        <main class="app-main">${view ? view() : html`<not-found-view></not-found-view>`}</main>
      </wa-page>
    `
  }
}

customElements.define('app-shell', AppShell)
```

- [ ] **Step 5: Run and watch it pass**

Run: `npx vitest run --project web`
Expected: PASS, 7 tests.

- [ ] **Step 6: Commit**

```bash
npm run verify
git add packages/web/src/app-shell.ts packages/web/test/app-shell.browser.test.ts
git commit -m "feat: application shell with routing and scheme toggle"
```

---

### Task 7: Boot and page

**Files:**
- Create: `packages/web/index.html`
- Create: `packages/web/src/main.ts`
- Modify: `packages/web/package.json` (scripts)

**Interfaces:**
- Consumes: `<app-shell>`, `applyScheme`, `readPreference`, `resolveScheme`.
- Produces: a page that runs under `npm run dev --workspace @matter-manager/web`.

- [ ] **Step 1: Create the page**

`packages/web/index.html`:

```html
<!doctype html>
<html lang="en" class="wa-theme-glossy wa-palette-anodized wa-light">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Matter Manager</title>
    <style>
      html,
      body {
        min-height: 100%;
        padding: 0;
        margin: 0;
      }
    </style>
  </head>
  <body>
    <app-shell></app-shell>
    <script type="module" src="/src/main.ts"></script>
  </body>
</html>
```

The `html`/`body` reset is required by `<wa-page>`; without it the page shows unexplained gaps.

- [ ] **Step 2: Create the entry point**

`packages/web/src/main.ts`:

```ts
import '@awesome.me/webawesome-pro/dist/styles/webawesome.css'
import '@awesome.me/webawesome-pro/dist/styles/themes/glossy.css'
import '@awesome.me/webawesome-pro/dist/styles/color/palettes/anodized.css'
import '@awesome.me/webawesome-pro/dist/components/button/button.js'
import '@awesome.me/webawesome-pro/dist/components/icon/icon.js'
import '@awesome.me/webawesome-pro/dist/components/page/page.js'
import './styles/app.css'
import './app-shell.js'
import { applyScheme, readPreference, resolveScheme } from './scheme.js'

// Applied before first paint so the page never flashes the wrong scheme.
const media = window.matchMedia('(prefers-color-scheme: dark)')
const apply = () =>
  applyScheme(document.documentElement, resolveScheme(readPreference(localStorage), media.matches))

apply()
media.addEventListener('change', apply)
```

Theme CSS is imported here rather than linked in `index.html`, because a `<link href="/node_modules/…">` resolves against the Vite root and fails silently — a missing stylesheet is not a console error, and the page renders unstyled while reporting success.

- [ ] **Step 3: Add the scripts**

In `packages/web/package.json`, add:

```json
  "scripts": {
    "dev": "vite",
    "build": "vite build",
    "preview": "vite preview"
  }
```

- [ ] **Step 4: Run it and look at it**

```bash
npm run dev --workspace @matter-manager/web
```

Open the printed URL. Confirm, at a desktop width and then narrowed to a phone width:

- the sidebar appears on desktop and collapses to a hamburger on mobile
- tapping the hamburger opens the drawer, and tapping the link closes it
- the scheme toggle flips light and dark, and the choice survives a reload
- `#/nope` shows the not-found view with a working link back
- the console is clean

- [ ] **Step 5: Commit**

```bash
npm run verify
git add packages/web/index.html packages/web/src/main.ts packages/web/package.json
git commit -m "feat: boot the application shell"
```

---

### Task 8: Verification and review

**Files:** none created; fixes go wherever the review finds them.

- [ ] **Step 1: Walk the Web Awesome design skill's checklist yourself**

Open `.claude/skills/webawesome-design/SKILL.md` and walk its final-pass checklist against every file in `packages/web`. In particular: no duplicated navigation, no fixed `--menu-width` left set on mobile, no raw hex/`px`/`rem`, no `<wa-button>` styled through its host, no emoji, real headings, labels on icon-only controls.

- [ ] **Step 2: Dispatch an independent review subagent**

The design skill requires this and it is not optional. Dispatch a subagent with the contents of `packages/web/src/**` and the skill's rules, asking it to find violations rather than to agree. Apply what it surfaces.

- [ ] **Step 3: Confirm the coverage split is real**

Run `npx vitest run --coverage`. Confirm the report shows both `packages/core/src/**` at ≥90% and `packages/web/src/**` at ≥70%, and that neither threshold has silently become the other.

- [ ] **Step 4: Full verification**

```bash
npm run verify
```

Expected: exit 0, all projects passing.

- [ ] **Step 5: Commit any fixes and open the pull request**

```bash
git add -A
git commit -m "fix: address design review findings"
gh pr create --title 'M2-2: application shell and routing' --base main
```

The pull request body should state: the theme and palette chosen and why; that navigation has one entry and why that is correct; the mutation probe results; and that an independent review pass ran.
