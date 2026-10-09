import { describe, expect, it } from 'vitest'
import { isConflict } from '../../src/data/index.js'

/**
 * #238: one `isConflict` for every caller. The permissive one: PouchDB reports a lost revision
 * race as `status: 409` from `put`, but a `bulkDocs` row carries only `name: 'conflict'`.
 */
describe('isConflict', () => {
  it('recognises a 409', () => {
    expect(isConflict({ status: 409, name: 'conflict' })).toBe(true)
    expect(isConflict({ status: 409 })).toBe(true)
  })

  it('recognises a bulkDocs row that names the conflict without a status', () => {
    expect(isConflict({ error: true, name: 'conflict', id: 'device:a' })).toBe(true)
  })

  it('rejects everything else', () => {
    expect(isConflict({ status: 404, name: 'not_found' })).toBe(false)
    expect(isConflict(new Error('conflict'))).toBe(false)
    expect(isConflict(null)).toBe(false)
    expect(isConflict(undefined)).toBe(false)
    expect(isConflict('conflict')).toBe(false)
    expect(isConflict(409)).toBe(false)
  })
})
