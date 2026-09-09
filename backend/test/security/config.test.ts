import { describe, expect, it } from 'vitest'
import { originsFromEnv } from '../../src/security/config.js'

describe('where the allowed origins come from', () => {
  it('is the application origin, which sign-in already needs', () => {
    // One name for one fact. `APP_ORIGIN` is where the OAuth flow sends the user back to, so a
    // deployment that can sign anybody in has already stated it.
    expect(originsFromEnv({ APP_ORIGIN: 'https://matter.example' })).toEqual([
      'https://matter.example',
    ])
  })

  it('can be a list, for a deployment that serves more than one front end', () => {
    expect(
      originsFromEnv({ CORS_ORIGINS: 'https://matter.example, https://staging.matter.example' }),
    ).toEqual(['https://matter.example', 'https://staging.matter.example'])
  })

  it('prefers the explicit list when both are set', () => {
    // `CORS_ORIGINS` exists precisely to say something `APP_ORIGIN` cannot, so it wins where
    // they disagree — but the application's own origin is not silently dropped.
    expect(
      originsFromEnv({
        APP_ORIGIN: 'https://matter.example',
        CORS_ORIGINS: 'https://other.example',
      }),
    ).toEqual(['https://other.example', 'https://matter.example'])
  })

  it('does not list the same origin twice', () => {
    expect(
      originsFromEnv({
        APP_ORIGIN: 'https://matter.example',
        CORS_ORIGINS: 'https://matter.example',
      }),
    ).toEqual(['https://matter.example'])
  })

  it('ignores the empty entries a trailing comma leaves behind', () => {
    expect(originsFromEnv({ CORS_ORIGINS: 'https://matter.example,,' })).toEqual([
      'https://matter.example',
    ])
  })

  it('allows nothing when nothing is configured', () => {
    // The default is closed. It is also what every existing test gets, which is why none of
    // them accidentally proves cross-origin access works.
    expect(originsFromEnv({})).toEqual([])
  })

  it('treats an empty value as unset rather than as an origin', () => {
    expect(originsFromEnv({ APP_ORIGIN: '', CORS_ORIGINS: '  ' })).toEqual([])
  })
})
