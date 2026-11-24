import { playwright } from '@vitest/browser-playwright'
import { defineConfig } from 'vitest/config'

/**
 * The frontend's own test configuration.
 *
 * Standalone rather than a project inside a repository-wide config, for the reason
 * `backend/vitest.config.ts` gives about itself: each half installs and tests without the other
 * present, and the repository root belongs to neither.
 *
 * The four projects are the old package boundaries, kept as *environments* rather than as
 * packages. That distinction is the whole of #181: `domain` and `data` never needed a separate
 * `package.json`, but they very much need a separate environment.
 *
 * `domain` and `data` stay in a plain `node` environment with no globals. That is not
 * incidental. If a DOM ever becomes available to those tests, depending on one by accident
 * becomes possible, and the promise that the domain layer is testable anywhere erodes without
 * anything failing. `tsconfig.domain.json` makes the same statement to the compiler.
 */
/** The zone the `ui-west` project runs its pages in: UTC-7 or UTC-8, never UTC. */
const WEST_OF_UTC = 'America/Los_Angeles'

/** Browser tests that run in {@link WEST_OF_UTC} instead of the runner's own zone. */
const WEST_OF_UTC_TESTS = 'test/ui/**/*.west.browser.test.ts'

export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: 'domain',
          environment: 'node',
          include: ['test/domain/**/*.test.ts'],
        },
      },
      {
        test: {
          name: 'data',
          environment: 'node',
          include: ['test/data/**/*.test.ts'],
        },
      },
      {
        test: {
          name: 'ui-node',
          environment: 'node',
          include: ['test/ui/**/*.test.ts'],
          exclude: ['test/ui/**/*.browser.test.ts'],
        },
      },
      {
        // Lit's package exports ship a `development` build that Vite selects by default under
        // `vitest`. It prints "Lit is in dev mode" once per module instance and, far worse for a
        // test log, emits dev-only diagnostics (change-in-update) that the production build never
        // does. Naming the conditions explicitly (Vite's defaults minus `development`, plus
        // `production`) makes the browser tests run against the build that actually ships, so
        // anything still printed is a real problem rather than noise.
        resolve: { conditions: ['module', 'browser', 'production'] },
        test: {
          name: 'ui',
          include: ['test/ui/**/*.browser.test.ts'],
          exclude: [WEST_OF_UTC_TESTS],
          browser: {
            enabled: true,
            // Vitest 4.1's browser.provider takes a factory, not a provider-name string; the
            // literal `provider: 'playwright'` is from an earlier 4.x minor and fails startup
            // against 4.1.11 with "provider was changed to accept a factory instead of a
            // string".
            provider: playwright(),
            headless: true,
            instances: [{ browser: 'chromium' }],
          },
        },
      },
      {
        // The same browser environment as `ui`, with the page's clock in a zone west of UTC
        // (#354). The runner, CI included, is in UTC, where a date-only value formatted in the
        // browser's own zone and one pinned to UTC read the same; only west of Greenwich does
        // `2026-08-19` become 18 August. A project of its own rather than a zone for the whole
        // suite, so no other test starts depending on, or being hidden by, the runner's zone.
        // `timezoneId` is Playwright's context option, which is what `Intl` in the page reads;
        // `TZ` would move only the Node process.
        resolve: { conditions: ['module', 'browser', 'production'] },
        test: {
          name: 'ui-west',
          include: [WEST_OF_UTC_TESTS],
          browser: {
            enabled: true,
            provider: playwright({ contextOptions: { timezoneId: WEST_OF_UTC } }),
            headless: true,
            instances: [{ browser: 'chromium' }],
          },
        },
      },
    ],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html', 'lcov'],
      // Explicit include so that a module no test ever imports still counts against the gate.
      // Without it, v8 measures only the files the tests happened to load, and a completely
      // untested module is invisible rather than reported as 0% - a gate that silently ignores
      // untested code is worse than none, because the number gets trusted.
      include: ['src/**/*.ts'],
      // lit-localize output. Excluded because it is generated: its statements would move the
      // number without anyone having tested anything, and the guard that actually matters -
      // that it is current and complete - is `npm run check:i18n`, not a coverage percentage.
      exclude: ['src/ui/generated/**'],
      // Per-directory rather than global, carried over unchanged from the three packages these
      // directories used to be: `domain`'s 90% must not silently become the bar for UI code,
      // and the UI's lower bar must not silently weaken `domain`'s.
      thresholds: {
        'src/domain/**': { statements: 90, branches: 90, functions: 90, lines: 90 },
        // A thin layer over a database, every line exercised through a real (in-memory)
        // PouchDB, so it is held to the domain bar rather than the UI's.
        'src/data/**': { statements: 90, branches: 90, functions: 90, lines: 90 },
        'src/ui/**': { statements: 70, branches: 70, functions: 70, lines: 70 },
      },
    },
  },
})
