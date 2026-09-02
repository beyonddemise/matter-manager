import { fixture, html } from '@open-wc/testing-helpers'
import { expect, it } from 'vitest'
import { VIEWS } from '../src/app-shell.js'
import { ROUTES } from '../src/router/routes.js'
import '../src/views/not-found.js'

it('has a registered view for every route the registry declares', () => {
  // The claim `routes.test.ts` cannot make: that file runs in Node, where importing the shell
  // would define custom elements. A route whose view the shell does not know matches a path and
  // then renders nothing - worse than not matching, because an unregistered path falls through
  // to not-found and says so.
  //
  // **A key in the map is not enough**, which is what the first version of this test checked.
  // Deleting `import './views/rooms.js'` from the shell leaves the map intact and `#/rooms`
  // rendering an unregistered `<rooms-view>`, so the element registry is checked too.
  //
  // That rests on every view `x` defining `<x-view>`, which all six do. A view breaking the
  // convention fails here rather than silently, which is the right way round for a convention
  // nothing else enforces.
  const missing = ROUTES.filter(
    (route) =>
      VIEWS[route.view] === undefined || customElements.get(`${route.view}-view`) === undefined,
  )
  expect(missing.map((route) => `${route.path} -> ${route.view}`)).toEqual([])
})

it('declares no view the registry never routes to', () => {
  // The other direction. A view nobody can reach is #120's defect in miniature, and this map is
  // exactly where one would sit unnoticed.
  const routed = new Set(ROUTES.map((route) => route.view))
  expect(Object.keys(VIEWS).filter((view) => !routed.has(view))).toEqual([])
})

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
