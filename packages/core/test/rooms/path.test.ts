import { describe, expect, it } from 'vitest'
import {
  isNearDuplicateRoomPath,
  isValidRoomPath,
  normaliseRoomPath,
  ROOM_PATH_SEPARATOR,
  RoomPathError,
  renameRoomPath,
  roomPathKey,
  roomPathProblem,
  splitRoomPath,
} from '../../src/rooms/path.js'

describe('splitRoomPath', () => {
  it('splits a path into its segments', () => {
    expect(splitRoomPath('Ground Floor/Kitchen')).toEqual(['Ground Floor', 'Kitchen'])
  })

  it('treats a bare name as a single segment', () => {
    expect(splitRoomPath('Kitchen')).toEqual(['Kitchen'])
  })

  it('splits a deep path', () => {
    expect(splitRoomPath('House/Ground Floor/Kitchen')).toEqual([
      'House',
      'Ground Floor',
      'Kitchen',
    ])
  })

  /**
   * Empty segments are kept, not quietly discarded.
   *
   * Dropping them would turn `Floor//Kitchen` into a valid two-segment path and report
   * success, so the validator below would never see the fault. The same silent-repair
   * mistake has now cost this project three separate defects in the payload codecs.
   */
  it('preserves empty segments rather than discarding them', () => {
    expect(splitRoomPath('Floor//Kitchen')).toEqual(['Floor', '', 'Kitchen'])
    expect(splitRoomPath('/Kitchen')).toEqual(['', 'Kitchen'])
    expect(splitRoomPath('Kitchen/')).toEqual(['Kitchen', ''])
  })

  it('uses the separator the module exports', () => {
    expect(ROOM_PATH_SEPARATOR).toBe('/')
    expect(splitRoomPath(['A', 'B'].join(ROOM_PATH_SEPARATOR))).toEqual(['A', 'B'])
  })
})

describe('normaliseRoomPath', () => {
  it('trims whitespace around each segment', () => {
    expect(normaliseRoomPath(' ground floor / kitchen ')).toBe('ground floor/kitchen')
  })

  it('preserves the case it was given', () => {
    // Normalisation tidies spacing; it does not decide how a user capitalises their house.
    expect(normaliseRoomPath(' Ground Floor / Kitchen ')).toBe('Ground Floor/Kitchen')
  })

  it('preserves whitespace inside a segment', () => {
    expect(normaliseRoomPath('Living  Room')).toBe('Living  Room')
  })

  it('leaves an already-normal path untouched', () => {
    expect(normaliseRoomPath('Ground Floor/Kitchen')).toBe('Ground Floor/Kitchen')
  })

  /**
   * Normalising must not repair structure. Collapsing `//` here would hide exactly the fault
   * the next test suite is meant to catch, and the user would end up with a room they did not
   * type. Tidying whitespace is presentation; removing a segment is a change of meaning.
   */
  it('does not collapse empty segments into a valid path', () => {
    expect(normaliseRoomPath('Floor//Kitchen')).toBe('Floor//Kitchen')
    expect(normaliseRoomPath('/Kitchen')).toBe('/Kitchen')
    expect(normaliseRoomPath('Kitchen/')).toBe('Kitchen/')
  })

  it('reduces a whitespace-only path to nothing, so it can be reported as empty', () => {
    expect(normaliseRoomPath('   ')).toBe('')
  })
})

