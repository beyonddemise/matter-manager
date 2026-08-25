import { fixture, html } from '@open-wc/testing-helpers'
import { expect, it } from 'vitest'
import '../src/views/device-list.js'
import '../src/views/not-found.js'

it('shows a heading and an empty state on the device list', async () => {
  const element = await fixture(html`<device-list-view></device-list-view>`)
  const heading = element.querySelector('h1')

  expect(heading?.textContent?.trim()).not.toBe('')
  expect(element.textContent).toContain('No devices')
})

it('renders into the light DOM so global utility classes apply', async () => {
  // wa-stack and friends are document-level CSS. A shadow root would leave them inert
  // while --wa-* tokens kept working, which is the half-right failure this pins.
  const element = await fixture(html`<device-list-view></device-list-view>`)
  expect(element.shadowRoot).toBeNull()
  expect(element.querySelector('.wa-stack')).not.toBeNull()
})

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
