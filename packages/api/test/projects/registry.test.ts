import { describe, expect, it } from 'vitest'
import {
  BY_PARTICIPANT_DESIGN,
  BY_USER_VIEW,
  ensureRegistry,
  forgetRegistry,
  pointerId,
  projectsFor,
  REGISTRY_DATABASE,
  writePointer,
} from '../../src/projects/registry.js'
import { fakeCouch, operations } from '../support/couch.js'

/** One row as the view emitted it. */
interface EmittedRow {
  readonly key: unknown
  readonly value: {
    readonly ownerId: string | null
    readonly role: string
    readonly dbName: string
  }
}

/**
 * Runs the map function this module installs, against one document.
 *
 * The view is the thing `GET /projects` depends on and it is shipped as a string, so the only
 * way to test what it *does* is to execute it. Asserting on the source text instead is how a
 * view that emits `ownerId: undefined` passes a test named "carries the owner".
 */
async function runView(doc: Record<string, unknown>): Promise<EmittedRow[]> {
  forgetRegistry()
  const fake = fakeCouch()
  await ensureRegistry(fake.couch)
  const design = fake.documents.get(`projects/_design/${BY_PARTICIPANT_DESIGN}`) as {
    views: Record<string, { map: string }>
  }
  const source = design.views[BY_USER_VIEW]?.map ?? ''

  const rows: EmittedRow[] = []
  const emit = (key: unknown, value: EmittedRow['value']) => rows.push({ key, value })
  // The source is this repository's own view function, installed into CouchDB verbatim.
  // Running it is the only way to test what it emits rather than what it contains.
  // `new Function` on a constant this repository authors, never on input: the source is the
  // module's own `map` string, which is what CouchDB is handed verbatim. Executing it is the
  // only way to test what it emits rather than what it contains — asserting on the text is how
  // a view that emits `undefined` passes a test named for the value it should emit.
  const map = new Function('emit', `return (${source})`)(emit) as (doc: unknown) => void
  map(doc)

  return rows
}

const PROJECT_ID = '8f14e45f-ceea-467a-9c0e-1b2c3d4e5f60'

const POINTER = {
  _id: pointerId(PROJECT_ID),
  type: 'projectPointer' as const,
  projectId: PROJECT_ID,
  dbName: `project_${PROJECT_ID}`,
  projectName: 'Musterstraße 12',
  participants: [{ role: 'owner' as const, userid: 'google|1234' }],
  addedAt: '2026-08-27T09:00:00.000Z',
}

describe('the registry database', () => {
  it('is called projects', () => {
    // ADR 0012. Named once, because a typo would create a second registry that looked empty
    // rather than an error.
    expect(REGISTRY_DATABASE).toBe('projects')
  })

  it('is created with its view on first use', async () => {
    forgetRegistry()
    const fake = fakeCouch()

    await ensureRegistry(fake.couch)

    expect(fake.databases.has('projects')).toBe(true)
    expect(fake.documents.get(`projects/_design/${BY_PARTICIPANT_DESIGN}`)).toBeDefined()
  })

  it('installs a view that emits one row per participant', async () => {
    // The shape `GET /projects` depends on. A view keyed on the *document* rather than on each
    // participant would return a project to its owner and to nobody else, which passes a
    // single-user test and fails the moment anything is shared.
    forgetRegistry()
    const fake = fakeCouch()
    await ensureRegistry(fake.couch)

    const design = fake.documents.get(`projects/_design/${BY_PARTICIPANT_DESIGN}`) as {
      views: Record<string, { map: string }>
    }

    expect(design.views[BY_USER_VIEW]?.map).toContain('participants.forEach')
    expect(design.views[BY_USER_VIEW]?.map).toContain('emit(p.userid')
  })

  it('installs a view that carries the owner on every row', async () => {
    // `ProjectSummary` requires an owner and a row describes one participant, so without this
    // the API reads every pointer again to render a list — N+1 reads to show a menu.
    const rows = await runView({
      ...POINTER,
      participants: [
        { role: 'owner', userid: 'google|1234' },
        { role: 'read', userid: 'google|5678' },
      ],
    })

    expect(rows.map((row) => row.value.ownerId)).toEqual(['google|1234', 'google|1234'])
  })

  it('emits one row per participant, keyed on that participant', async () => {
    // **Run, not grepped.** Asserting that the source string contains `ownerId` passes for a
    // view that emits `ownerId: undefined` — the mutation probe found exactly that. The view is
    // JavaScript, so the test can execute it and read what it emitted.
    const rows = await runView({
      ...POINTER,
      participants: [
        { role: 'owner', userid: 'google|1234' },
        { role: 'read', userid: 'google|5678' },
      ],
    })

    expect(rows.map((row) => row.key)).toEqual(['google|1234', 'google|5678'])
    expect(rows.map((row) => row.value.role)).toEqual(['owner', 'read'])
  })

  it('emits the project a reader can reach, with the reader as the key', async () => {
    // The reason a per-document key would be wrong: a project shared with somebody has to
    // appear in *their* list, and a view keyed on the document only ever answers for its owner.
    const rows = await runView({
      ...POINTER,
      participants: [
        { role: 'owner', userid: 'google|1234' },
        { role: 'read', userid: 'google|5678' },
      ],
    })

    expect(rows.find((row) => row.key === 'google|5678')?.value).toMatchObject({
      dbName: POINTER.dbName,
      projectName: POINTER.projectName,
      role: 'read',
    })
  })

  it('emits nothing for a document that is not a pointer', async () => {
    // The registry holds only pointers today. A view that emitted rows for anything else would
    // put whatever arrived there into somebody's project list.
    expect(await runView({ _id: 'something-else', type: 'audit' })).toEqual([])
  })

  it('emits a null owner rather than inventing one', async () => {
    // Broken data the API refuses to guess at — `routes.ts` leaves such a project out of the
    // list and logs it.
    const rows = await runView({ ...POINTER, participants: [{ role: 'write', userid: 'x' }] })

    expect(rows[0]?.value.ownerId).toBeNull()
  })

  it('is not created twice in one process', async () => {
    // Every project creation would otherwise pay two round trips to be told what it already
    // knows, and the design document would be rewritten on each one.
    forgetRegistry()
    const fake = fakeCouch()

    await ensureRegistry(fake.couch)
    await ensureRegistry(fake.couch)

    expect(operations(fake).filter((operation) => operation === 'createDb')).toHaveLength(1)
  })

  it('tries again after a failure rather than remembering the wrong answer', async () => {
    // A failed `ensureRegistry` that marked itself done would leave every later project
    // creation writing pointers into a database that is not there.
    forgetRegistry()
    const failing = fakeCouch({ fails: { createDb: true } })
    await expect(ensureRegistry(failing.couch)).rejects.toThrow()

    const working = fakeCouch()
    await ensureRegistry(working.couch)

    expect(working.databases.has('projects')).toBe(true)
  })

  it('tolerates a registry that already exists', async () => {
    forgetRegistry()
    const fake = fakeCouch({ databases: ['projects'] })

    await expect(ensureRegistry(fake.couch)).resolves.toBeUndefined()
  })
})