describe('roomPathProblem', () => {
  it.each([
    ['a two-segment path', 'Ground Floor/Kitchen'],
    ['a single segment', 'Kitchen'],
    ['a deep path', 'House/Ground Floor/Kitchen'],
    ['a path needing only trimming', ' ground floor / kitchen '],
    ['a segment containing digits and punctuation', 'Flat No. 2/Kitchen'],
  ])('accepts %s', (_label, path) => {
    expect(roomPathProblem(path)).toBeNull()
    expect(isValidRoomPath(path)).toBe(true)
  })

  it.each([
    ['an empty string', '', 'empty'],
    ['only whitespace', '   ', 'empty'],
  ])('reports %s as %s', (_label, path, problem) => {
    expect(roomPathProblem(path)).toBe(problem)
  })

  it.each([
    ['a doubled separator', 'Floor//Kitchen'],
    ['a leading separator', '/Kitchen'],
    ['a trailing separator', 'Kitchen/'],
    ['a whitespace-only segment', 'Floor/ /Kitchen'],
    ['only a separator', '/'],
  ])('reports %s as an empty segment', (_label, path) => {
    expect(roomPathProblem(path)).toBe('emptySegment')
    expect(isValidRoomPath(path)).toBe(false)
  })

  it('distinguishes an empty path from an empty segment', () => {
    // Two different faults with two different remedies: one means "type something", the
    // other means "you have a stray slash". A single 'invalid' would tell the user neither.
    expect(roomPathProblem('')).not.toBe(roomPathProblem('/'))
  })
})

/**
 * Near-duplicate detection exists because the path is the room's identity as far as a human
 * reading it is concerned. ADR 0006 accepts that `Ground Floor/Kitchen` and
 * `ground floor/Kitchen` are genuinely different rooms, and requires a warning at creation
 * time so nobody makes that second room by accident.
 */
describe('near-duplicate detection', () => {
  it.each([
    ['case alone', 'Ground Floor/Kitchen', 'ground floor/kitchen'],
    ['untrimmed whitespace', 'Ground Floor/Kitchen', ' Ground Floor / Kitchen '],
    ['both together', 'Ground Floor/Kitchen', ' ground floor / KITCHEN '],
    ['repeated inner spaces', 'Living  Room', 'Living Room'],
  ])('treats paths differing by %s as near-duplicates', (_label, a, b) => {
    expect(isNearDuplicateRoomPath(a, b)).toBe(true)
  })

  it.each([
    ['different leaf', 'Ground Floor/Kitchen', 'Ground Floor/Bath'],
    ['different depth', 'Ground Floor/Kitchen', 'Ground Floor'],
    ['different parent', 'Ground Floor/Kitchen', 'First Floor/Kitchen'],
    ['same segments, different order', 'Kitchen/Ground Floor', 'Ground Floor/Kitchen'],
  ])('does not treat paths differing by %s as near-duplicates', (_label, a, b) => {
    expect(isNearDuplicateRoomPath(a, b)).toBe(false)
  })

  /**
   * German room names are ordinary here, and `ü` has two Unicode spellings: one code point,
   * or `u` followed by a combining diaeresis. They render identically. Without normalising
   * the form, a user who types one and pastes the other gets two rooms that look the same on
   * screen and cannot be told apart.
   */
  it('treats the two Unicode spellings of the same name as duplicates', () => {
    const composed = 'K\u00FCche' // U+00FC, one code point
    const decomposed = 'Ku\u0308che' // u followed by U+0308, combining diaeresis

    expect(composed).not.toBe(decomposed) // different strings...
    expect(isNearDuplicateRoomPath(composed, decomposed)).toBe(true) // ...same room
  })

  it('is reflexive and symmetric', () => {
    expect(isNearDuplicateRoomPath('Kitchen', 'Kitchen')).toBe(true)
    expect(isNearDuplicateRoomPath('KITCHEN', 'kitchen')).toBe(
      isNearDuplicateRoomPath('kitchen', 'KITCHEN'),
    )
  })

  it('gives equal keys exactly to near-duplicates', () => {
    expect(roomPathKey('Ground Floor/Kitchen')).toBe(roomPathKey(' GROUND floor /kitchen'))
    expect(roomPathKey('Ground Floor/Kitchen')).not.toBe(roomPathKey('Ground Floor/Bath'))
  })
})

