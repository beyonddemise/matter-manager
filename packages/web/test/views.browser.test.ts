import { fixture, html } from '@open-wc/testing-helpers'
import { expect, it } from 'vitest'
import '../src/views/not-found.js'

// The device list has its own file, `views/device-list.browser.test.ts`, since M2-6 gave it
// search, filtering and grouping to answer for.

it('offers a way back from the not-found view', async () => {
  const element = await fixture(html`<not-found-view></not-found-view>`)
  const link = element.querySelector('a')

  // The issue requires a way back, not merely an apology.
  expect(link).not.toBeNull()
  expect(link?.getAttribute('href')).toBe('#/')
})

it('uses a real heading element rather than styled text', async () => {
  const element = await fixture(html`<not-found-view></not-found-view>`)
  expect(element.querySelector('h1')).not.toBeNull()
})
