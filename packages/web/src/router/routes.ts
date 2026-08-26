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
  { path: '/settings', view: 'settings', label: () => msg('Settings'), icon: 'gear' },
]

/** The routes that appear in the navigation, in registry order. */
export const NAV_ROUTES: readonly Route[] = ROUTES.filter((route) => route.label !== undefined)