describe('renameRoomPath', () => {
  it('renames the room itself', () => {
    expect(renameRoomPath('Floor 1', 'Floor 1', 'Ground Floor')).toBe('Ground Floor')
  })

  it('rewrites the descendants of a renamed parent', () => {
    const rooms = ['Floor 1/Kitchen', 'Floor 1/Bath']
    expect(rooms.map((p) => renameRoomPath(p, 'Floor 1', 'Ground Floor'))).toEqual([
      'Ground Floor/Kitchen',
      'Ground Floor/Bath',
    ])
  })

  it('rewrites descendants at any depth', () => {
    expect(renameRoomPath('Floor 1/Kitchen/Sink', 'Floor 1', 'Ground Floor')).toBe(
      'Ground Floor/Kitchen/Sink',
    )
  })

  it('leaves unrelated paths alone', () => {
    expect(renameRoomPath('Floor 2/Kitchen', 'Floor 1', 'Ground Floor')).toBe('Floor 2/Kitchen')
  })

  it('returns even an untouched path normalised', () => {
    // Found by mutation: every other case passes an already-normal path, so returning the
    // raw input was indistinguishable. It matters because the renamed paths come back
    // normalised - a room would end up spelled one way or the other depending on whether it
    // happened to match, which is how one room becomes two.
    expect(renameRoomPath(' Floor 2 / Kitchen ', 'Floor 1', 'Ground Floor')).toBe('Floor 2/Kitchen')
  })

  /**
   * The trap this function exists to avoid.
   *
   * A plain `startsWith` match rewrites `Floor 10/Kitchen` when `Floor 1` is renamed, because
   * "Floor 1" is a string prefix of "Floor 10". The result is a room silently moved into a
   * building it was never in, and nothing about it looks wrong afterwards. Matching must be
   * on segment boundaries.
   */
  it.each([
    ['a longer sibling', 'Floor 10/Kitchen'],
    ['a longer sibling with no descendants', 'Floor 10'],
    ['a segment merely starting with the old name', 'Floor 1Kitchen'],
    ['the old name appearing deeper down', 'Basement/Floor 1'],
  ])('does not rewrite %s', (_label, path) => {
    expect(renameRoomPath(path, 'Floor 1', 'Ground Floor')).toBe(path)
  })

  it('can rename a room into a deeper location', () => {
    expect(renameRoomPath('Floor 1/Kitchen', 'Floor 1', 'House/Ground')).toBe(
      'House/Ground/Kitchen',
    )
  })

  it('renames a nested parent without touching its ancestors', () => {
    expect(renameRoomPath('House/Floor 1/Kitchen', 'House/Floor 1', 'House/Ground')).toBe(
      'House/Ground/Kitchen',
    )
  })

  it('normalises its inputs before comparing', () => {
    expect(renameRoomPath('Floor 1/Kitchen', ' Floor 1 ', ' Ground Floor ')).toBe(
      'Ground Floor/Kitchen',
    )
  })

  it('matches case-sensitively, because case distinguishes rooms', () => {
    // ADR 0006: `Ground Floor/Kitchen` and `ground floor/Kitchen` are different rooms.
    // Renaming one must not silently take the other with it.
    expect(renameRoomPath('floor 1/Kitchen', 'Floor 1', 'Ground Floor')).toBe('floor 1/Kitchen')
  })

  /**
   * A transformation has a precondition, unlike a query. `roomPathProblem` reports so the
   * interface can show a message; `renameRoomPath` throws, because the alternative is
   * writing a structurally broken path into the database and finding out later.
   */
  it.each([
    ['an invalid source', 'Floor//1', 'Ground Floor'],
    ['an invalid target', 'Floor 1', 'Ground//Floor'],
    ['an empty source', '', 'Ground Floor'],
    ['an empty target', 'Floor 1', '   '],
  ])('refuses to rename with %s', (_label, from, to) => {
    expect(() => renameRoomPath('Floor 1/Kitchen', from, to)).toThrow(RoomPathError)
    expect(() => renameRoomPath('Floor 1/Kitchen', from, to)).toThrow(/path/i)
  })

  it('accepts valid endpoints, so the guard is not simply refusing everything', () => {
    expect(() => renameRoomPath('Floor 1/Kitchen', 'Floor 1', 'Ground Floor')).not.toThrow()
  })
})
