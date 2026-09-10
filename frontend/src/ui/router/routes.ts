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

export const ROUTES: readonly Route[] = [
  { path: '/', view: 'device-list', label: () => msg('Devices'), icon: 'lightbulb' },
  // No label, so it stays out of the navigation: it is reached from the button on the device
  // list, and a permanent "Add a device" nav entry beside "Devices" would be one section for
  // what is one section's action.
  { path: '/devices/new', view: 'add-device' },
  // After `/devices/new`, and that order is load-bearing: `:id` would otherwise capture the
  // literal segment `new` and route the add form to a device that does not exist. `matchRoute`
  // returns the first match, so the specific path has to come first.
  { path: '/devices/:id', view: 'device' },
  // Order against `/devices/:id` is irrelevant, and deliberately so: `matchRoute` compares
  // segment counts before anything else, so a three-segment route and a two-segment one can
  // never shadow each other. `/devices/new` is the only ordering that carries weight here.
  { path: '/devices/:id/edit', view: 'edit-device' },
  { path: '/rooms', view: 'rooms', label: () => msg('Rooms'), icon: 'tags' },
  { path: '/settings', view: 'settings', label: () => msg('Settings'), icon: 'gear' },
]

/** The routes that appear in the navigation, in registry order. */
export const NAV_ROUTES: readonly Route[] = ROUTES.filter((route) => route.label !== undefined)
