import '@awesome.me/webawesome-pro/dist/components/page/page.js'
import '@awesome.me/webawesome-pro/dist/components/button/button.js'
import '@awesome.me/webawesome-pro/dist/components/callout/callout.js'
import '@awesome.me/webawesome-pro/dist/components/checkbox/checkbox.js'
import '@awesome.me/webawesome-pro/dist/components/dialog/dialog.js'
import '@awesome.me/webawesome-pro/dist/components/icon/icon.js'
import '@awesome.me/webawesome-pro/dist/components/tag/tag.js'
import { fixture, html, waitUntil } from '@open-wc/testing-helpers'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { TokenOutcome } from '../../src/ui/composition.js'
import '../../src/ui/app-shell.js'
import { BACKFILL_WANTED } from '../../src/ui/catalog.js'
import type { CatalogBackfill } from '../../src/ui/catalog-backfill.js'
import type { ConnectivitySource } from '../../src/ui/connectivity.js'
import { PROJECT_CHANGED } from '../../src/ui/current-project.js'
// The application's CSS: the sticky footer and its scroll padding are asserted below.
import '../../src/ui/styles/app.css'
import { NAV_ROUTES } from '../../src/ui/router/routes.js'
import { applyScheme, SCHEME_STORAGE_KEY } from '../../src/ui/scheme.js'
import { accessToken, rememberAccessToken } from '../../src/ui/tokens.js'
import { destroyProjectStores, isolatedProjectStore } from './support/project-store.js'

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
  const element = await fixture(
    html`<app-shell .projectStore=${isolatedProjectStore()}></app-shell>`,
  )
  const page = element.querySelector('wa-page') as (HTMLElement & Updatable) | null
  await page?.updateComplete
  return element
}

beforeEach(() => {
  window.location.hash = '#/'
})

afterEach(async () => {
  window.location.hash = ''
  await destroyProjectStores()
})

it('renders the projects page at the root path', async () => {
  const element = await shell()
  expect(element.querySelector('projects-view')).not.toBeNull()
})

it('renders the device list at #/devices', async () => {
  window.location.hash = '#/devices'
  const element = await shell()
  expect(element.querySelector('device-list-view')).not.toBeNull()
})

it('renders the not-found view for an unknown path', async () => {
  window.location.hash = '#/nope'
  const element = await shell()
  expect(element.querySelector('not-found-view')).not.toBeNull()
})

it('brands the header with the application icon, named once for assistive technology', async () => {
  // The mark carries the name; the written name beside it is for sighted users on wider
  // screens only, and hidden from assistive technology so it is not announced twice.
  const element = await shell()
  const mark = element.querySelector('header img.app-brand-mark') as HTMLImageElement | null
  const name = element.querySelector('header strong')

  expect(mark?.alt).toBe('Matter Manager')
  expect(mark?.getAttribute('src')).toMatch(/icon.*\.svg/)
  await waitUntil(() => mark?.complete === true && mark.naturalWidth > 0, 'the mark never loaded')
  expect(name?.getAttribute('aria-hidden')).toBe('true')
  expect(name?.classList.contains('wa-desktop-only')).toBe(true)
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
  expect(element.querySelector('projects-view')).toBeNull()
  // Proves "without remounting": the same wa-page element instance survived the
  // hash-driven re-render rather than being torn down and recreated.
  expect(element.querySelector('wa-page')).toBe(pageBeforeNavigation)
})

it('gives the scheme toggle an accessible name describing the next state', async () => {
  // label="…" is inert on the <wa-button> host (it renders no accessible-name mechanism
  // from it); the icon is the button's only content, so the label belongs on the
  // <wa-icon>, matching the hamburger four lines above it in app-shell.ts.
  const originalStored = localStorage.getItem(SCHEME_STORAGE_KEY)
  try {
    localStorage.setItem(SCHEME_STORAGE_KEY, 'light')
    const element = await shell()
    const icon = element.querySelector('wa-icon[name="sun"]')
    // Currently showing "light" (sun); the next activation moves to "dark".
    expect(icon?.getAttribute('label')).toBe('Switch to dark scheme')
  } finally {
    if (originalStored === null) {
      localStorage.removeItem(SCHEME_STORAGE_KEY)
    } else {
      localStorage.setItem(SCHEME_STORAGE_KEY, originalStored)
    }
  }
})

