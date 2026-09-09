import { defineConfig } from 'vitest/config'

/**
 * The backend's own test configuration.
 *
 * Standalone rather than a project inside a repository-wide config, because this package has
 * to install, typecheck and test without the frontend present — that is what keeps a rewrite
 * in another language a change to this directory alone (ADR 0004 keeps that option open).
 *
 * `node` environment, with no DOM anywhere: `src/domain` is pure logic, and if a DOM ever
 * became available to it, depending on one by accident would become possible.
 */
export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html', 'lcov'],
      // Explicit include so that a module no test ever imports still counts against the gate.
      // Without it v8 measures only the files the tests happened to load, and a completely
      // untested module reads as absent rather than as 0%.
      include: ['src/**/*.ts'],
      // Generated from openapi.yaml — types only, erased at runtime, nothing to execute.
      exclude: ['src/generated/**'],
      thresholds: {
        // `src/domain` is pure logic with no I/O, held to the bar `core` was held to. The
        // rest is the boundary to CouchDB and Google, held to 70% per CONTRIBUTING.
        'src/domain/**': { statements: 90, branches: 90, functions: 90, lines: 90 },
        'src/**': { statements: 70, branches: 70, functions: 70, lines: 70 },
      },
    },
  },
})
