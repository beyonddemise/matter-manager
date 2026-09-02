import { expect, test } from '@playwright/test'

/**
 * Offline behaviour, which is what ADR 0002 makes this application for.
 *
 * Every unit test in `packages/web` runs against a database that is simply there. What none of
 * them can show is that the *shipped* application opens, records and keeps a device with the
 * network switched off — which is the promise, and which depends on the service worker, the
 * bundle and real storage all being right at once.
 */

const PAYLOAD = 'MT:Y.K9042C00KA0648G00'

async function recordDevice(
  page: import('@playwright/test').Page,
  name: string,
  room: string,
): Promise<void> {
  await page.goto('/#/devices/new')
  await page.locator('[data-field="credential"] input').fill(PAYLOAD)
  await page.locator('[data-field="name"] input').fill(name)
  await page.locator('[data-field="room"] input').first().fill(room)
  await page.locator('[data-field="installed-at"] input').fill('2026-09-02')
  await page.locator('form wa-button[type="submit"]').click()
}

test('a device can be recorded with no connectivity at all', async ({ page, context }) => {
  // The scenario the product exists for: somebody in a basement, in front of a device, with a
  // label they cannot scan and no signal.
  await page.goto('/')
  await context.setOffline(true)

  await recordDevice(page, 'Cellar meter', 'Cellar')

  await expect(page.getByText('Cellar meter')).toBeVisible()
})

test('it is still there when connectivity comes back', async ({ page, context }) => {
  await page.goto('/')
  await context.setOffline(true)
  await recordDevice(page, 'Cellar meter', 'Cellar')
  await expect(page.getByText('Cellar meter')).toBeVisible()

  await context.setOffline(false)
  await page.reload()

  // Nothing was waiting on a network round trip to be real. A device that appeared while
  // offline and vanished on reconnection would be the worst outcome this application has.
  await expect(page.getByText('Cellar meter')).toBeVisible()
})

test('says it is offline, quietly', async ({ page, context }) => {
  // Unobtrusive on purpose: nothing here is blocked by being offline, so this explains a delay
  // in sharing rather than a loss of function. A banner would overstate it.
  await page.goto('/')
  await context.setOffline(true)
  await page.evaluate(() => window.dispatchEvent(new Event('offline')))

  await expect(page.locator('[data-offline]')).toBeVisible()
})

test('stops saying so once the network is back', async ({ page, context }) => {
  await page.goto('/')
  await context.setOffline(true)
  await page.evaluate(() => window.dispatchEvent(new Event('offline')))
  await expect(page.locator('[data-offline]')).toBeVisible()

  await context.setOffline(false)
  await page.evaluate(() => window.dispatchEvent(new Event('online')))

  await expect(page.locator('[data-offline]')).toHaveCount(0)
})

test('opens from the service worker with the network gone', async ({ page, context }) => {
  // The strongest claim the suite makes, and the only place it can be made: the application
  // opens with no connectivity at all. That depends on the worker having precached the shell
  // on the first visit, which no unit test can observe.
  await page.goto('/')
  // Waiting for the worker to be *controlling*, not merely registered. A registration that has
  // not taken control yet serves nothing, so reloading at that moment would test the network.
  await page.waitForFunction(() => navigator.serviceWorker.controller !== null)

  await context.setOffline(true)
  const reloaded = await page.reload()

  // Served by the worker, with no network to serve it. A 200 here with `context.setOffline`
  // in force is the entire claim.
  expect(reloaded?.status()).toBe(200)
  await expect(page.locator('app-shell')).toBeVisible()
})
