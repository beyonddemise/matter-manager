import { describe, expect, it } from 'vitest'
import { matchRoute, type Route } from '../../src/router/match.js'

const ROUTES: readonly Route[] = [
  { path: '/', view: 'device-list' },
  { path: '/devices/:id', view: 'device-detail' },
  { path: '/devices/:id/remarks', view: 'device-remarks' },
]

describe('matchRoute', () => {
  it.each([
    ['', '/'],
    ['#', '/'],
    ['#/', '/'],
    ['/', '/'],
  ])('treats %o as the root route', (hash) => {
    expect(matchRoute(hash, ROUTES)?.route.view).toBe('device-list')
  })

  it('matches a static path', () => {
    expect(matchRoute('#/devices/abc', ROUTES)?.route.view).toBe('device-detail')
  })

  it('captures a path parameter', () => {
    expect(matchRoute('#/devices/abc', ROUTES)?.params).toEqual({ id: 'abc' })
  })

  it('captures parameters in a longer path', () => {
    const match = matchRoute('#/devices/abc/remarks', ROUTES)
    expect(match?.route.view).toBe('device-remarks')
    expect(match?.params).toEqual({ id: 'abc' })
  })

  it('decodes percent-encoded parameters', () => {
    expect(matchRoute('#/devices/Ground%20Floor', ROUTES)?.params).toEqual({
      id: 'Ground Floor',
    })
  })

  it('ignores a query string', () => {
    expect(matchRoute('#/devices/abc?from=search', ROUTES)?.params).toEqual({ id: 'abc' })
  })

  it('ignores a trailing slash', () => {
    expect(matchRoute('#/devices/abc/', ROUTES)?.route.view).toBe('device-detail')
  })

  it.each([
    ['an unknown path', '#/nope'],
    ['a path too long for any route', '#/devices/abc/remarks/extra'],
    ['a path too short for any route', '#/devices'],
  ])('returns null for %s', (_label, hash) => {
    expect(matchRoute(hash, ROUTES)).toBeNull()
  })

  it.each([['#devices/abc'], ['#devices'], ['devices/abc']])(
    'deliberately does not treat %o as a route: no slash follows the hash',
    (hash) => {
      // Pinned decision, not an accident: a hash that isn't empty/root and doesn't start
      // with `/` after the `#` (or has no `#` at all) is not a route in this scheme. It
      // must fall through to not-found rather than being silently normalised onto
      // `#/devices/abc`. See the comment at the hash-normalisation line in match.ts.
      expect(matchRoute(hash, ROUTES)).toBeNull()
    },
  )

  it('returns the first matching route when two could match', () => {
    // Order is the tie-breaker, so a registry author can put a specific path
    // before a parameterised one and rely on it winning.
    const overlapping: readonly Route[] = [
      { path: '/devices/new', view: 'device-create' },
      { path: '/devices/:id', view: 'device-detail' },
    ]
    expect(matchRoute('#/devices/new', overlapping)?.route.view).toBe('device-create')
  })

  it('falls through a same-length static mismatch to try the next route', () => {
    // A route earlier in the table with the right segment count but the wrong literal
    // text (as opposed to the wrong length, already covered above) must not stop the
    // search - the loop has to keep trying candidates rather than giving up.
    const overlapping: readonly Route[] = [
      { path: '/devices/new', view: 'device-create' },
      { path: '/devices/:id', view: 'device-detail' },
    ]
    expect(matchRoute('#/devices/abc', overlapping)?.route.view).toBe('device-detail')
  })

  it('does not treat a parameter as matching an empty segment', () => {
    expect(matchRoute('#/devices//remarks', ROUTES)).toBeNull()
  })

  it('returns null for an empty route table', () => {
    expect(matchRoute('#/', [])).toBeNull()
  })

  it.each([['#/devices/%E0'], ['#/devices/%']])(
    'returns null rather than throwing for the malformed percent-escape %o',
    (hash) => {
      // decodeURIComponent throws URIError on an invalid escape sequence. A user can paste
      // a hash like this into the address bar; the safe direction for unparseable input is
      // "no match", not a crash that takes the whole render down.
      expect(() => matchRoute(hash, ROUTES)).not.toThrow()
      expect(matchRoute(hash, ROUTES)).toBeNull()
    },
  )
})
