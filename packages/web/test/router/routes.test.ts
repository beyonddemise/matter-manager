import { describe, expect, it } from 'vitest'
import { matchRoute } from '../../src/router/match.js'
import { NAV_ROUTES, ROUTES } from '../../src/router/routes.js'

describe('the route registry', () => {
  it('routes the root path to the device list', () => {
    expect(matchRoute('#/', ROUTES)?.route.view).toBe('device-list')
  })

  it('routes /settings to the settings view', () => {
    expect(matchRoute('#/settings', ROUTES)?.route.view).toBe('settings')
  })

  it('gives every route a unique path', () => {
    const paths = ROUTES.map((route) => route.path)
    expect(new Set(paths).size).toBe(paths.length)
  })

  it('lists exactly the labelled routes in the navigation', () => {
    expect(NAV_ROUTES).toEqual(ROUTES.filter((route) => route.label !== undefined))
  })

  it('has at least one navigation entry, or the shell has no navigation to render', () => {
    expect(NAV_ROUTES.length).toBeGreaterThan(0)
  })

  it('gives every navigation entry a label and an icon', () => {
    for (const route of NAV_ROUTES) {
      expect(typeof route.label?.()).toBe('string')
      expect(route.label?.()).not.toBe('')
      expect(route.icon).toBeTruthy()
    }
  })

  it('routes /devices/new to the add-device view', () => {
    expect(matchRoute('#/devices/new', ROUTES)?.route.view).toBe('add-device')
  })

  it('keeps the add-device route out of the navigation', () => {
    // Reached from the button on the device list. A permanent nav entry beside "Devices"
    // would list one section's action as though it were a section.
    expect(NAV_ROUTES.map((route) => route.path)).not.toContain('/devices/new')
  })

  it('registers no route whose view the shell cannot render', () => {
    // M2 registers only views that exist. Registering /devices/:id before M2-7 builds
    // its view would match a path and then fail to render, which is worse than not
    // matching it — an unregistered path correctly falls through to not-found.
    expect(ROUTES.map((route) => route.view)).toEqual(['device-list', 'add-device', 'settings'])
  })
})