it('cycles light → dark → system → light, applying and persisting each step', async () => {
  // The design specifies three reachable states, not two: a user must be able to return to
  // "follow the system" through the header control, not just start there by default.
  const root = document.documentElement
  const originalClassName = root.className
  const originalStored = localStorage.getItem(SCHEME_STORAGE_KEY)
  const prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches

  try {
    // Start from a known, deterministic state rather than whatever the system prefers.
    localStorage.setItem(SCHEME_STORAGE_KEY, 'light')
    applyScheme(root, 'light')

    const element = await shell()
    const click = async () => {
      ;(element.querySelector('[data-scheme-toggle]') as HTMLElement).click()
      await new Promise((resolve) => setTimeout(resolve, 0))
    }

    // light -> dark
    await click()
    expect(element.querySelector('wa-icon[name="moon"]')).not.toBeNull()
    expect(root.classList.contains('wa-dark')).toBe(true)
    expect(root.classList.contains('wa-light')).toBe(false)
    expect(localStorage.getItem(SCHEME_STORAGE_KEY)).toBe('dark')

    // dark -> system
    await click()
    expect(element.querySelector('wa-icon[name="circle-half-stroke"]')).not.toBeNull()
    expect(localStorage.getItem(SCHEME_STORAGE_KEY)).toBe('system')
    expect(root.classList.contains('wa-dark')).toBe(prefersDark)
    expect(root.classList.contains('wa-light')).toBe(!prefersDark)

    // system -> light
    await click()
    expect(element.querySelector('wa-icon[name="sun"]')).not.toBeNull()
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

/** A network a test can take away. */
function fakeNetwork(onLine = true) {
  const listeners = new Map<string, Set<() => void>>()
  return {
    onLine,
    addEventListener(type: string, listener: () => void) {
      const set = listeners.get(type) ?? new Set()
      set.add(listener)
      listeners.set(type, set)
    },
    removeEventListener(type: string, listener: () => void) {
      listeners.get(type)?.delete(listener)
    },
    go(online: boolean) {
      this.onLine = online
      for (const listener of listeners.get(online ? 'online' : 'offline') ?? []) listener()
    },
  }
}

/** The shell, with a network it does not own. */
async function shellWith(network: ReturnType<typeof fakeNetwork>) {
  await Promise.all([
    customElements.whenDefined('wa-page'),
    customElements.whenDefined('wa-tag'),
    customElements.whenDefined('wa-callout'),
  ])
  const element = await fixture(
    html`<app-shell .connectivity=${network} .projectStore=${isolatedProjectStore()}></app-shell>`,
  )
  const page = element.querySelector('wa-page') as (HTMLElement & Updatable) | null
  await page?.updateComplete
  return element
}

it('says it is online, quietly, and not that it is offline', async () => {
  // Always present since the projects page, whose server actions depend on it; `data-offline`
  // stays reserved for being offline, which the offline journey counts on.
  const element = await shellWith(fakeNetwork(true))
  expect(element.querySelector('[data-online]')).not.toBeNull()
  expect(element.querySelector('[data-offline]')).toBeNull()
})

it('shows an unobtrusive indicator when the network goes', async () => {
  const network = fakeNetwork(true)
  const element = await shellWith(network)

  network.go(false)
  await (element as HTMLElement & Updatable).updateComplete

  expect(element.querySelector('footer [data-offline]')?.getAttribute('variant')).toBe('neutral')
  expect(element.querySelector('[data-online]')).toBeNull()
})

it('shows the indicator on a page that was loaded offline in the first place', async () => {
  // No event fires in that case. An indicator that appeared only on a transition would be
  // missing exactly when it is most true.
  const element = await shellWith(fakeNetwork(false))
  expect(element.querySelector('[data-offline]')).not.toBeNull()
})

it('blocks nothing while offline', async () => {
  // "No action is blocked except those genuinely requiring a server", and at M2b none do:
  // every write goes to a local database first. So the device list is still there, and so is
  // the way to add one.
  window.location.hash = '#/devices'
  const element = await shellWith(fakeNetwork(false))

  expect(element.querySelector('device-list-view')).not.toBeNull()
  expect(element.querySelector('[data-offline]')?.hasAttribute('disabled')).toBeFalsy()
})

it('takes the indicator away when the network comes back', async () => {
  const network = fakeNetwork(false)
  const element = await shellWith(network)

  network.go(true)
  await (element as HTMLElement & Updatable).updateComplete

  expect(element.querySelector('[data-offline]')).toBeNull()
})

it('says nothing about updates until there is one', async () => {
  const element = await shellWith(fakeNetwork(true))
  expect(element.querySelector('[data-update-available]')).toBeNull()
})

it('offers a waiting update rather than applying it', async () => {
  // Offered, never taken by itself. Reloading out from under someone mid-form is how an
  // update stops being something they did and becomes something that happened to them.
  const element = (await shellWith(fakeNetwork(true))) as HTMLElement &
    Updatable & { updateReady?: unknown; takeUpdate?: unknown }
  let reloaded = false

  element.takeUpdate = () => {
    reloaded = true
  }
  element.updateReady = { postMessage: () => {} }
  await element.updateComplete

  expect(element.querySelector('[data-update-available]')).not.toBeNull()
  expect(element.querySelector('[data-take-update]')).not.toBeNull()
  expect(reloaded).toBe(false)
})

it('hands the waiting worker over when the user accepts', async () => {
  // Through the seam, not through the real `applyUpdate`. That one schedules a reload of the
  // page it runs in, so calling it here would reload the test browser three seconds later,
  // out of the middle of whatever was running by then. What it does with the worker is
  // `updates.test.ts`'s business; what this asserts is that the button reaches it.
  const element = (await shellWith(fakeNetwork(true))) as HTMLElement &
    Updatable & { updateReady?: unknown; takeUpdate?: unknown }
  const taken: unknown[] = []
  const waiting = { postMessage: () => {} }

  element.takeUpdate = (worker: unknown) => taken.push(worker)
  element.updateReady = waiting
  await element.updateComplete
  ;(element.querySelector('[data-take-update]') as HTMLElement).click()

  expect(taken).toEqual([waiting])
})

it('links the public website, privacy notice and terms from a footer on every view', async () => {
  // Google's OAuth review follows the app to its purpose and its privacy policy. The footer is
  // in wa-page's `footer` slot rather than the navigation, because on a phone the navigation
  // is a closed drawer and a reviewer - or anybody else - would never see it.
  const element = await shell()
  const footer = element.querySelector('footer[slot="footer"]')
  expect(footer, 'the shell has no footer').not.toBeNull()

  const hrefs = [...(footer?.querySelectorAll('a') ?? [])].map((a) => a.getAttribute('href'))
  expect(hrefs).toEqual([
    'https://www.matter-manager.io/',
    'https://www.matter-manager.io/privacy',
    'https://www.matter-manager.io/tos',
  ])

  // Assigned to wa-page's real slot, not merely present in the light DOM.
  const page = element.querySelector('wa-page')
  const slot = page?.shadowRoot?.querySelector('slot[name="footer"]') as HTMLSlotElement | null
  expect(slot?.assignedElements()).toContain(footer)
})

it('links the website from the drawer at phone width, and from the footer on desktop', async () => {
  // The footer holds one row of status at phone width, so the links move to the drawer's footer,
  // which every view has. Each copy is hidden in the other view.
  const element = await shell()
  const drawer = element.querySelector('[slot="navigation-footer"]') as HTMLElement
  const hrefs = [...drawer.querySelectorAll('a')].map((a) => a.getAttribute('href'))
  expect(hrefs).toEqual([
    'https://www.matter-manager.io/',
    'https://www.matter-manager.io/privacy',
    'https://www.matter-manager.io/tos',
  ])
  expect(drawer.classList.contains('wa-mobile-only')).toBe(true)
  const desktop = element.querySelector('footer[slot="footer"] a')?.parentElement
  expect(desktop?.classList.contains('wa-desktop-only')).toBe(true)
})

it('keeps the footer in view, and what takes focus clear of it', async () => {
  // Sticky by our CSS, not by <wa-page>'s documented sticky sections: asserted, so a Web Awesome
  // release that changes the footer's box is caught here rather than by a user.
  const element = await shell()
  const page = element.querySelector('wa-page') as HTMLElement
  const part = page.shadowRoot?.querySelector('[part~="footer"]') as HTMLElement
  expect(getComputedStyle(part).position).toBe('sticky')

  // WCAG 2.4.11: the page's scroll padding is the footer's measured height.
  const root = document.documentElement
  // Waited for rather than read once: the footer keeps growing after the first measurement while
  // its status tags and fonts arrive, and the observer follows it. What matters is that the
  // padding settles on the footer's height, not what the first callback happened to see.
  const footer = element.querySelector('footer[slot="footer"]') as HTMLElement
  const padding = () => Number.parseFloat(getComputedStyle(root).scrollPaddingBlockEnd)
  await waitUntil(
    () => Math.abs(padding() - footer.getBoundingClientRect().height) < 0.5,
    'the scroll padding never matched the footer',
  )
  expect(footer.getBoundingClientRect().height).toBeGreaterThan(0)

  element.remove()
  expect(root.style.getPropertyValue('--app-footer-height')).toBe('')
})

/** The network as a test controls it: always there, and never changing. */
const NETWORK = { addEventListener: () => {}, removeEventListener: () => {}, onLine: true }

/** A network the test can take away and give back. */
function controllableNetwork() {
  const listeners = new Set<() => void>()
  const source = {
    onLine: true,
    addEventListener: (_type: 'online' | 'offline', listener: () => void) => {
      listeners.add(listener)
    },
    removeEventListener: (_type: 'online' | 'offline', listener: () => void) => {
      listeners.delete(listener)
    },
  }
  return {
    source,
    set(online: boolean) {
      source.onLine = online
      for (const listener of listeners) listener()
    },
  }
}

/** A backfill that only counts. */
function spyBackfill() {
  const backfill = { trigger: vi.fn(), stop: vi.fn(), idle: async () => {} }
  return backfill satisfies CatalogBackfill
}

/**
 * A shell whose refresher the test drives by hand.
 *
 * @returns the element, the `report` that plays an outcome into it, and the spies for what the
 *   shell did about it
 */
const driven = async (
  connectivity: ConnectivitySource = NETWORK,
  backfill = spyBackfill(),
  /** False leaves `backfill` unbound, so the shell would build the real one if anything asked. */
  injectBackfill = true,
) => {
  // Two downloaded copies, so the projects the tests report states for are ones replication is
  // handed: states of anything else are forgotten at the next refresh.
  const store = isolatedProjectStore()
  for (const projectId of ['p1', 'p2']) {
    await store.cache().addLocalProject({
      dbName: `project_${projectId}`,
      name: projectId,
      projectId,
      role: 'owner',
      createdAt: '2026-10-01T00:00:00.000Z',
    })
  }
  const report: { current?: (outcome: TokenOutcome) => void } = {}
  const stop = vi.fn()
  const stopAll = vi.fn()
  const makeSync = vi.fn(() => ({
    set: () => {},
    running: () => [],
    stateOf: () => undefined,
    stop: () => {},
    pushNow: async () => {},
    suspend: () => {},
    resume: () => {},
    stopAll,
  }))
  const signOutOf = vi.fn(async () => [])
  const element = (await fixture(html`
    <app-shell
      .refresher=${(onOutcome: (outcome: TokenOutcome) => void) => {
        report.current = onOutcome
        return { stop }
      }}
      .connectivity=${connectivity}
      .backfill=${injectBackfill ? backfill : undefined}
      .followLocale=${async () => undefined}
      .listProjects=${async () =>
        ['p1', 'p2'].map((projectId) => ({
          projectId,
          dbName: `project_${projectId}`,
          name: projectId,
          role: 'owner',
          archived: false,
        }))}
      .makeSync=${makeSync}
      .signOutOf=${signOutOf}
      .projectStore=${store}
    ></app-shell>
  `)) as HTMLElement & { updateComplete: Promise<unknown> }
  await element.updateComplete
  const play = async (outcome: TokenOutcome) => {
    report.current?.(outcome)
    await element.updateComplete
  }
  return { element, play, stop, stopAll, makeSync, signOutOf, backfill }
}

it('says the session has ended, offers sign-in, and removes no local data', async () => {
  const { element, play, signOutOf } = await driven()
  await play({ kind: 'ended' })
  await waitUntil(() => element.querySelector('[data-session-ended]') !== null, 'no notice')
  expect(element.querySelector('[data-session-ended]')?.textContent).toContain(
    'Your session has ended. Please sign in again.',
  )
  expect(element.querySelector('[data-sign-in]')).not.toBeNull()
  // Local data is the point: a session that lapsed offline must not cost unsynced work.
  expect(signOutOf).not.toHaveBeenCalled()
})

it('stops replicating once the session has ended', async () => {
  const { element, play, stopAll, makeSync } = await driven()
  await play({ kind: 'refreshed', expiresIn: 300 })
  await waitUntil(() => makeSync.mock.calls.length > 0, 'replication never started')
  await play({ kind: 'ended' })
  await element.updateComplete
  expect(stopAll).toHaveBeenCalled()
})

it('treats signed-out after signed-in as a sign-out of this tab, keeping local data', async () => {
  // Another tab signed out and removed the stored refresh token, so this tab's next exchange had
  // nothing to send and was answered 401. Leaving replication running here would keep pushing
  // with an access token nobody can renew, and keeping that token in memory would let this tab
  // go on presenting a session the user ended.
  const { element, play, stopAll, makeSync, signOutOf } = await driven()
  await play({ kind: 'refreshed', expiresIn: 300 })
  await waitUntil(() => makeSync.mock.calls.length > 0, 'replication never started')
  rememberAccessToken({ accessToken: 'a', expiresIn: 300 })

  await play({ kind: 'signed-out' })
  await element.updateComplete

  expect(stopAll).toHaveBeenCalled()
  expect(accessToken()).toBeUndefined()
  // Not the "session ended" notice: nothing was refused, the user signed out elsewhere.
  expect(element.querySelector('[data-session-ended]')).toBeNull()
  expect(element.querySelector('[data-sign-in]')).not.toBeNull()
  // Local data is not this tab's to remove; the sign-out that happened elsewhere decided that.
  expect(signOutOf).not.toHaveBeenCalled()
})

it('starts replication once however many times the token is refreshed', async () => {
  const { element, play, makeSync } = await driven()
  await play({ kind: 'refreshed', expiresIn: 300 })
  await waitUntil(() => makeSync.mock.calls.length > 0, 'replication never started')
  await play({ kind: 'refreshed', expiresIn: 300 })
  await play({ kind: 'refreshed', expiresIn: 300 })
  await new Promise((r) => setTimeout(r, 20))
  await element.updateComplete
  expect(makeSync).toHaveBeenCalledOnce()
})

it('dismisses the notice', async () => {
  const { element, play } = await driven()
  await play({ kind: 'ended' })
  await waitUntil(() => element.querySelector('[data-session-ended]') !== null, 'no notice')
  ;(element.querySelector('[data-session-ended] wa-button') as HTMLElement).click()
  await waitUntil(() => element.querySelector('[data-session-ended]') === null, 'still shown')
})

it('keeps showing the signed-in state while the network is unreachable', async () => {
  const { element, play } = await driven()
  await play({ kind: 'refreshed', expiresIn: 300 })
  await play({ kind: 'unreachable' })
  await waitUntil(() => element.querySelector('[data-sign-out]') !== null, 'signed out')
  expect(element.querySelector('[data-session-ended]')).toBeNull()
})

it('stops the refresher when the user signs out, before the sign-out runs', async () => {
  const { element, play, stop, signOutOf } = await driven()
  await play({ kind: 'refreshed', expiresIn: 300 })
  await waitUntil(() => element.querySelector('[data-sign-out]') !== null, 'not signed in')
  stop.mockImplementation(() => {
    // The order is the point: a refresh landing between sign-out and stop would re-store a token.
    expect(signOutOf).not.toHaveBeenCalled()
  })
  ;(element.querySelector('[data-sign-out]') as HTMLElement).click()
  await waitUntil(() => element.querySelector('[data-confirm-sign-out]') !== null, 'no dialog')
  ;(element.querySelector('[data-confirm-sign-out]') as HTMLElement).click()
  await waitUntil(() => signOutOf.mock.calls.length > 0, 'never signed out')
  expect(stop).toHaveBeenCalledOnce()
})

it('stops the refresher when the shell is removed', async () => {
  const { element, stop } = await driven()
  element.remove()
  expect(stop).toHaveBeenCalledOnce()
})

it('backfills once after sign-in, not on every token refresh', async () => {
  const { play, backfill } = await driven()
  await play({ kind: 'refreshed', expiresIn: 300 })
  await play({ kind: 'refreshed', expiresIn: 300 })
  expect(backfill.trigger).toHaveBeenCalledOnce()
})

it('backfills when the network comes back while signed in, and not while signed out', async () => {
  const network = controllableNetwork()
  const { play, backfill } = await driven(network.source)
  network.set(false)
  network.set(true)
  expect(backfill.trigger).not.toHaveBeenCalled()

  await play({ kind: 'refreshed', expiresIn: 300 })
  backfill.trigger.mockClear()
  network.set(false)
  network.set(true)
  expect(backfill.trigger).toHaveBeenCalledOnce()
})

it('restarts backfill on a project switch, stopping the old run first', async () => {
  const { play, backfill } = await driven()
  await play({ kind: 'refreshed', expiresIn: 300 })
  backfill.trigger.mockClear()

  window.dispatchEvent(new CustomEvent(PROJECT_CHANGED))

  expect(backfill.stop).toHaveBeenCalled()
  expect(backfill.trigger).toHaveBeenCalledOnce()
  expect(backfill.stop.mock.invocationCallOrder.at(-1)).toBeLessThan(
    backfill.trigger.mock.invocationCallOrder[0] ?? 0,
  )
})

it('stops the old run on a project switch while offline, and starts none', async () => {
  // The network is the one gate a switch can meet while signed in. The old run belongs to a
  // project nobody is in, so it stops; the reconnect trigger starts the next one.
  const network = controllableNetwork()
  const { play, backfill } = await driven(network.source)
  await play({ kind: 'refreshed', expiresIn: 300 })
  network.set(false)
  backfill.trigger.mockClear()
  backfill.stop.mockClear()

  window.dispatchEvent(new CustomEvent(PROJECT_CHANGED))

  expect(backfill.stop).toHaveBeenCalled()
  expect(backfill.trigger).not.toHaveBeenCalled()
})

it('does not backfill a project switched to while signed out', async () => {
  const { backfill } = await driven()
  window.dispatchEvent(new CustomEvent(PROJECT_CHANGED))
  expect(backfill.trigger).not.toHaveBeenCalled()
})

it('stops backfill when the session ends, is signed out elsewhere, or the shell goes', async () => {
  for (const outcome of [{ kind: 'ended' }, { kind: 'signed-out' }] as const) {
    const { element, play, backfill } = await driven()
    await play({ kind: 'refreshed', expiresIn: 300 })
    await play(outcome)
    expect(backfill.stop).toHaveBeenCalled()
    element.remove()
  }
  const { element, backfill } = await driven()
  element.remove()
  expect(backfill.stop).toHaveBeenCalled()
})

it('stops backfill before signing out', async () => {
  const { element, play, backfill, signOutOf } = await driven()
  await play({ kind: 'refreshed', expiresIn: 300 })
  await waitUntil(() => element.querySelector('[data-sign-out]') !== null, 'not signed in')
  ;(element.querySelector('[data-sign-out]') as HTMLElement).click()
  await waitUntil(() => element.querySelector('[data-confirm-sign-out]') !== null, 'no dialog')
  ;(element.querySelector('[data-confirm-sign-out]') as HTMLElement).click()
  await waitUntil(() => signOutOf.mock.calls.length > 0, 'never signed out')
  expect(backfill.stop.mock.invocationCallOrder[0]).toBeLessThan(
    signOutOf.mock.invocationCallOrder[0] ?? 0,
  )
})

it('refuses backfill triggers that arrive while the sign-out is still running', async () => {
  // #238: the session stays `signed-in` until `signOutOf` resolves, so a project switch or a
  // regained connection in that window would start a run for an account that is leaving.
  const network = controllableNetwork()
  const { element, play, backfill, signOutOf } = await driven(network.source)
  await play({ kind: 'refreshed', expiresIn: 300 })
  let finish: () => void = () => {}
  signOutOf.mockImplementation(
    () =>
      new Promise((resolve) => {
        finish = () => resolve([])
      }),
  )
  await waitUntil(() => element.querySelector('[data-sign-out]') !== null, 'not signed in')
  ;(element.querySelector('[data-sign-out]') as HTMLElement).click()
  await waitUntil(() => element.querySelector('[data-confirm-sign-out]') !== null, 'no dialog')
  ;(element.querySelector('[data-confirm-sign-out]') as HTMLElement).click()
  await waitUntil(() => signOutOf.mock.calls.length > 0, 'never signed out')
  backfill.trigger.mockClear()

  window.dispatchEvent(new CustomEvent(PROJECT_CHANGED))
  network.set(false)
  network.set(true)
  expect(backfill.trigger).not.toHaveBeenCalled()

  finish()
  await waitUntil(() => element.querySelector('[data-sign-in]') !== null, 'still signed in')
  expect(backfill.trigger).not.toHaveBeenCalled()
})

it('backfills when a view asks, only while signed in and online, without stopping a run', async () => {
  // #238: the add form asks after saving a device its lookup did not answer.
  const network = controllableNetwork()
  const { play, backfill } = await driven(network.source)
  window.dispatchEvent(new CustomEvent(BACKFILL_WANTED))
  expect(backfill.trigger).not.toHaveBeenCalled()

  await play({ kind: 'refreshed', expiresIn: 300 })
  backfill.trigger.mockClear()
  backfill.stop.mockClear()
  window.dispatchEvent(new CustomEvent(BACKFILL_WANTED))
  expect(backfill.trigger).toHaveBeenCalledOnce()
  // A run over the same project is still useful; `trigger` coalesces rather than restarting.
  expect(backfill.stop).not.toHaveBeenCalled()

  network.set(false)
  backfill.trigger.mockClear()
  window.dispatchEvent(new CustomEvent(BACKFILL_WANTED))
  expect(backfill.trigger).not.toHaveBeenCalled()
})

it('builds no real backfill just to stop it, when the session ends or is signed out', async () => {
  // #238: the stop sites go through `stopBackfill()`, which stops only a backfill that exists.
  // `realBackfill` is where the shell keeps the one it built; it must still be empty.
  for (const outcome of [{ kind: 'ended' }, { kind: 'signed-out' }] as const) {
    const { element, play } = await driven(NETWORK, spyBackfill(), false)
    await play(outcome)
    expect((element as unknown as { realBackfill?: unknown }).realBackfill).toBeUndefined()
    element.remove()
    expect((element as unknown as { realBackfill?: unknown }).realBackfill).toBeUndefined()
  }
})
