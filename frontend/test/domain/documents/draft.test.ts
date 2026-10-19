import { describe, expect, it } from 'vitest'
import { matchRoom } from '../../../src/domain/documents/draft.js'

/**
 * Which spelling a typed room is stored with (ADR 0021).
 *
 * A device carries its room's path, so whatever the add and edit flows store is what the Rooms
 * page lists. `matchRoom` is what keeps typing `kitchen` from putting a second spelling of the
 * existing `Kitchen` on that page. Both flows call it; `new-device.test.ts` and
 * `edit-device.test.ts` check that they do, and this file checks what it decides.
 */
describe('matching a typed room to an existing spelling', () => {
  it('reuses the existing spelling when the whole path matches by key', () => {
    expect(matchRoom('ground floor/kitchen', ['Ground Floor/Kitchen'])).toBe('Ground Floor/Kitchen')
  })

  it('reuses the spelling of an ancestor for a room that is new', () => {
    // The pantry is new, but the floor is not: it keeps its one spelling.
    expect(matchRoom('ground floor/Pantry', ['Ground Floor/Kitchen'])).toBe('Ground Floor/Pantry')
  })

  it('reuses the deepest ancestor it can, keeping only the new segments as typed', () => {
    expect(matchRoom('house/ground floor/Pantry', ['House/Ground Floor/Kitchen'])).toBe(
      'House/Ground Floor/Pantry',
    )
    expect(matchRoom('house/attic/Studio', ['House/Ground Floor/Kitchen'])).toBe(
      'House/attic/Studio',
    )
  })

  it('takes the first spelling when the project already has several', () => {
    // The caller passes them in `roomsOf` order, so this is the spelling the Rooms page lists
    // first.
    expect(matchRoom('KITCHEN', ['Kitchen', 'kitchen'])).toBe('Kitchen')
    expect(matchRoom('KITCHEN', ['kitchen', 'Kitchen'])).toBe('kitchen')
  })

  it('takes the first spelling of an ancestor too', () => {
    expect(matchRoom('GROUND FLOOR/Pantry', ['Ground Floor/Hall', 'ground floor/Kitchen'])).toBe(
      'Ground Floor/Pantry',
    )
  })

  it('keeps what was typed when nothing matches', () => {
    expect(matchRoom('Attic', ['Ground Floor/Kitchen'])).toBe('Attic')
    expect(matchRoom('Attic', [])).toBe('Attic')
  })

  it('does not match across a segment boundary', () => {
    // `Floor 1` is a string prefix of `Floor 10`, and nothing else.
    expect(matchRoom('floor 1/Kitchen', ['Floor 10/Kitchen'])).toBe('floor 1/Kitchen')
  })

  it('does not take a deeper existing room for a shallower typed one', () => {
    // Typing the floor alone files the device on the floor, spelled as it already is.
    expect(matchRoom('ground floor', ['Ground Floor/Kitchen'])).toBe('Ground Floor')
  })

  it('matches an existing path that was stored with stray whitespace', () => {
    expect(matchRoom('ground floor/kitchen', [' Ground Floor / Kitchen '])).toBe(
      'Ground Floor/Kitchen',
    )
  })
})
