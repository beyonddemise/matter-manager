import { describe, expect, it } from 'vitest'
import {
  readPreference,
  resolveScheme,
  SCHEME_STORAGE_KEY,
  type SchemePreference,
  writePreference,
} from '../src/scheme.js'

const storageWith = (value: string | null) => ({ getItem: () => value })

describe('resolveScheme', () => {
  it.each([
    ['light', false, 'light'],
    ['light', true, 'light'],
    ['dark', false, 'dark'],
    ['dark', true, 'dark'],
  ])('honours an explicit %s preference regardless of the system', (pref, dark, expected) => {
    expect(resolveScheme(pref as SchemePreference, dark)).toBe(expected)
  })

  it.each([
    [true, 'dark'],
    [false, 'light'],
  ])('follows the system when the preference is "system" (prefersDark=%s)', (dark, expected) => {
    expect(resolveScheme('system', dark)).toBe(expected)
  })
})

describe('readPreference', () => {
  it.each([['light'], ['dark'], ['system']])('reads a stored %s preference', (stored) => {
    expect(readPreference(() => storageWith(stored))).toBe(stored)
  })

  it('defaults to following the system when nothing is stored', () => {
    expect(readPreference(() => storageWith(null))).toBe('system')
  })

  it.each([['bright'], [''], ['DARK'], ['null']])(
    'falls back to "system" for the unrecognised stored value %o',
    (stored) => {
      // A value written by an older build, or edited by hand, must not leave the app with an
      // invalid scheme. Following the system is the one answer that is never wrong.
      expect(readPreference(() => storageWith(stored))).toBe('system')
    },
  )

  it('falls back to "system" when getItem throws', () => {
    // Safari in private browsing throws on access rather than returning null.
    const hostile = {
      getItem() {
        throw new Error('denied')
      },
    }
    expect(readPreference(() => hostile)).toBe('system')
  })

  it('falls back to "system" when the storage supplier itself throws', () => {
    // On a hostile origin, the throwing site is the `localStorage` property access, not
    // `getItem` - the supplier models that access. If this were not guarded, application
    // startup would abort before this function ever got a `storage` object to call
    // `getItem` on.
    const getStorage = (): Storage => {
      throw new DOMException('denied', 'SecurityError')
    }
    expect(readPreference(getStorage)).toBe('system')
  })
})

describe('writePreference', () => {
  it('writes under the documented key', () => {
    const written: Array<[string, string]> = []
    writePreference(() => ({ setItem: (k, v) => written.push([k, v]) }), 'dark')
    expect(written).toEqual([[SCHEME_STORAGE_KEY, 'dark']])
  })

  it('does not throw when setItem refuses the write', () => {
    const hostile = {
      setItem() {
        throw new Error('quota')
      },
    }
    expect(() => writePreference(() => hostile, 'dark')).not.toThrow()
  })

  it('does not throw when the storage supplier itself throws', () => {
    // Same hostile-origin case as readPreference: the property access to `localStorage`
    // itself can throw before any `setItem` call happens.
    const getStorage = (): Storage => {
      throw new DOMException('denied', 'SecurityError')
    }
    expect(() => writePreference(getStorage, 'dark')).not.toThrow()
  })
})
