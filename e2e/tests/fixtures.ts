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

/** The verified reference device; see `frontend/test/domain/matter/payload.test.ts`. */
export const PAYLOAD = 'MT:Y.K9042C00KA0648G00'

/**
 * Records a device through the add form's four steps, the way a person does: each step's
 * fields, then Next, and Save on Review - and returns once the device list is showing.
 *
 * Step by step because only the active step's panel is visible, and Playwright fills only what
 * is visible - so filling ahead would wait out the test on a hidden control. Each control is a
 * Web Awesome component, so the fillable element is the `<input>` inside its shadow root
 * rather than the host, which is not an input and refuses `fill`; addressed through the
 * `data-field` attributes the views define, the same handle the browser tests use.
 */
export async function recordDevice(
  page: import('@playwright/test').Page,
  name: string,
  room: string,
): Promise<void> {
  await page.goto('/#/devices/new')
  const next = page.locator('form [data-next]')

  // Scan it
  await page.locator('[data-field="credential"] input').fill(PAYLOAD)
  await page.locator('[data-field="installed-at"] input').fill('2026-09-02')
  await next.click()
  // Place it. The combobox has two inputs - the one that is typed into and the one holding the
  // chosen value. The first is the visible one.
  await page.locator('[data-field="room"] input').first().fill(room)
  await next.click()
  // Name it
  await page.locator('[data-field="name"] input').fill(name)
  await next.click()
  // Review. Saving navigates to the list, and only a stored device does: waiting for it keeps
  // a caller's check off Review, which shows the same name, and a reload from landing mid-save.
  await page.locator('form [data-save]').click()
  await page.waitForURL(/#\/devices$/)
}
