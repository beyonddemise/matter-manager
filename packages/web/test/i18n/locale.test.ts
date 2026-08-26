import { describe, expect, it } from 'vitest'
import {
  LOCALE_STORAGE_KEY,
  negotiateLocale,
  readLocalePreference,
  SOURCE_LOCALE,
  SUPPORTED_LOCALES,
  writeLocalePreference,
} from '../../src/i18n/locale.js'

describe('negotiateLocale', () => {
  describe('with no explicit preference', () => {
    // The browser's list, and what the application should conclude from it. Each row is a
    // fact about the negotiation rule rather than an example of it: the primary subtag is
    // what matches, case does not count, and the browser's ORDER decides, not ours.
    const cases: readonly [string, readonly string[], string][] = [
      ['an exact supported tag', ['de'], 'de'],
      ['a region subtag is ignored', ['de-DE'], 'de'],
      ['an unrelated region is still German', ['de-AT'], 'de'],
      ['a variant subtag is ignored', ['de-DE-1996'], 'de'],
      ['case does not matter', ['DE-de'], 'de'],
      ['an unsupported language falls back', ['fr-FR'], 'en'],
      ['the first SUPPORTED entry wins, not the first entry', ['fr-FR', 'de', 'en'], 'de'],
      ['order is the browser’s, not ours', ['en-GB', 'de'], 'en'],
      ['an empty list falls back', [], 'en'],
      ['an empty string is not a language', ['', 'de'], 'de'],
      ['a language that merely starts with a supported one does not match', ['den'], 'en'],
      ['surrounding whitespace does not defeat the match', [' de-DE '], 'de'],
    ]

    it.each(cases)('%s: %j → %s', (_name, languages, expected) => {
      expect(negotiateLocale('auto', languages)).toBe(expected)
    })
  })

  it('an explicit preference overrides the browser', () => {
    expect(negotiateLocale('en', ['de-DE'])).toBe('en')
    expect(negotiateLocale('de', ['en-US', 'fr'])).toBe('de')
  })

  it('never returns a locale that is not supported', () => {
    for (const languages of [['de-DE'], ['fr'], [], ['zz-ZZ']]) {
      expect(SUPPORTED_LOCALES).toContain(negotiateLocale('auto', languages))
    }
  })
})

describe('the stored preference', () => {
  const storageReturning = (value: string | null) => () => ({ getItem: () => value })

  it('reads a stored value back', () => {
    expect(readLocalePreference(storageReturning('de'))).toBe('de')
    expect(readLocalePreference(storageReturning('en'))).toBe('en')
    expect(readLocalePreference(storageReturning('auto'))).toBe('auto')
  })

  it('falls back to auto for anything it did not write', () => {
    // An older build, a hand edit, or a locale that was supported once and is not now.
    for (const junk of [null, '', 'fr', 'de-DE', 'DE', 'true', '{}']) {
      expect(readLocalePreference(storageReturning(junk))).toBe('auto')
    }
  })

  it('falls back to auto when storage itself throws', () => {
    const hostile = () => {
      throw new Error('SecurityError: The operation is insecure.')
    }
    expect(readLocalePreference(hostile)).toBe('auto')
  })

  it('writes under the namespaced key', () => {
    const written: Record<string, string> = {}
    writeLocalePreference(
      () => ({
        setItem: (key, value) => {
          written[key] = value
        },
      }),
      'de',
    )
    expect(written).toEqual({ [LOCALE_STORAGE_KEY]: 'de' })
  })

  it('does not throw when the write is refused', () => {
    expect(() =>
      writeLocalePreference(() => {
        throw new Error('QuotaExceededError')
      }, 'de'),
    ).not.toThrow()
  })
})

describe('the locale table', () => {
  it('names the source locale first, because it is the fallback', () => {
    expect(SUPPORTED_LOCALES[0]).toBe(SOURCE_LOCALE)
  })

  it('has no duplicates', () => {
    expect(new Set(SUPPORTED_LOCALES).size).toBe(SUPPORTED_LOCALES.length)
  })
})
