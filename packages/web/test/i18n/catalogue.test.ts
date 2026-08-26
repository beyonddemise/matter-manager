import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { sourceLocale, targetLocales } from '../../src/generated/locale-codes.js'
import { SOURCE_LOCALE, SUPPORTED_LOCALES } from '../../src/i18n/locale.js'

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '../../../..')
const xliff = readFileSync(join(repoRoot, 'packages/web/xliff/de.xlf'), 'utf8')

describe('the generated locale codes and the hand-written table', () => {
  // Two files name the locales: lit-localize.json, from which locale-codes.ts is generated,
  // and locale.ts, which the application reads. Adding a locale to one and not the other is a
  // silent half-configured state - negotiation would never choose the new locale, or would
  // choose one with no catalogue to load.
  it('agree on the source locale', () => {
    expect(sourceLocale).toBe(SOURCE_LOCALE)
  })

  it('agree on the full set', () => {
    expect([sourceLocale, ...targetLocales].sort()).toEqual([...SUPPORTED_LOCALES].sort())
  })
})

describe('the German catalogue', () => {
  const units = [...xliff.matchAll(/<trans-unit id="([^"]+)">([\s\S]*?)<\/trans-unit>/g)].map(
    ([, id, body]) => ({ id, body: body ?? '' }),
  )

  it('parses, so the assertion below is not vacuously true', () => {
    // An `it.each` over an empty array generates no tests, and a `filter` over one produces an
    // empty result that matches an empty expectation. A changed XLIFF shape would otherwise
    // turn the next test green by making it about nothing at all (lesson L18).
    expect(units.length).toBeGreaterThan(10)
    expect(units.every(({ body }) => body.includes('<source>'))).toBe(true)
  })

  it('translates every message', () => {
    // A trans-unit with no target does not fail the build: lit-localize falls back to the
    // English source and prints one line among build output nobody reads. This is what makes
    // "a string was added and never translated" visible.
    const untranslated = units.filter(({ body }) => !body.includes('<target>')).map(({ id }) => id)
    expect(untranslated).toEqual([])
  })
})
