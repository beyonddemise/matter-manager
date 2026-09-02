import { expect, test } from '@playwright/test'

/**
 * The journey the application exists for: a code that cannot be scanned is typed, filed, and
 * found again.
 *
 * Through the built site, because what this is for is the part unit tests cannot reach — the
 * bundle that actually ships, a real IndexedDB, and the reload that proves the device is kept
 * rather than merely displayed.
 */

/** The verified reference device; see `packages/core/test/matter/payload.test.ts`. */
const PAYLOAD = 'MT:Y.K9042C00KA0648G00'

/*
 * No storage clean-up between tests, deliberately. Playwright gives each test its own browser
 * context, and a context has its own IndexedDB — so every journey starts on a browser holding
 * nothing without being told to.
 *
 * The first version deleted the databases in `beforeEach`, which was worse than unnecessary:
 * the page already held open handles, so `deleteDatabase` blocked, resolved anyway, and then
 * completed *after* the test had written its device. Two of three journeys failed for a
 * clean-up that was doing nothing except racing them.
 */

/**
 * Fills the add form and saves.
 *
 * Each control is a Web Awesome component, so the fillable element is the `<input>` inside its
 * shadow root rather than the host — Playwright pierces shadow DOM, and the host itself is not
 * an input and refuses `fill`. Addressed through the `data-field` attributes the views define,
 * which is the same handle the browser tests use.
 */
async function recordDevice(
  page: import('@playwright/test').Page,
  name: string,
  room: string,
): Promise<void> {
  await page.goto('/#/devices/new')
  await page.locator('[data-field="credential"] input').fill(PAYLOAD)
  await page.locator('[data-field="name"] input').fill(name)
  // The combobox has two inputs - the one that is typed into and the one holding the chosen
  // value. The first is the visible one.
  await page.locator('[data-field="room"] input').first().fill(room)
  await page.locator('[data-field="installed-at"] input').fill('2026-09-02')
  await page.locator('form wa-button[type="submit"]').click()
}

test('a device that is recorded can be found again', async ({ page }) => {
  await recordDevice(page, 'Kitchen ceiling light', 'Ground Floor/Kitchen')

  await expect(page.getByText('Kitchen ceiling light')).toBeVisible()
})

test('it is still there after a reload, which is the whole promise', async ({ page }) => {
  // The one thing every unit test in this repository takes on trust: that what was written
  // reaches storage the browser keeps. A device held only in memory would pass every test in
  // `packages/web` and fail here.
  await recordDevice(page, 'Hall sensor', 'Ground Floor/Hall')
  // Waited for before reloading. Saving navigates to the list, and reloading during the write
  // would test whether the reload beat the write rather than whether the device was kept.
  await expect(page.getByText('Hall sensor')).toBeVisible()

  await page.reload()

  await expect(page.getByText('Hall sensor')).toBeVisible()
})

test('the room typed on the form becomes a room', async ({ page }) => {
  await recordDevice(page, 'Porch light', 'Porch')
  await expect(page.getByText('Porch light')).toBeVisible()

  await page.goto('/#/rooms')

  await expect(page.locator('[data-room-path]', { hasText: 'Porch' })).toBeVisible()
})
