import { describe, expect, it } from 'vitest'
import { isProjectDocument, PROJECT_DOCUMENT_ID } from '../../../src/domain/documents/project.js'

const valid = {
  _id: 'project',
  type: 'project',
  name: 'Musterstraße 12',
  serverDb: 'project_8f14e45f-ceea-467a-9c0e-1b2c3d4e5f60',
}

describe('the project document', () => {
  it('has the fixed id the backend writes it under', () => {
    expect(PROJECT_DOCUMENT_ID).toBe('project')
  })

  it('accepts a valid document, with or without a client', () => {
    expect(isProjectDocument(valid)).toBe(true)
    expect(isProjectDocument({ ...valid, client: 'Acme', _rev: '2-a' })).toBe(true)
  })

  it('rejects a wrong type or id', () => {
    expect(isProjectDocument({ ...valid, type: 'device' })).toBe(false)
    expect(isProjectDocument({ ...valid, _id: 'project:x' })).toBe(false)
  })

  it('rejects a missing or mistyped field', () => {
    expect(isProjectDocument({ ...valid, name: undefined })).toBe(false)
    expect(isProjectDocument({ ...valid, serverDb: 3 })).toBe(false)
    expect(isProjectDocument({ ...valid, client: 3 })).toBe(false)
  })

  it('rejects what is not an object', () => {
    expect(isProjectDocument(null)).toBe(false)
    expect(isProjectDocument('project')).toBe(false)
  })
})
