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
      // data (node + pouchdb-adapter-memory), web (browser) and api (node) are added
      // by the milestones that introduce them.
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
      // `core` is currently the only package, so the global gate is its gate. When data,
      // web and api arrive they get their own lower per-project thresholds; core stays
      // at 90 because it holds the logic that can actually be wrong.
      thresholds: {
        statements: 90,
        branches: 90,
        functions: 90,
        lines: 90,
      },
    },
  },
})
