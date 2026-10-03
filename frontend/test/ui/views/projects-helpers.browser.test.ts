import { describe, expect, it } from 'vitest'
import type { Project } from '../../../src/ui/projects.js'
import type { ProjectsModel, Row } from '../../../src/ui/projects-model.js'
import {
  clearFields,
  fieldValue,
  replicated,
  sortRows,
} from '../../../src/ui/views/projects-helpers.js'

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

const created = { projectId: 'p-new', dbName: 'project_p-new' } as Project

const model = (owned: Row[], shared: Row[] = []) => ({ owned, shared }) as unknown as ProjectsModel

describe('what replication covers after a create', () => {
  it('is every synchronized row, owned or shared, and the new project', () => {
    const covered = replicated(
      model(
        [
          row({ dbName: 'project_local_a' }),
          row({ dbName: 'project_p1', projectId: 'p1', location: 'synced' }),
          row({ dbName: 'project_p9', projectId: 'p9', location: 'server' }),
          // An archived project's copy reads `local`: replicating it would only be refused.
          row({ dbName: 'project_p8', projectId: 'p8', location: 'local' }),
        ],
        [row({ dbName: 'project_p2', projectId: 'p2', location: 'synced' })],
      ),
      created,
    )
    expect(covered).toEqual([
      { projectId: 'p1', dbName: 'project_p1' },
      { projectId: 'p2', dbName: 'project_p2' },
      { projectId: 'p-new', dbName: 'project_p-new' },
    ])
  })

  it('does not list the new project twice once the page already knows it', () => {
    const known = row({ dbName: 'project_p-new', projectId: 'p-new', location: 'synced' })
    expect(replicated(model([known]), created)).toEqual([
      { projectId: 'p-new', dbName: 'project_p-new' },
    ])
  })
})

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
