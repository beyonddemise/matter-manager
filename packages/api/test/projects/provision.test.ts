import { beforeEach, describe, expect, it } from 'vitest'
import {
  OrphanedDatabaseError,
  ProvisioningError,
  provisionProject,
} from '../../src/projects/provision.js'
import { forgetRegistry, pointerId, REGISTRY_DATABASE } from '../../src/projects/registry.js'
import { type CouchFailures, fakeCouch, operations } from '../support/couch.js'

const OWNER = 'google|1234'
const PROJECT_ID = '8f14e45f-ceea-467a-9c0e-1b2c3d4e5f60'
const DATABASE = `project_${PROJECT_ID}`

/** Provisioning against a fake, with an operation optionally made to fail. */
function provisioning(fails: CouchFailures = {}, databases: readonly string[] = []) {
  const fake = fakeCouch({ fails, databases })
  const run = (name = 'Musterstraße 12', address?: string) =>
    provisionProject(
      {
        couch: fake.couch,
        validator: () => 'function (newDoc) { return newDoc }',
        newId: () => PROJECT_ID,
        now: () => '2026-08-27T09:00:00.000Z',
      },
      { name, address },
      OWNER,
    )
  return { fake, run }
}

beforeEach(() => {
  forgetRegistry()
})

describe('creating a project', () => {
  it('creates the database', async () => {
    const { fake, run } = provisioning()
    await run()

    expect(fake.databases.has(DATABASE)).toBe(true)
  })

  it('makes the owner a member and a writer', async () => {
    // The first scenario, exactly. `members` is read access; `writers` is the subset that may
    // also write, and `_design/access` is what enforces it.
    const { fake, run } = provisioning()
    await run()

    expect(fake.security.get(DATABASE)).toEqual({
      members: { names: [OWNER], roles: [] },
      writers: { names: [OWNER] },
    })
  })

  it('installs the access rules', async () => {
    const { fake, run } = provisioning()
    await run()

    expect(fake.documents.get(`${DATABASE}/_design/access`)).toMatchObject({
      validate_doc_update: 'function (newDoc) { return newDoc }',
    })
  })

  it('writes a pointer naming the owner', async () => {
    const { fake, run } = provisioning()
    await run()

    expect(fake.documents.get(`${REGISTRY_DATABASE}/${pointerId(PROJECT_ID)}`)).toMatchObject({
      type: 'projectPointer',
      projectId: PROJECT_ID,
      dbName: DATABASE,
      projectName: 'Musterstraße 12',
      participants: [{ role: 'owner', userid: OWNER }],
    })
  })

  it('answers with what the caller needs to start replicating', async () => {
    const { run } = provisioning()

    expect(await run()).toEqual({
      projectId: PROJECT_ID,
      dbName: DATABASE,
      name: 'Musterstraße 12',
      role: 'owner',
      owner: { ownerType: 'user', ownerId: OWNER },
    })
  })

  it('secures the database before anything else touches it', async () => {
    // **The window that matters.** A database exists between `createDb` and `putSecurity` with
    // CouchDB's default security, which any authenticated user can read. Nothing may widen that
    // window — not the design document, and certainly not a round trip to the registry.
    const { fake, run } = provisioning()
    await run()

    // Indexed within the project's own calls: the registry is created first, so looking for
    // "the first createDb" would find that one and the assertion would prove nothing.
    const own = fake.calls.filter((call) => call.database === DATABASE).map((c) => c.operation)
    expect(own[0]).toBe('createDb')
    expect(own[1]).toBe('putSecurity')
  })

  it('prepares the registry before creating anything', async () => {
    // So that a registry that cannot be reached costs nothing. The other order creates a
    // database and then deletes it again to discover the same fact.
    const { fake, run } = provisioning()
    await run()

    const registryFirst = fake.calls.findIndex((call) => call.database === REGISTRY_DATABASE)
    const databaseCreated = fake.calls.findIndex((call) => call.database === DATABASE)
    expect(registryFirst).toBeLessThan(databaseCreated)
  })

  it('writes the pointer last', async () => {
    // A pointer to a half-made database is a project that appears in the list and does not
    // work. An unpointed database is invisible, and the rollback removes it.
    const { fake, run } = provisioning()
    await run()

    expect(fake.calls.at(-1)).toMatchObject({
      operation: 'putDoc',
      database: REGISTRY_DATABASE,
    })
  })
})

