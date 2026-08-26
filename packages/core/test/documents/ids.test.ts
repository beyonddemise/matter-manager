import { describe, expect, it } from 'vitest'
import {
  DOCUMENT_PREFIX,
  documentId,
  documentTypeOf,
  idRange,
  uuidOf,
} from '../../src/documents/ids.js'

const UUID = '6ba7b810-9dad-11d1-80b4-00c04fd430c8'

describe('document ids', () => {
  it('prefixes an id with its type', () => {
    expect(documentId('device', UUID)).toBe(`device:${UUID}`)
    expect(documentId('room', UUID)).toBe(`room:${UUID}`)
  })

  it('round-trips through the type and the uuid', () => {
    const id = documentId('device', UUID)
    expect(documentTypeOf(id)).toBe('device')
    expect(uuidOf(id)).toBe(UUID)
  })

  it('reports no type for an id it did not make', () => {
    for (const id of ['', 'device', 'devices:x', ':x', 'meta:project', 'Device:x']) {
      expect(documentTypeOf(id)).toBeUndefined()
    }
  })

  it('rejects a bare prefix with no uuid behind it', () => {
    // `device:` is inside its own key range, so a repository that accepted it would store a
    // document with no identity and then list it happily.
    expect(documentTypeOf('device:')).toBeUndefined()
    expect(uuidOf('device:')).toBeUndefined()
  })

  it('matches only at the start, so a prefix buried in an id is not a type', () => {
    // The failure this prevents: `notdevice:1` passes a repository's type guard, is written,
    // and then sorts outside the `device:` range - present in the database, absent from every
    // list, and reachable only by someone who already knows the id.
    for (const id of ['notdevice:1', 'x-room:1', ` ${'device:'}1`]) {
      expect(documentTypeOf(id)).toBeUndefined()
    }
  })

  it('rejects a uuid that would break the range', () => {
    // A separator inside the suffix makes `documentTypeOf` and `uuidOf` disagree about where
    // the id ends, and an id outside the prefix range simply never appears in a list.
    expect(() => documentId('device', `${UUID}:extra`)).toThrow(/colon/i)
    expect(() => documentId('device', '')).toThrow(/empty/i)
  })

  it('gives every type a distinct prefix ending in the separator', () => {
    const prefixes = Object.values(DOCUMENT_PREFIX)
    expect(new Set(prefixes).size).toBe(prefixes.length)
    for (const prefix of prefixes) expect(prefix.endsWith(':')).toBe(true)
  })
})

describe('the _all_docs range', () => {
  it('starts at the prefix', () => {
    expect(idRange('device').startkey).toBe('device:')
  })

  it('covers every id of that type', () => {
    const { startkey, endkey } = idRange('device')
    for (const id of [documentId('device', UUID), 'device:0', 'device:zzzzzzzz', 'device:＀']) {
      expect(id >= startkey).toBe(true)
      expect(id <= endkey).toBe(true)
    }
  })

  it('excludes the id that sorts immediately after the range', () => {
    // ';' is the character after ':', so `device;…` is the nearest thing to a device id that
    // is not one. A too-generous endkey passes a devices-versus-rooms test and fails here.
    const { startkey, endkey } = idRange('device')
    for (const id of ['device;', `device;${UUID}`, 'devicf:x', 'room:x']) {
      expect(id >= startkey && id <= endkey).toBe(false)
    }
  })

  it('does not overlap another type’s range', () => {
    const device = idRange('device')
    const room = idRange('room')
    expect(device.endkey < room.startkey || room.endkey < device.startkey).toBe(true)
  })
})
