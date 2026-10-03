import { test as base } from '@playwright/test'

/**
 * The suite's `test`: Playwright's, plus a deterministic signed-out answer for `/auth/token`.
 *
 * The application asks `POST /auth/token` on every load to find out whether it is signed in. No
 * backend runs under these tests, so the preview server's proxy would answer with a connection
 * error it logs as noise. Answering the way a real backend does for a caller with no handoff or
 * refresh token (a 401 `problem+json`) keeps the run quiet and keeps the app on the
 * signed-out path it is meant to take. Routed on the context so every page and the service
 * worker's fetches are covered; a test that goes offline is unaffected, as offline requests
 * fail before routing.
 */
export const test = base.extend({
  context: async ({ context }, use) => {
    await context.route('**/auth/token', (route) =>
      route.fulfill({
        status: 401,
        contentType: 'application/problem+json',
        body: JSON.stringify({ title: 'Not signed in', status: 401 }),
      }),
    )
    await use(context)
  },
})

export { expect } from '@playwright/test'
