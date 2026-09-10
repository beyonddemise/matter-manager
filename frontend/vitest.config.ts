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
        test: {
          name: 'ui',
          include: ['test/ui/**/*.browser.test.ts'],
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
