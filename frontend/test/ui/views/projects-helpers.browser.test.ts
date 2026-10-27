import { describe, expect, it } from 'vitest'
import type { Row } from '../../../src/ui/projects-model.js'
import { clearFields, fieldValue, sortRows } from '../../../src/ui/views/projects-helpers.js'

/** The projects page's mechanics, each on its own. */

const row = (over: Partial<Row> & Pick<Row, 'dbName'>): Row =>
  ({
    key: over.dbName,
    name: over.dbName,
    location: 'local',
    archived: false,
    editable: true,
    actions: {} as Row['actions'],
    ...over,
  }) as Row

describe('sorting the table', () => {
  const rows = [
    row({ dbName: 'b', name: 'Bravo', client: 'Acme' }),
    row({ dbName: 'a', name: 'Alpha', client: 'Zeta' }),
    row({ dbName: 'c', name: 'Charlie' }),
  ]
  const names = (sorted: Row[]) => sorted.map((r) => r.name)

  it('sorts by name both ways', () => {
    expect(names(sortRows(rows, { by: 'name', ascending: true }))).toEqual([
      'Alpha',
      'Bravo',
      'Charlie',
    ])
    expect(names(sortRows(rows, { by: 'name', ascending: false }))).toEqual([
      'Charlie',
      'Bravo',
      'Alpha',
    ])
  })

  it('sorts by client, a missing client first', () => {
    expect(names(sortRows(rows, { by: 'client', ascending: true }))).toEqual([
      'Charlie',
      'Bravo',
      'Alpha',
    ])
  })

  it('breaks ties by name, and leaves its input alone', () => {
    const tied = [row({ dbName: 'y', name: 'Yankee' }), row({ dbName: 'x', name: 'X-ray' })]
    expect(names(sortRows(tied, { by: 'client', ascending: false }))).toEqual(['X-ray', 'Yankee'])
    expect(names(tied)).toEqual(['Yankee', 'X-ray'])
  })
})

describe('reading and clearing fields', () => {
  const form = () => {
    const container = document.createElement('div')
    container.innerHTML = '<input data-field="name"><input data-field="client">'
    const [name, client] = container.querySelectorAll('input')
    if (name) name.value = '  Musterstraße 12 '
    if (client) client.value = 'Acme'
    return container
  }

  it('reads a field trimmed, and an absent one as empty', () => {
    const container = form()
    expect(fieldValue(container, 'name')).toBe('Musterstraße 12')
    expect(fieldValue(container, 'missing')).toBe('')
    expect(fieldValue(null, 'name')).toBe('')
  })

  it('clears every field', () => {
    const container = form()
    clearFields(container)
    expect(fieldValue(container, 'name')).toBe('')
    expect(fieldValue(container, 'client')).toBe('')
  })
})
