import { describe, expect, it } from 'vitest'
import { EXCLUDED_THEMES, PALETTES, THEMES } from '../../src/theme.js'
import { contrastRatio, PAIRS, type Pair, resolvePair, WA_THEMES } from './support/contrast.js'

/**
 * #70 warned that `premium` rendered a pale brand button with a low-contrast label, and `matter`
 * did the same in dark mode — and asked that contrast be verified rather than assumed if
 * arbitrary theme and palette pairs became selectable.
 *
 * With 11 themes, 10 palettes, two schemes and ten token pairs, that is 2200 measurements.
 * "Check it looks right" is not something anybody will do twice, so it is this.
 */

/** WCAG 1.4.3 for normal-size text. Every pair below carries text at ordinary weight. */
const AA = 4.5

const SCHEMES = ['wa-light', 'wa-dark'] as const

/** Every failing measurement under `themes`, as readable lines. */
function failuresAmong(themes: readonly string[]): string[] {
  const failures: string[] = []
  for (const theme of themes) {
    for (const palette of PALETTES) {
      for (const scheme of SCHEMES) {
        for (const pair of Object.keys(PAIRS) as Pair[]) {
          const { foreground, background } = resolvePair(theme, palette, scheme, pair)
          const ratio = contrastRatio(foreground, background)
          if (ratio < AA)
            failures.push(`${theme}/${palette}/${scheme}/${pair} = ${ratio.toFixed(2)}`)
        }
      }
    }
  }
  return failures
}

describe('the measurement itself', () => {
  /**
   * The control, and it is not ceremony. The first version of this file globbed the stylesheets
   * from a path that matched nothing, so every token resolved to its initial value and all 2200
   * checks "failed" identically. A version of the same mistake in the other direction — colours
   * resolving to something that happens to pass — would have reported all clear and been
   * believed.
   */
  it('resolves real colours rather than initial values', () => {
    const { foreground, background } = resolvePair('glossy', 'anodized', 'wa-light', 'text')
    expect(background).not.toBe('rgba(0, 0, 0, 0)')
    expect(foreground).not.toBe(background)
    expect(contrastRatio(foreground, background)).toBeGreaterThan(10)
  })

  it('computes the ratio WCAG defines', () => {
    expect(contrastRatio('rgb(0, 0, 0)', 'rgb(255, 255, 255)')).toBeCloseTo(21, 5)
    expect(contrastRatio('rgb(255, 255, 255)', 'rgb(255, 255, 255)')).toBeCloseTo(1, 5)
  })
})

describe('every look the user can choose', () => {
  it('meets WCAG AA on every token pair, in both schemes', () => {
    // Collected and reported together rather than asserted one at a time: a run that stops at
    // the first failure tells you one combination is wrong, and the useful question is always
    // whether it is one combination or a whole theme.
    expect(failuresAmong(THEMES).join('\n')).toBe('')
  })
})

describe('the themes withheld for contrast', () => {
  /**
   * Asserted to *fail*, which is the half that stops the list rotting. Without it a theme could
   * be excluded for a reason that no longer holds — or for one that never did — and nothing
   * would ever say so. Web Awesome fixing one of these should turn something red.
   */
  it.each(Object.entries(EXCLUDED_THEMES))('is withheld because %s fails on %s', (theme) => {
    expect(failuresAmong([theme]).length).toBeGreaterThan(0)
  })

  it('names the pair that actually fails', () => {
    for (const [theme, pair] of Object.entries(EXCLUDED_THEMES)) {
      expect(failuresAmong([theme]).join('\n'), theme).toContain(`/${pair} =`)
    }
  })

  it('accounts for every theme this file measures, offering it or withholding it', () => {
    // Found by review. The first version compared two counts, which only catches a theme in
    // *both* lists - and the risk worth catching is the opposite one: a theme that is in
    // neither, silently never offered and never measured. The test was named for the check it
    // did not make (L29).
    //
    // `WA_THEMES` is what `support/contrast.ts` imports and measures, so a theme Web Awesome
    // adds has to be listed there before it can be checked at all. That makes this the boundary
    // worth asserting against: everything measured is deliberately offered or deliberately not.
    const excluded = new Set(Object.keys(EXCLUDED_THEMES))
    expect(THEMES.filter((theme) => excluded.has(theme))).toEqual([])

    const accounted = new Set([...THEMES, ...excluded])
    expect([...accounted].sort()).toEqual([...WA_THEMES].sort())
  })
})
