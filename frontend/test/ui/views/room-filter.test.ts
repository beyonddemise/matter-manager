import { describe, expect, it } from 'vitest'
import { matchRoute } from '../../../src/ui/router/match.js'
import { ROUTES } from '../../../src/ui/router/routes.js'
import { devicesInRoomHref, roomFromHash } from '../../../src/ui/views/room-filter.js'

/**
 * The address the Rooms page links to and the device list reads: `#/devices?room=…`.
 *
 * Both ends are tested together because the failure worth catching is the two disagreeing about
 * the encoding, which neither end can see on its own: a path with a `/`, a `&` or a space that
 * goes out one way and comes back as a different room, or as none.
 */
describe('the room filter in the address', () => {
  it.each([
    ['a top-level room', 'Attic'],
    ['a nested room', 'Ground Floor/Kitchen'],
    ['a name with characters a query string reserves', 'Bed & Bath/Room #2?=+'],
    ['a name outside ASCII', 'Erdgeschoss/Küche › Ärmel'],
  ])('round-trips %s', (_label, path) => {
    expect(roomFromHash(devicesInRoomHref(path))).toBe(path)
  })

  it('links to the device list, so the router still matches it', () => {
    // The router ignores the query, so the route stays `/devices` and only the view reads it.
    const href = devicesInRoomHref('Ground Floor/Kitchen')

    expect(href.startsWith('#/devices?')).toBe(true)
    expect(matchRoute(href, ROUTES)?.route.path).toBe('/devices')
  })

  it('finds no room when the address has no query', () => {
    expect(roomFromHash('#/devices')).toBeUndefined()
    expect(roomFromHash('')).toBeUndefined()
  })

  it('finds no room when the query has no room parameter', () => {
    expect(roomFromHash('#/devices?sort=name')).toBeUndefined()
  })

  it('treats a blank room parameter as no filter, rather than a room with no name', () => {
    // A filter on `''` would show nothing, which reads as "this project has no devices".
    expect(roomFromHash('#/devices?room=')).toBeUndefined()
    expect(roomFromHash('#/devices?room=%20%20')).toBeUndefined()
  })

  it('trims whitespace around a room someone typed into the address', () => {
    expect(roomFromHash('#/devices?room=%20Attic%20')).toBe('Attic')
  })

  it('reads the room alongside other parameters', () => {
    expect(roomFromHash('#/devices?sort=name&room=Attic')).toBe('Attic')
  })
})
