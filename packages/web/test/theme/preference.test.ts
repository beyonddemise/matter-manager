import { describe, expect, it } from 'vitest'
import {
  DEFAULT_PALETTE,
  DEFAULT_THEME,
  PALETTE_STORAGE_KEY,
  readPalettePreference,
  readThemePreference,
  THEME_STORAGE_KEY,
  writePalettePreference,
  writeThemePreference,
} from '../../src/theme.js'

/** A `localStorage` stand-in, seeded with whatever a case needs. */
const storage = (seed: Record<string, string> = {}) => {
  const held = new Map(Object.entries(seed))
  return {
    getItem: (key: string) => held.get(key) ?? null,
    setItem: (key: string, value: string) => void held.set(key, value),
    held,
  }
}

describe('remembering the chosen look', () => {
  it('falls back to what index.html already carries', () => {
    // These two are hard-coded in the class attribute of index.html, so a mismatch here is a
    // first paint in one look and a second in another.
    expect(readThemePreference(() => storage())).toBe(DEFAULT_THEME)
    expect(readPalettePreference(() => storage())).toBe(DEFAULT_PALETTE)
  })

  it('reads back what was written', () => {
    const local = storage()
    writeThemePreference(() => local, 'mellow')
    writePalettePreference(() => local, 'vogue')
    expect(readThemePreference(() => local)).toBe('mellow')
    expect(readPalettePreference(() => local)).toBe('vogue')
  })

  it('ignores a theme this build withholds', () => {
    // `tailspin` is real, and is excluded for contrast. A preference written by a build that
    // offered it - or edited by hand - must not resurrect it.
    const local = storage({ [THEME_STORAGE_KEY]: 'tailspin' })
    expect(readThemePreference(() => local)).toBe(DEFAULT_THEME)
  })

  it('ignores a palette that does not exist', () => {
    const local = storage({ [PALETTE_STORAGE_KEY]: 'chartreuse' })
    expect(readPalettePreference(() => local)).toBe(DEFAULT_PALETTE)
  })

  it('survives storage that refuses to be read', () => {
    const throwing = () => {
      throw new DOMException('denied', 'SecurityError')
    }
    expect(readThemePreference(throwing)).toBe(DEFAULT_THEME)
  })
})