describe('what a project may be called', () => {
  it('refuses an empty name', async () => {
    const { run } = provisioning()
    await expect(run('')).rejects.toThrow(ProvisioningError)
  })

  it('refuses a name that is only whitespace', async () => {
    await expect(provisioning().run('   ')).rejects.toThrow(ProvisioningError)
  })

  it('trims the name it stores', async () => {
    const { fake, run } = provisioning()
    await run('  Musterstraße 12  ')

    expect(fake.documents.get(`${REGISTRY_DATABASE}/${pointerId(PROJECT_ID)}`)).toMatchObject({
      projectName: 'Musterstraße 12',
    })
  })

  it('refuses one longer than the contract allows', async () => {
    // The contract says 200. Checked here rather than only at the route, so the rule holds
    // however the service is called.
    await expect(provisioning().run('x'.repeat(201))).rejects.toThrow(ProvisioningError)
  })

  it('creates nothing when the name is refused', async () => {
    // The check is before the first write, which is the only place it is worth anything.
    const { fake } = provisioning()
    await expect(
      provisionProject(
        {
          couch: fake.couch,
          validator: () => 'function (doc) { return doc }',
          newId: () => PROJECT_ID,
          now: () => '2026-08-27T09:00:00.000Z',
        },
        { name: '' },
        OWNER,
      ),
    ).rejects.toThrow()

    expect(fake.calls).toEqual([])
  })

  it('refuses to provision for nobody', async () => {
    const { fake } = provisioning()
    await expect(
      provisionProject(
        {
          couch: fake.couch,
          validator: () => 'function (doc) { return doc }',
          newId: () => PROJECT_ID,
          now: () => '2026-08-27T09:00:00.000Z',
        },
        { name: 'Musterstraße 12' },
        '',
      ),
    ).rejects.toThrow(/owner/i)
  })
})

describe('provisioning is atomic', () => {
  it('removes the database when the security write fails', async () => {
    // **The scenario the issue calls out.** A database without `_security` is readable by
    // anyone with an account: leaving one behind is a security hole, not untidiness.
    const { fake, run } = provisioning({ putSecurity: true })

    await expect(run()).rejects.toThrow(ProvisioningError)
    expect(fake.databases.has(DATABASE)).toBe(false)
  })

  it('writes no pointer when the security write fails', async () => {
    const { fake, run } = provisioning({ putSecurity: true })
    await expect(run()).rejects.toThrow()

    expect(fake.documents.get(`${REGISTRY_DATABASE}/${pointerId(PROJECT_ID)}`)).toBeUndefined()
  })

  it('removes the database when the access rules cannot be installed', async () => {
    // Secured but unvalidated: every member could write, including the ones added later as
    // readers. Not a state to leave behind either.
    const { fake, run } = provisioning({ putDoc: DATABASE })

    await expect(run()).rejects.toThrow(ProvisioningError)
    expect(fake.databases.has(DATABASE)).toBe(false)
  })

  it('removes the database when the pointer cannot be written', async () => {
    // An unpointed database is invisible to everyone and belongs to nobody. Keeping it would
    // mean storage nothing accounts for and a uuid nothing can ever reuse.
    const { fake, run } = provisioning({ putDoc: REGISTRY_DATABASE })
    await expect(run()).rejects.toThrow()

    expect(fake.databases.has(DATABASE)).toBe(false)
  })

  it('does not remove a database it did not create', async () => {
    // A uuid collision is not a thing that happens, and that is exactly why this path would
    // never be tested by accident. Deleting a database somebody else made — because a random
    // name matched it — is the worst thing this code could do.
    const { fake, run } = provisioning({}, [DATABASE])

    await expect(run()).rejects.toThrow(ProvisioningError)
    expect(fake.databases.has(DATABASE)).toBe(true)
    expect(operations(fake)).not.toContain('deleteDb')
  })

  it('says loudly when it could not clean up', async () => {
    // The one failure that must never be swallowed: the rollback failed, so a database with no
    // `_security` is sitting there readable by every account in the deployment. It needs a
    // distinct error, because the operator's next action is to go and delete it by hand.
    const { run } = provisioning({ putSecurity: true, deleteDb: true })

    await expect(run()).rejects.toThrow(OrphanedDatabaseError)
  })

  it('names the database it could not remove', async () => {
    const { run } = provisioning({ putSecurity: true, deleteDb: true })

    await expect(run()).rejects.toThrow(DATABASE)
  })

  it('keeps the original failure when the rollback also fails', async () => {
    // Both facts matter, and a rollback error that replaced the original would leave nobody
    // knowing why provisioning failed in the first place.
    const { run } = provisioning({ putSecurity: true, deleteDb: true })

    const error = await run().catch((thrown: unknown) => thrown)
    expect((error as OrphanedDatabaseError).cause).toBeDefined()
  })

  it('never reports a project that was not fully provisioned', async () => {
    const { run } = provisioning({ putSecurity: true })

    await expect(run()).rejects.toThrow()
  })
})

describe('what the failure says', () => {
  it('does not repeat CouchDB back to the caller', async () => {
    // The same rule as `couch/client.ts`: an error that echoes the server tells whoever
    // triggered it about the deployment. The reason lives in the log, not in the response.
    const { run } = provisioning({ putSecurity: true })

    const error = await run().catch((thrown: unknown) => thrown)
    expect((error as Error).message).not.toMatch(/internal_server_error/)
  })

  it('carries the cause, for the log', async () => {
    const { run } = provisioning({ putSecurity: true })

    const error = await run().catch((thrown: unknown) => thrown)
    expect((error as ProvisioningError).cause).toBeDefined()
  })
})
