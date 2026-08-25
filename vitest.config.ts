import { playwright } from '@vitest/browser-playwright'
import { defineConfig } from 'vitest/config'

/**
 * Vitest 4 configures multiple packages through `test.projects`. Each package declares
 * its own environment, because they genuinely differ: `core` is pure logic that must run
 * in plain Node with no globals, whereas `web` will need a browser.
 *
 * Keeping `core` in a node environment is not incidental. If a DOM ever becomes available
 * to those tests, it becomes possible to accidentally depend on one, and the package's
 * central promise - that it is pure and testable anywhere - erodes silently.
 */
export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: 'core',
          root: './packages/core',
          environment: 'node',
          include: ['test/**/*.test.ts'],
        },
      },
      {
        test: {
          name: 'web',
          root: './packages/web',
          include: ['test/**/*.test.ts'],
          browser: {
            enabled: true,
            // Vitest 4.1's browser.provider takes a factory, not a provider-name string;
            // the brief's literal `provider: 'playwright'` is from an earlier 4.x minor
            // and fails startup against the installed 4.1.11 with "provider was changed
            // to accept a factory instead of a string".
            provider: playwright(),
            headless: true,
            instances: [{ browser: 'chromium' }],
          },
        },
      },
      // data (node + pouchdb-adapter-memory) and api (node) are added by the
      // milestones that introduce them.
    ],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html', 'lcov'],
      // Explicit include so that a module no test ever imports still counts against the
      // gate. Without it, v8 measures only the files the tests happened to load, and a
      // completely untested module is invisible rather than reported as 0% - a gate that
      // silently ignores untested code is worse than none, because the number gets trusted.
      //
      // These globs are relative to the REPOSITORY ROOT, not to each project's `root`.
      // Using a project-relative glob such as 'src/**/*.ts' matches nothing here, which
      // fails silently: coverage falls back to loaded files only and still reports 100%.
      // Verified by adding an unimported module and confirming the total drops.
      include: ['packages/*/src/**/*.ts'],
      // Per-glob rather than global: `core`'s 90% must not silently become the bar for UI
      // code, and `web`'s lower bar must not silently weaken `core`'s. When data and api
      // arrive they get their own entries here too.
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
    },
  },
})
