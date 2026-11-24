import { expect, PAYLOAD, test } from './fixtures'

/**
 * Saving a device as a draft and finishing it later (#358), through the built site: the label is
 * read but the room is not decided, the person leaves with Back and keeps a draft, and later
 * finishes it from the list.
 *
 * A journey because it crosses the leave question, the stored draft, the list's marker and the
 * finish route, which no browser test renders together.
 */
test('save a draft, leave, reopen it from the list, and finish it', async ({ page }) => {
  await page.goto('/#/devices')
  await page.locator('[data-add-device]').click()
  await expect(page).toHaveURL(/#\/devices\/new$/)

  // Step 1 only: the code is readable, nothing else is decided yet.
  await page.locator('[data-field="credential"] input').fill(PAYLOAD)
  await page.goBack()
  await expect(page.locator('[data-leave-dialog]').getByText('Leave without saving?')).toBeVisible()
  await page.locator('[data-leave-draft]').click()

  // Back went to the list, and the draft is in it, marked in words.
  await expect(page).toHaveURL(/#\/devices$/)
  const row = page.locator('device-list-view [data-device-id]').filter({ hasText: 'Draft' })
  await expect(row).toHaveCount(1)
  await expect(row.locator('a.app-device-row')).toContainText('Untitled draft')

  // Finish reopens the form on it, prefilled, on the first step left to do: Place.
  await row.locator('[data-finish]').click()
  await expect(page).toHaveURL(/#\/devices\/[^/]+\/finish\?step=place$/)
  await expect(page.locator('h1').getByText('Finish a draft')).toBeVisible()
  await page.locator('[data-field="room"] input').first().fill('Hall')
  await page.locator('form [data-next]').click()
  await page.locator('[data-field="name"] input').fill('Hall light')
  await page.locator('form [data-next]').click()
  await expect(page).toHaveURL(/\?step=review$/)
  // Back walks into Scan it, which still holds the code the draft kept.
  await page.goBack()
  await page.goBack()
  await page.goBack()
  await expect(page).toHaveURL(/\/finish$/)
  await expect(page.locator('[data-field="credential"] input')).toHaveValue(PAYLOAD)
  await page.goForward()
  await page.goForward()
  await page.goForward()
  await expect(page).toHaveURL(/\?step=review$/)
  await page.locator('form [data-save]').click()

  // One device, finished: no marker, the same row.
  await expect(page).toHaveURL(/#\/devices$/)
  const rows = page.locator('device-list-view [data-device-id]')
  await expect(rows).toHaveCount(1)
  await expect(rows.getByText('Hall light')).toBeVisible()
  await expect(page.locator('device-list-view [data-draft-marker]')).toHaveCount(0)
})
