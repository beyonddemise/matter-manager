import { defineConfig, devices } from '@playwright/test'

/**
 * The end-to-end suite, promised in `e2e/README.md` since M2 and empty until #57.
 *
 * **It drives the built site, not the dev server.** What these journeys are for is the things
 * unit tests cannot reach — the service worker, the bundle actually shipping, a real IndexedDB
 * surviving a reload — and every one of those differs between `vite dev` and `vite build`. A
 * suite that passed against the dev server would be testing something nobody deploys.
 *
 * Chromium only. The other engines matter enormously for this application and are exactly what
 * a browser runner cannot honestly stand in for: iOS Safari's storage eviction and its
 * seven-day cap are the reason #112 exists, and Playwright's WebKit is not iOS Safari. Those
 * stay a manual check, written down rather than implied.
 */
export default defineConfig({
  testDir: 'e2e/tests',
  // Journeys touch a shared IndexedDB per browser context; running them at once in one browser
  // would have them deleting each other's devices.
  workers: 1,
  fullyParallel: false,
  // A journey that needs longer than this is stuck, not slow.
  timeout: 30_000,
  expect: { timeout: 10_000 },
  // A test that only passes on the second run is a test nobody can read a failure from.
  retries: 0,
  reporter: process.env.CI === undefined ? [['list']] : [['list'], ['html', { open: 'never' }]],

  use: {
    baseURL: 'http://localhost:4173',
    // Kept only for a failure: a trace per passing run is gigabytes nobody opens.
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },

  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],

  webServer: {
    // `preview` serves `dist`, which is the artefact the deploy uploads. `--strictPort` for the
    // reason `vite.config.ts` gives: everything around it names 4173, and a silent move leaves
    // the suite testing whatever else is on the next port.
    command: 'npm --workspace @matter-manager/web run preview -- --port 4173 --strictPort',
    url: 'http://localhost:4173',
    reuseExistingServer: process.env.CI === undefined,
    timeout: 60_000,
  },
})
