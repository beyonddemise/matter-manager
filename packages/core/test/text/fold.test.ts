import { describe, expect, it } from 'vitest'
import { foldForComparison } from '../../src/text/fold.js'

/**
 * These properties were pinned through `isNearDuplicateRoomPath` while the fold lived inside
 * `roomPathKey`, and `rooms/path.test.ts` still pins them there. They are repeated here — not
 * the whole matrix, only the load-bearing pairs — because the fold now has a second caller.
 * Device search relies on exactly these properties, and a change to the fold that broke search
 * while leaving room paths working would otherwise be caught by nothing.
 */
describe('two spellings a person reads as one', () => {
  const same = (a: string, b: string) => foldForComparison(a) === foldForComparison(b)

  it('folds case', () => {
    expect(same('Kitchen', 'kitchen')).toBe(true)
  })

  it('folds the German sharp s against SS, which lowercasing does not', () => {
    // `'Straße'.toLowerCase()` is `straße` and `'STRASSE'.toLowerCase()` is `strasse`, so a
    // lowercase fold would fail to recognise the same German word as itself.
    expect(same('Straße', 'STRASSE')).toBe(true)
  })

  it('composes Unicode, so the two spellings of ü match', () => {
    // One code point, or `u` plus a combining diaeresis. They render identically.
    expect(same('Küche', 'Küche')).toBe(true)
  })

  it('collapses runs of whitespace but keeps word boundaries', () => {
    expect(same('Ground  Floor', 'Ground Floor')).toBe(true)
    expect(same('GroundFloor', 'Ground Floor')).toBe(false)
  })

  it('keeps genuinely different words apart', () => {
    expect(same('Straße', 'Strand')).toBe(false)
  })

  it('treats the Turkish dotless i as the same as i, deliberately', () => {
    // Accepted: this is case conversion used as a fold, not Unicode `Case_Folding`. The cost
    // is one extra search hit and one extra duplicate-room warning. Revisit if Turkish becomes
    // a supported locale - this test will fail and force the decision rather than let it drift.
    expect(same('ı', 'i')).toBe(true)
  })
})
