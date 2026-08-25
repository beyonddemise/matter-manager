import { fixture, html } from '@open-wc/testing-helpers'
import { afterEach, beforeEach, expect, it } from 'vitest'
import '../src/app-shell.js'
import { NAV_ROUTES } from '../src/router/routes.js'

const shell = async () => await fixture(html`<app-shell></app-shell>`)

beforeEach(() => {
  window.location.hash = '#/'
})

afterEach(() => {
  window.location.hash = ''
})

it('renders the device list at the root path', async () => {
  const element = await shell()
  expect(element.querySelector('device-list-view')).not.toBeNull()
})

it('renders the not-found view for an unknown path', async () => {
  window.location.hash = '#/nope'
  const element = await shell()
  expect(element.querySelector('not-found-view')).not.toBeNull()
})

it('renders one navigation link per labelled route, and no more', async () => {
  // Guards the duplicated-navigation trap: slot="navigation" already renders in both
  // views, so a second copy would double these.
  const element = await shell()
  expect(element.querySelectorAll('nav a').length).toBe(NAV_ROUTES.length)
})

it('marks the current navigation entry', async () => {
  const element = await shell()
  const current = element.querySelector('nav a[aria-current="page"]')
  expect(current?.getAttribute('href')).toBe('#/')
})

it('closes the mobile drawer when a navigation link is tapped', async () => {
  const element = await shell()
  expect(element.querySelector('nav a')?.getAttribute('data-drawer')).toBe('close')
})

it('changes view when the hash changes, without remounting', async () => {
  const element = await shell()
  window.location.hash = '#/nope'
  await new Promise((resolve) => setTimeout(resolve, 0))
  await (element as unknown as { updateComplete: Promise<unknown> }).updateComplete

  expect(element.querySelector('not-found-view')).not.toBeNull()
  expect(element.querySelector('device-list-view')).toBeNull()
})

it('exposes exactly one navigation region', async () => {
  const element = await shell()
  expect(element.querySelectorAll('[slot="navigation"]').length).toBe(1)
})

it('renders into the light DOM so wa-page and the utilities work', async () => {
  const element = await shell()
  expect(element.shadowRoot).toBeNull()
  expect(element.querySelector('wa-page')).not.toBeNull()
})
