import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  BUNDLED,
  DEFAULT_PALETTE,
  DEFAULT_THEME,
  PALETTE_LOADERS,
  PALETTE_STORAGE_KEY,
  readPalettePreference,
  readThemePreference,
  THEME_LOADERS,
  THEME_STORAGE_KEY,
  writePalettePreference,
  writeThemePreference,
} from '../../../src/ui/theme.js'

/** The frontend package root, so the two source files below are read rather than guessed at. */
const frontend = join(import.meta.dirname, '../../..')
const read = (path: string) => readFileSync(join(frontend, path), 'utf8')

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

/**
 * What the first paint looks like is stated in three places, and they have to agree.
 *
 * `index.html` puts the classes on `<html>` so the very first frame is right. `main.ts` imports
 * that theme's and that palette's stylesheets statically so the tokens those classes name exist
 * before anything renders. `theme.ts` marks those same two as {@link BUNDLED}, because there is
 * nothing left to fetch for them.
 *
 * Nothing but this connects the three. Changing `DEFAULT_THEME` alone would leave the new
 * default arriving over a second round trip — a visible flash — and the old one marked bundled
 * and therefore **never loaded at all**, which is a theme that silently stops working. The
 * build cannot see it: every file compiles, every other test passes, and `loadLook` resolves.
 */
describe('the default look is the one that is already loaded', () => {
  it('is what index.html carries on <html>', () => {
    const html = read('index.html')

    expect(html).toContain(`wa-theme-${DEFAULT_THEME}`)
    expect(html).toContain(`wa-palette-${DEFAULT_PALETTE}`)
  })

  it('is what main.ts imports statically', () => {
    // A static import, deliberately: the first paint has to be right, and a theme arriving over
    // a second round trip is a visible flash of the wrong one. Asserted against the source
    // because a static import is not something the module can be asked about at runtime.
    const main = read('src/ui/main.ts')

    expect(main).toContain(`dist/styles/themes/${DEFAULT_THEME}.css`)
    expect(main).toContain(`dist/styles/color/palettes/${DEFAULT_PALETTE}.css`)
  })

  it('is exactly the pair the loader tables treat as already bundled', () => {
    // Identity, not behaviour: every loader resolves, so calling them proves nothing. What
    // matters is *which* entries skip the fetch, and that has to be the default pair and only
    // the default pair - one more and a theme never loads, one fewer and rolldown goes back to
    // warning that a dynamic import it cannot honour is being asked for.
    const bundledThemes = Object.entries(THEME_LOADERS)
      .filter(([, loader]) => loader === BUNDLED)
      .map(([name]) => name)
    const bundledPalettes = Object.entries(PALETTE_LOADERS)
      .filter(([, loader]) => loader === BUNDLED)
      .map(([name]) => name)

    expect(bundledThemes).toEqual([DEFAULT_THEME])
    expect(bundledPalettes).toEqual([DEFAULT_PALETTE])
  })
})
