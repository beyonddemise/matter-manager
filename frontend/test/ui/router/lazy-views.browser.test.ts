/**
 * Route-level lazy loading (#214): every view arrives through its route's dynamic import, and a
 * chunk that fails to arrive is reported with a way to try again, not rendered as a blank page.
 *
 * What these tests can and cannot claim. In this browser runner a dynamic import resolves from
 * the dev server, so "navigating renders the view" would also pass against the old statically
 * imported shell. The claim that the views are *actually* in chunks of their own — separate,
 * outside the entry's static closure, and precached for offline — is a property of the built
 * output, and `scripts/check-lazy-views.mjs` is what asserts it. What only a test can pin is
 * the behaviour around the import: that `updateComplete` spans the load (so nothing downstream
 * races a half-arrived view), and that a failed chunk fetch — the one new failure mode the
 * split introduces — has a face and a retry.
 */
import { fixture, html } from '@open-wc/testing-helpers'
import { afterEach, beforeEach, expect, it } from 'vitest'
import '@awesome.me/webawesome-pro/dist/components/page/page.js'
import '@awesome.me/webawesome-pro/dist/components/button/button.js'
import '@awesome.me/webawesome-pro/dist/components/callout/callout.js'
import '@awesome.me/webawesome-pro/dist/components/icon/icon.js'
import '../../../src/ui/app-shell.js'
import type { Route } from '../../../src/ui/router/match.js'
import { ROUTES } from '../../../src/ui/router/routes.js'
import { destroyProjectStores, isolatedProjectStore } from '../support/project-store.js'

const shell = async (routes?: readonly Route[]) =>
  await fixture(
    html`<app-shell .projectStore=${isolatedProjectStore()} .routes=${routes}></app-shell>`,
  )

beforeEach(() => {
  window.location.hash = '#/'
})

afterEach(async () => {
  window.location.hash = ''
  await destroyProjectStores()
})

/**
 * One navigation per registered route. The id is any string: these assert the view *element*
 * arrives, and each view answers for an unknown id itself, in its own file.
 */
const NAVIGATIONS: readonly { path: string; element: string }[] = [
  { path: '#/', element: 'projects-view' },
  { path: '#/devices', element: 'device-list-view' },
  { path: '#/devices/new', element: 'add-device-view' },
  { path: '#/devices/6ba7b810-9dad-11d1-80b4-00c04fd430c8', element: 'device-view' },
  { path: '#/devices/6ba7b810-9dad-11d1-80b4-00c04fd430c8/edit', element: 'edit-device-view' },
  { path: '#/rooms', element: 'rooms-view' },
  { path: '#/account', element: 'account-view' },
  { path: '#/settings', element: 'settings-view' },
]

it('navigates every registered route, or the table below has gone stale', () => {
  // The table is written out rather than derived from ROUTES (a computed table that shrinks
  // asserts less while looking the same — see lessons L18), so this pins its size to the
  // registry's.
  expect(NAVIGATIONS).toHaveLength(ROUTES.length)
})

for (const { path, element } of NAVIGATIONS) {
  it(`renders ${element} at ${path} once updateComplete settles`, async () => {
    // `fixture` awaits the shell's `updateComplete`, which the shell extends across the view's
    // dynamic import. If that contract breaks, every existing test that renders the shell and
    // queries a view synchronously afterwards breaks with it — this is the pin on the contract.
    window.location.hash = path
    const host = await shell()
    expect(host.querySelector(element)).not.toBeNull()
  })
}

it('shows a fallback with a retry when the view chunk cannot be fetched', async () => {
  // The failure mode the split introduces: the application opened, the user navigated, and the
  // chunk is not there (evicted cache, a deploy mid-session, no network on a first visit).
  // Rendering nothing would be a blank page with working navigation — the exact shape L28 warns
  // about. The route's loader stands in for the failed fetch.
  const failing: readonly Route[] = [
    { path: '/', view: 'projects', load: () => Promise.reject(new Error('chunk unreachable')) },
  ]
  const host = await shell(failing)

  expect(host.querySelector('projects-view')).toBeNull()
  expect(host.querySelector('[data-view-failed]')).not.toBeNull()
  expect(host.querySelector('[data-view-retry]')).not.toBeNull()
})

it('retries the import from the fallback, and renders the view once it arrives', async () => {
  // First fetch fails, the retry succeeds — a flaky connection recovering, without a full page
  // reload that would lose unsaved state elsewhere.
  let attempts = 0
  const flaky: readonly Route[] = [
    {
      path: '/',
      view: 'projects',
      load: () => {
        attempts += 1
        return attempts === 1
          ? Promise.reject(new Error('chunk unreachable'))
          : import('../../../src/ui/views/projects.js')
      },
    },
  ]
  const host = await shell(flaky)
  expect(host.querySelector('[data-view-failed]')).not.toBeNull()

  host.querySelector<HTMLElement>('[data-view-retry]')?.click()
  await (host as Element & { updateComplete: Promise<unknown> }).updateComplete

  expect(attempts).toBe(2)
  expect(host.querySelector('[data-view-failed]')).toBeNull()
  expect(host.querySelector('projects-view')).not.toBeNull()
})

it('does not re-run a loader the shell has already loaded a view through', async () => {
  // The loader is a module import: running it once is the contract, and a shell that re-imported
  // on every render would turn each hash change into a fetch.
  let calls = 0
  const counted: readonly Route[] = [
    {
      path: '/',
      view: 'projects',
      load: () => {
        calls += 1
        return import('../../../src/ui/views/projects.js')
      },
    },
    { path: '/settings', view: 'settings', load: () => import('../../../src/ui/views/settings.js') },
  ]
  const host = await shell(counted)
  expect(host.querySelector('projects-view')).not.toBeNull()

  window.location.hash = '#/settings'
  window.dispatchEvent(new HashChangeEvent('hashchange'))
  await (host as Element & { updateComplete: Promise<unknown> }).updateComplete
  window.location.hash = '#/'
  window.dispatchEvent(new HashChangeEvent('hashchange'))
  await (host as Element & { updateComplete: Promise<unknown> }).updateComplete

  expect(host.querySelector('projects-view')).not.toBeNull()
  expect(calls).toBe(1)
})
