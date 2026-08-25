import '@awesome.me/webawesome-pro/dist/components/page/page.js'
import '@awesome.me/webawesome-pro/dist/components/button/button.js'
import '@awesome.me/webawesome-pro/dist/components/icon/icon.js'
import { fixture, html } from '@open-wc/testing-helpers'
import { afterEach, beforeEach, expect, it } from 'vitest'
import '../src/app-shell.js'
import { NAV_ROUTES } from '../src/router/routes.js'
import { applyScheme, SCHEME_STORAGE_KEY } from '../src/scheme.js'

/** A minimal shape for the reactive-update contract both `app-shell` and `wa-page` share. */
interface Updatable {
  updateComplete?: Promise<unknown>
}

/**
 * Builds the shell and waits past two upgrade boundaries, not one.
 *
 * `fixture()` only awaits `<app-shell>`'s own `updateComplete` - it has no way to know that
 * `<wa-page>` is a second, independently-scheduled Lit element nested inside. Without also
 * awaiting `<wa-page>`'s `updateComplete`, a test can run before `wa-page` has rendered its
 * shadow DOM at all, which would make slot-assignment assertions false negatives rather than
 * true failures. Awaiting `whenDefined` first closes the other gap: without it, the very same
 * assertions would trivially pass against undefined elements that never upgraded, which is the
 * failure this whole fixture change exists to prevent (see the shell's task-6 report).
 */
const shell = async () => {
  await Promise.all([
    customElements.whenDefined('wa-page'),
    customElements.whenDefined('wa-button'),
    customElements.whenDefined('wa-icon'),
  ])
  const element = await fixture(html`<app-shell></app-shell>`)
  const page = element.querySelector('wa-page') as (HTMLElement & Updatable) | null
  await page?.updateComplete
  return element
}

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

it('marks navigation links with data-drawer="close" so wa-page\'s mobile drawer closes on tap', async () => {
  // This asserts the marker wa-page's internal <wa-drawer> looks for, not the resulting
  // close - driving the drawer itself needs a real 'mobile' view and drawer open/close
  // animations, which is what wa-page's own component tests are for.
  const element = await shell()
  expect(element.querySelector('nav a')?.getAttribute('data-drawer')).toBe('close')
})

it('changes view when the hash changes, without remounting', async () => {
  const element = await shell()
  const pageBeforeNavigation = element.querySelector('wa-page')

  window.location.hash = '#/nope'
  await new Promise((resolve) => setTimeout(resolve, 0))
  await (element as unknown as { updateComplete: Promise<unknown> }).updateComplete

  expect(element.querySelector('not-found-view')).not.toBeNull()
  expect(element.querySelector('device-list-view')).toBeNull()
  // Proves "without remounting": the same wa-page element instance survived the
  // hash-driven re-render rather than being torn down and recreated.
  expect(element.querySelector('wa-page')).toBe(pageBeforeNavigation)
})

it('gives the scheme toggle an accessible name', async () => {
  // label="…" is inert on the <wa-button> host (it renders no accessible-name mechanism
  // from it); the icon is the button's only content, so the label belongs on the
  // <wa-icon>, matching the hamburger four lines above it in app-shell.ts.
  const element = await shell()
  const icon = element.querySelector('wa-icon[name="circle-half-stroke"]')
  expect(icon?.getAttribute('label')).toBe('Switch between light and dark')
})

it('toggles the scheme when its toggle button is tapped, and persists the choice', async () => {
  const root = document.documentElement
  const originalClassName = root.className
  const originalStored = localStorage.getItem(SCHEME_STORAGE_KEY)

  try {
    // Start from a known, deterministic state rather than whatever the system prefers.
    localStorage.setItem(SCHEME_STORAGE_KEY, 'light')
    applyScheme(root, 'light')

    const element = await shell()
    const toggle = element.querySelector('wa-icon[name="circle-half-stroke"]')?.closest('wa-button')
    expect(toggle).not.toBeNull()

    ;(toggle as HTMLElement).click()
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(root.classList.contains('wa-dark')).toBe(true)
    expect(root.classList.contains('wa-light')).toBe(false)
    expect(localStorage.getItem(SCHEME_STORAGE_KEY)).toBe('dark')

    ;(toggle as HTMLElement).click()
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(root.classList.contains('wa-light')).toBe(true)
    expect(root.classList.contains('wa-dark')).toBe(false)
    expect(localStorage.getItem(SCHEME_STORAGE_KEY)).toBe('light')
  } finally {
    // Independent tests: leave both the document class and storage as found.
    root.className = originalClassName
    if (originalStored === null) {
      localStorage.removeItem(SCHEME_STORAGE_KEY)
    } else {
      localStorage.setItem(SCHEME_STORAGE_KEY, originalStored)
    }
  }
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

it('upgrades wa-page, wa-button and wa-icon to their real custom element classes', async () => {
  // A component that never upgraded stays a plain HTMLElement: every attribute and slot
  // assertion elsewhere in this file would still pass against it, silently proving nothing.
  // This is the tripwire - if a future refactor drops the component imports above, this is
  // the test that fails loudly instead of the whole file reverting to structural-only.
  const element = await shell()
  const page = element.querySelector('wa-page')
  const button = element.querySelector('wa-button')
  const icon = element.querySelector('wa-icon')

  expect(page?.constructor.name).not.toBe('HTMLElement')
  expect(button?.constructor.name).not.toBe('HTMLElement')
  expect(icon?.constructor.name).not.toBe('HTMLElement')
})

it("projects the navigation into wa-page's own navigation slot, and only once", async () => {
  // Proves the navigation is genuinely received by wa-page's shadow DOM, not merely present
  // somewhere in app-shell's light DOM. wa-page renders its real `slot[name="navigation"]`
  // conditionally on `view` ('desktop' by default, until a ResizeObserver says otherwise),
  // so this also depends on the shell() fixture awaiting wa-page's updateComplete first.
  const element = await shell()
  const page = element.querySelector('wa-page')
  const nav = element.querySelector('nav[slot="navigation"]')
  const slot = page?.shadowRoot?.querySelector('slot[name="navigation"]') as HTMLSlotElement | null

  expect(slot).not.toBeNull()
  const assigned = slot?.assignedElements() ?? []
  expect(assigned).toHaveLength(1)
  expect(assigned[0]).toBe(nav)
})
