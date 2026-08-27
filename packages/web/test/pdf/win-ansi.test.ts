import { describe, expect, it } from 'vitest'
import { isWinAnsiSafe, UNREPRESENTABLE, winAnsiSafe } from '../../src/pdf/win-ansi.js'

describe('text the standard fonts can already draw', () => {
  it.each([
    ['plain English', 'Kitchen ceiling light'],
    ['every character German needs', 'ÄÖÜ äöü ß Größe Weiß Straße'],
    ['French accents', 'Café à côté, forêt, naïve'],
    ['Spanish and Portuguese', 'Año, mañana, coração'],
    ['Nordic letters', 'Ærø, Ølstykke, Åstorp'],
    ['a room path', 'Erdgeschoss/Küche'],
    ['punctuation WinAnsi has and Latin-1 does not', '“quoted” — em dashed… €'],
    ['digits, which a pairing code is made of', '34970112332'],
  ])('leaves %s exactly as it is', (_case, text) => {
    expect(winAnsiSafe(text)).toBe(text)
    expect(isWinAnsiSafe(text)).toBe(true)
  })
})

describe('text the standard fonts cannot draw', () => {
  it('drops an accent rather than the letter', () => {
    // Czech, Polish, Hungarian, Turkish. `Koupelna — světlo` reads perfectly well as
    // `Koupelna — svetlo`; as `Koupelna — sv?tlo` it does not.
    expect(winAnsiSafe('světlo')).toBe('svetlo')
    expect(winAnsiSafe('Đurđevdan')).toBe('Durdevdan')
    expect(winAnsiSafe('İstanbul odası')).toBe('Istanbul odasi')
  })

  it('keeps a letter whose accent cannot be decomposed', () => {
    // `Ł` is not `L` plus a stroke as far as Unicode normalisation is concerned, so stripping
    // marks does not reach it. Without the small table it would become a question mark, and
    // `?azienka` is not a room anyone can find.
    expect(winAnsiSafe('Łazienka')).toBe('Lazienka')
    expect(winAnsiSafe('Đakovo')).toBe('Dakovo')
  })

  it('marks what has no Latin form, rather than dropping it silently', () => {
    // Cyrillic, Greek, CJK, emoji. A visible mark says "something was here"; a silent
    // deletion produces a shorter name that looks deliberate.
    expect(winAnsiSafe('Кухня')).toBe(UNREPRESENTABLE.repeat(5))
    expect(winAnsiSafe('Kitchen 💡')).toBe(`Kitchen ${UNREPRESENTABLE}`)
  })

  it('does not attempt to romanise', () => {
    // Transliterating Cyrillic or Greek is a linguistic decision with several defensible
    // answers. Guessing at one produces a document that looks authoritative and is wrong.
    expect(winAnsiSafe('Кухня')).not.toContain('K')
  })

  it('keeps the parts it can, around the parts it cannot', () => {
    expect(winAnsiSafe('Küche 厨房 2')).toBe(`Küche ${UNREPRESENTABLE.repeat(2)} 2`)
  })

  it('says when text is not representable', () => {
    expect(isWinAnsiSafe('Łazienka')).toBe(false)
    expect(isWinAnsiSafe('Küche')).toBe(true)
  })

  it('handles an empty string', () => {
    expect(winAnsiSafe('')).toBe('')
    expect(isWinAnsiSafe('')).toBe(true)
  })

  it('counts a surrogate pair as one character, not two broken halves', () => {
    // Iterating a string by index rather than by code point splits an emoji into two lone
    // surrogates, each of which encodes to its own question mark — so the count comes out
    // wrong and the damage looks worse than it is.
    expect(winAnsiSafe('💡')).toBe(UNREPRESENTABLE)
  })
})
