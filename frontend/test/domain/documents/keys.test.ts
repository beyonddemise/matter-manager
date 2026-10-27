import { describe, expect, it } from 'vitest'
import { idRange } from '../../../src/domain/documents/ids.js'
import {
  ESCROW_KEY_DOCUMENT_ID,
  isProjectKeyDocument,
  PROJECT_KEY_PREFIX,
  projectKeyDocumentId,
  projectKeyRange,
} from '../../../src/domain/documents/keys.js'

const wrap = () => ({
  _id: projectKeyDocumentId('ab'.repeat(32)),
  type: 'projectKey',
  kid: 'ab'.repeat(32),
  alg: 'RSA-OAEP-256',
  wrapped: 'bGlnaHQgd29yaw==',
  createdAt: '2026-10-27T09:00:00.000Z',
})

describe('project key ids', () => {
  it('names a device wrap by its kid, and the escrow wrap by the fixed id', () => {
    expect(projectKeyDocumentId('ab'.repeat(32))).toBe(`key:${'ab'.repeat(32)}`)
    expect(ESCROW_KEY_DOCUMENT_ID).toBe('key:escrow')
    expect(ESCROW_KEY_DOCUMENT_ID.startsWith(PROJECT_KEY_PREFIX)).toBe(true)
  })

  it('refuses a kid that would escape its own id', () => {
    expect(() => projectKeyDocumentId('')).toThrow(RangeError)
    expect(() => projectKeyDocumentId('a:b')).toThrow(RangeError)
  })

  it('sorts outside the device range, so device lists never see a wrap', () => {
    // The spec leans on this: `repository.list` reads a ranged `_all_docs`, and the wraps must
    // fall outside it without any filter existing.
    const devices = idRange('device')
    const keys = projectKeyRange()
    expect(devices.endkey < keys.startkey).toBe(true)
    expect(keys.startkey < keys.endkey).toBe(true)
    expect(ESCROW_KEY_DOCUMENT_ID > keys.startkey && ESCROW_KEY_DOCUMENT_ID < keys.endkey).toBe(
      true,
    )
  })
})

describe('isProjectKeyDocument', () => {
  it('accepts a wrap document as written', () => {
    expect(isProjectKeyDocument(wrap())).toBe(true)
    expect(isProjectKeyDocument({ ...wrap(), _rev: '1-abc' })).toBe(true)
  })

  it('rejects everything that is not one', () => {
    expect(isProjectKeyDocument(null)).toBe(false)
    expect(isProjectKeyDocument('key:escrow')).toBe(false)
    expect(isProjectKeyDocument({ ...wrap(), type: 'project' })).toBe(false)
    expect(isProjectKeyDocument({ ...wrap(), _id: 'device:abc' })).toBe(false)
    expect(isProjectKeyDocument({ ...wrap(), alg: 'RSA-OAEP' })).toBe(false)
    expect(isProjectKeyDocument({ ...wrap(), wrapped: 42 })).toBe(false)
    expect(isProjectKeyDocument({ ...wrap(), kid: undefined })).toBe(false)
    expect(isProjectKeyDocument({ ...wrap(), createdAt: undefined })).toBe(false)
  })
})