describe('writing a pointer', () => {
  it('writes it under a predictable id', async () => {
    // So that a project can be found without a view. `project:<uuid>`, per docs/DATA-MODEL.md.
    const fake = fakeCouch()
    await writePointer(fake.couch, POINTER)

    expect(fake.documents.get(`projects/project:${PROJECT_ID}`)).toMatchObject({
      projectId: PROJECT_ID,
    })
  })

  it('writes it into the registry, not the project database', async () => {
    // The registry is admin-only and never replicated. A pointer written into the project
    // database would be replicated to every member's browser, taking the participant list —
    // who has access to whose home — with it.
    const fake = fakeCouch()
    await writePointer(fake.couch, POINTER)

    expect(fake.calls.every((call) => call.database === REGISTRY_DATABASE)).toBe(true)
  })
})

describe('the projects somebody can see', () => {
  it('asks the view for that user alone', async () => {
    // Not "fetch all and filter here". The registry holds every project in the deployment, and
    // filtering in the API means the whole list crosses the wire on every request — and one
    // forgotten `filter` discloses all of it.
    const fake = fakeCouch()
    await projectsFor(fake.couch, 'google|1234')

    expect(fake.calls[0]).toMatchObject({
      operation: 'view',
      database: REGISTRY_DATABASE,
      detail: { design: BY_PARTICIPANT_DESIGN, name: BY_USER_VIEW, params: { key: 'google|1234' } },
    })
  })

  it('returns what the view gave it', async () => {
    const fake = fakeCouch()
    fake.rows = [
      {
        value: {
          projectId: PROJECT_ID,
          dbName: `project_${PROJECT_ID}`,
          projectName: 'Musterstraße 12',
          role: 'owner',
          ownerId: 'google|1234',
        },
      },
    ]

    expect(await projectsFor(fake.couch, 'google|1234')).toEqual([
      {
        projectId: PROJECT_ID,
        dbName: `project_${PROJECT_ID}`,
        projectName: 'Musterstraße 12',
        role: 'owner',
        ownerId: 'google|1234',
      },
    ])
  })

  it('returns nothing for somebody with no projects', async () => {
    const fake = fakeCouch()

    expect(await projectsFor(fake.couch, 'google|nobody')).toEqual([])
  })

  it('refuses to ask on behalf of an empty subject', async () => {
    // An empty key is a query, and a view emitting anything under `""` would answer it. A
    // caller reaching here with no subject is a bug in authentication, and it should look like
    // one rather than like a user with no projects.
    const fake = fakeCouch()

    await expect(projectsFor(fake.couch, '')).rejects.toThrow(/subject/i)
  })
})
