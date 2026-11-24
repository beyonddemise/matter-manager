import { expect, PAYLOAD, test } from './fixtures'

/**
 * The browser's Back and Forward on the add form (#356), through the built site: each step is a
 * history entry, so Back walks the steps with everything entered kept, and Back out of the form
 * with something entered asks first.
 *
 * In the journeys as well as the browser tests because what matters is the real browser's
 * history in the shipped bundle: the router, the shell and the form together, which no unit
 * test renders at once.
 */

test('Back walks the steps one at a time, and Forward walks them again', async ({ page }) => {
  await page.goto('/#/devices')
  await page.locator('[data-add-device]').click()
  await expect(page).toHaveURL(/#\/devices\/new$/)
  const next = page.locator('form [data-next]')

  await page.locator('[data-field="credential"] input').fill(PAYLOAD)
  await next.click()
  await expect(page).toHaveURL(/\?step=place$/)
  await page.locator('[data-field="room"] input').first().fill('Ground Floor/Kitchen')
  await next.click()
  await expect(page).toHaveURL(/\?step=name$/)

  await page.goBack()
  await expect(page).toHaveURL(/\?step=place$/)
  await expect(page.locator('[data-field="room"] input').first()).toHaveValue(
    'Ground Floor/Kitchen',
  )

  await page.goBack()
  await expect(page).toHaveURL(/#\/devices\/new$/)
  await expect(page.locator('[data-field="credential"] input')).toHaveValue(PAYLOAD)

  await page.goForward()
  await expect(page).toHaveURL(/\?step=place$/)
  await expect(page.locator('[data-step-panel="place"]')).toBeVisible()
})

test('Back out of the form with something entered asks, and Stay keeps it', async ({ page }) => {
  await page.goto('/#/devices')
  await page.locator('[data-add-device]').click()
  await page.locator('[data-field="credential"] input').fill(PAYLOAD)

  await page.goBack()
  const dialog = page.locator('[data-leave-dialog]')
  await expect(dialog.getByText('Leave without saving?')).toBeVisible()
  await expect(page.locator('[data-leave-stay]')).toBeFocused()
  await page.locator('[data-leave-stay]').click()

  await expect(page).toHaveURL(/#\/devices\/new$/)
  await expect(page.locator('[data-field="credential"] input')).toHaveValue(PAYLOAD)

  // Cancel asks too, and Discard goes to the list.
  await page.locator('form wa-button[href="#/devices"]').click()
  await page.locator('[data-leave-discard]').click()
  await expect(page).toHaveURL(/#\/devices$/)
  await expect(page.locator('device-list-view')).toBeVisible()
})

test('a reload on a later step starts again on step 1', async ({ page }) => {
  await page.goto('/#/devices')
  await page.locator('[data-add-device]').click()
  await page.locator('form [data-next]').click()
  await expect(page).toHaveURL(/\?step=place$/)

  await page.reload()

  await expect(page).toHaveURL(/#\/devices\/new$/)
  await expect(page.locator('[data-step-panel="scan"]')).toBeVisible()
  // And Back leaves for the list, not into an empty step of the form before the reload.
  await page.goBack()
  await expect(page).toHaveURL(/#\/devices$/)
})

test('Back after saving goes to where the form was opened from, not into it', async ({ page }) => {
  await page.goto('/#/devices')
  await page.locator('[data-add-device]').click()
  const next = page.locator('form [data-next]')
  await page.locator('[data-field="credential"] input').fill(PAYLOAD)
  await next.click()
  await page.locator('[data-field="room"] input').first().fill('Hall')
  await next.click()
  await page.locator('[data-field="name"] input').fill('Hall light')
  await next.click()
  await page.locator('form [data-save]').click()
  // The list, not Review, which shows the same name: saving has left the form only once the
  // address is the list's.
  await expect(page).toHaveURL(/#\/devices$/)
  await expect(page.locator('device-list-view').getByText('Hall light')).toBeVisible()

  await page.goBack()

  await expect(page).toHaveURL(/#\/devices$/)
  await expect(page.locator('add-device-view')).toHaveCount(0)
})
