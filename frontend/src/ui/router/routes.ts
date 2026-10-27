/**
 * The route registry, and the extension point for the whole application.
 *
 * Navigation renders *from* this table, so adding a section is one entry plus one view file
 * rather than an edit to the shell. An entry with a `label` appears in the navigation; one
 * without is reachable but unlisted.
 *
 * Only routes whose view exists belong here. Registering a path before its view is built
 * makes the shell match and then fail to render, which is worse than not matching at all.
 *
 * @module
 */

import { msg } from '@lit/localize'
import type { Route } from './match.js'

// Each route's `load` is a literal `import()` of one view, written out rather than built from
// an interpolated path, for the same reason `device-list.ts` spells out its two PDF builders:
// the bundler gives each specifier a chunk of its own and the module graph stays readable to
// the guards (`check:graph` follows these; `check:lazy-views` holds the built result to it).
// The views stay out of the entry chunk this way (#214) — the shell awaits the import before
// rendering the element, and `main.ts` warms all of them right after first paint so an
// application that loses its network after opening still has every view in memory.
export const ROUTES: readonly Route[] = [
  // The landing page: which project, before what is in it. Every device has one (the first-run
  // catalogue), so the page always has something to open.
  {
    path: '/',
    view: 'projects',
    load: () => import('../views/projects.js'),
    label: () => msg('Projects'),
    icon: 'folder',
  },
  // The current project's devices. Every "back to the list" in the device views points here.
  {
    path: '/devices',
    view: 'device-list',
    load: () => import('../views/device-list.js'),
    label: () => msg('Devices'),
    icon: 'lightbulb',
  },
  // No label, so it stays out of the navigation: it is reached from the button on the device
  // list, and a permanent "Add a device" nav entry beside "Devices" would be one section for
  // what is one section's action.
  { path: '/devices/new', view: 'add-device', load: () => import('../views/add-device.js') },
  // After `/devices/new`, and that order is load-bearing: `:id` would otherwise capture the
  // literal segment `new` and route the add form to a device that does not exist. `matchRoute`
  // returns the first match, so the specific path has to come first.
  { path: '/devices/:id', view: 'device', load: () => import('../views/device.js') },
  // Order against `/devices/:id` is irrelevant, and deliberately so: `matchRoute` compares
  // segment counts before anything else, so a three-segment route and a two-segment one can
  // never shadow each other. `/devices/new` is the only ordering that carries weight here.
  {
    path: '/devices/:id/edit',
    view: 'edit-device',
    load: () => import('../views/edit-device.js'),
  },
  {
    path: '/rooms',
    view: 'rooms',
    load: () => import('../views/rooms.js'),
    label: () => msg('Rooms'),
    icon: 'tags',
  },
  // Listed only while signed in: the shell drops this entry from the navigation otherwise.
  {
    path: '/account',
    view: 'account',
    load: () => import('../views/account.js'),
    label: () => msg('Account'),
    icon: 'user',
  },
  {
    path: '/settings',
    view: 'settings',
    load: () => import('../views/settings.js'),
    label: () => msg('Settings'),
    icon: 'gear',
  },
]

/** The routes that appear in the navigation, in registry order. */
export const NAV_ROUTES: readonly Route[] = ROUTES.filter((route) => route.label !== undefined)
