import PouchDB from 'pouchdb-browser'
import { afterEach, describe, expect, it } from 'vitest'
import { encodeBase64 } from '../../src/domain/crypto/base64.js'
import { decryptField, deriveKid, encryptField } from '../../src/domain/crypto/envelope.js'
import {
  ESCROW_KEY_DOCUMENT_ID,
  projectKeyDocumentId,
  projectKeyRange,
} from '../../src/domain/documents/keys.js'
import { PROJECT_DOCUMENT_ID } from '../../src/domain/documents/project.js'
import { ensureDeviceKey } from '../../src/ui/db/device-key.js'
import { createProjectKeys, unlockProject } from '../../src/ui/db/keyring.js'
import {
  localDatabase,
  localProfileCache,
  PROJECT_DATABASE_NAME,
  projectDatabase,
  rawDatabase,
  removeLocalDatabases,
} from '../../src/ui/db/project-database.js'
import type { EscrowKeyInfo } from '../../src/ui/escrow-client.js'
import {
  type AccountSources,
  adoptLegacyCatalogue,
  createLocalProject,
  destroyLocalProject,
  detachOrphanedProject,
  indexServerProject,
  localProjectDefaults,
  renameLocalProject,
  resolveAccount,
  setLocalClient,
} from '../../src/ui/local-projects.js'
import type { Profile } from '../../src/ui/profile.js'
import { ProjectCreationError } from '../../src/ui/projects.js'
import { pouchRefreshTokenStore } from '../../src/ui/tokens.js'

/** Whether a database holds any document, opened fresh so no memoised handle can answer. */
async function documentCount(name: string): Promise<number> {
  const database = new PouchDB(name)
  try {
    return (await database.info()).doc_count
  } finally {
    await database.close()
  }
}

const device = (id: string) => ({
  _id: id,
  type: 'device' as const,
  name: 'Kitchen lamp',
  room: 'Kitchen',
  manualCode: '34970112332',
  installedAt: '2026-08-26',
  addedAt: '2026-08-26T09:00:00.000Z',
  disabled: false,
  remarks: [],
})

afterEach(async () => {
  await removeLocalDatabases({ includeLocalCatalogue: true }).catch(() => undefined)
})

describe('local projects', () => {
  it('creates a database with a project document and an index entry', async () => {
    const entry = await createLocalProject({ name: 'Musterstraße 12', client: 'Acme' })

    expect(entry.dbName).toMatch(/^project_local_[0-9a-f-]{36}$/)
    expect(await rawDatabase(entry.dbName).get(PROJECT_DOCUMENT_ID)).toMatchObject({
      type: 'project',
      name: 'Musterstraße 12',
      client: 'Acme',
    })
    expect(await localProfileCache().readLocalProjects()).toEqual([entry])
  })

  it('renames and sets the client in both places', async () => {
    const { dbName } = await createLocalProject({ name: 'Old' })

    await renameLocalProject(dbName, 'New')
    await setLocalClient(dbName, 'Acme')
    expect(await rawDatabase(dbName).get(PROJECT_DOCUMENT_ID)).toMatchObject({
      name: 'New',
      client: 'Acme',
    })
    expect(await localProfileCache().readLocalProjects()).toMatchObject([
      { dbName, name: 'New', client: 'Acme' },
    ])

    await setLocalClient(dbName, undefined)
    const document = await rawDatabase(dbName).get(PROJECT_DOCUMENT_ID)
    expect('client' in document).toBe(false)
    expect((await localProfileCache().readLocalProjects())[0]).not.toHaveProperty('client')
  })

  it('re-reads and writes again when another writer moved the project document first', async () => {
    // A revision race: between this write's read and its put, another writer (a second tab,
    // replication) changes the document, so the put is refused with a 409 and must be retried
    // from a fresh read rather than reported as a failure.
    const { dbName } = await createLocalProject({ name: 'Old' })
    const database = rawDatabase(dbName)
    let raced = false
    const racing = Object.create(database) as PouchDB.Database
    racing.put = (async (doc: PouchDB.Core.PutDocument<object>) => {
      if (!raced) {
        raced = true
        const current = await database.get(PROJECT_DOCUMENT_ID)
        await database.put({ ...current, name: 'Elsewhere' })
      }
      return database.put(doc)
    }) as never

    await renameLocalProject(dbName, 'New', { ...localProjectDefaults, database: () => racing })

    expect(raced).toBe(true)
    expect(await database.get(PROJECT_DOCUMENT_ID)).toMatchObject({ name: 'New' })
  })

  it('destroys the database, the handle and the entry', async () => {
    const { dbName } = await createLocalProject({ name: 'Doomed' })

    await destroyLocalProject(dbName)

    expect(await localProfileCache().readLocalProjects()).toEqual([])
    expect(await documentCount(dbName)).toBe(0)
    // A fresh handle, not a destroyed one.
    await expect(rawDatabase(dbName).info()).resolves.toMatchObject({ doc_count: 0 })
  })
})

describe('indexing a copy of a server project', () => {
  const server = {
    projectId: 'p7',
    dbName: 'project_p7',
    name: 'Musterstraße 12',
    client: 'Acme',
    role: 'owner' as const,
  }

  it('lists it under its server database name, with its id and role', async () => {
    await indexServerProject(server)

    expect(await localProfileCache().readLocalProjects()).toEqual([
      expect.objectContaining({
        dbName: 'project_p7',
        name: 'Musterstraße 12',
        client: 'Acme',
        projectId: 'p7',
        role: 'owner',
      }),
    ])
  })

  it('writes nothing into the database, whose project document the service owns', async () => {
    await indexServerProject(server)

    expect(await documentCount('project_p7')).toBe(0)
  })

  it('keeps when it was first known, and drops a client the server no longer has', async () => {
    await indexServerProject(server)
    const [first] = await localProfileCache().readLocalProjects()
    const { client: _cleared, ...renamed } = { ...server, name: 'Neu' }

    await indexServerProject(renamed)

    const [entry] = await localProfileCache().readLocalProjects()
    expect(entry).toEqual({ ...first, name: 'Neu', client: undefined })
    expect(entry !== undefined && 'client' in entry).toBe(false)
  })
})

describe('detaching an orphaned copy (#290)', () => {
  /** A copy of a server project the server has since hard-deleted, with data worth keeping. */
  const orphan = async () => {
    await indexServerProject({
      projectId: 'p1',
      dbName: 'project_p1',
      name: 'Beta',
      client: 'Acme',
      role: 'owner',
    })
    const source = rawDatabase('project_p1')
    // As replication left it: the service's project document points at its server database.
    await source.put({
      _id: PROJECT_DOCUMENT_ID,
      type: 'project',
      name: 'Beta',
      client: 'Acme',
      serverDb: 'project_p1',
    })
    await source.put(device('device:one'))
    return source
  }

  it('moves the data into a new local-only database and lists it as a local project', async () => {
    await orphan()

    const entry = await detachOrphanedProject('project_p1')

    if (entry === undefined) throw new Error('the detach yielded, with no other tab around')
    expect(entry).toMatchObject({ name: 'Beta', client: 'Acme' })
    expect(entry.dbName).toMatch(/^project_local_[0-9a-f-]{36}$/)
    expect(entry.projectId).toBeUndefined()
    expect(entry.role).toBeUndefined()
    expect(await localProfileCache().readLocalProjects()).toEqual([entry])
    // The data travelled; the pointer at the server database did not.
    const copy = rawDatabase(entry.dbName)
    await expect(copy.get('device:one')).resolves.toMatchObject({ name: 'Kitchen lamp' })
    const document = await copy.get(PROJECT_DOCUMENT_ID)
    expect(document).toMatchObject({ type: 'project', name: 'Beta', client: 'Acme' })
    expect('serverDb' in document).toBe(false)
    // Only once everything was provably in the copy was the source destroyed.
    expect(await documentCount('project_p1')).toBe(0)
  })

  it('copies again what lands while the copy runs, so nothing is destroyed unsent', async () => {
    const source = await orphan()
    const racing = Object.create(source) as PouchDB.Database
    let raced = false
    // An own property: on the PouchDB prototype `replicate` is a getter, so plain assignment
    // through the prototype chain is refused.
    Object.defineProperty(racing, 'replicate', {
      value: {
        to: async (target: never, options: never) => {
          const result = await source.replicate.to(target, options)
          if (!raced) {
            raced = true
            await source.put(device('device:late'))
          }
          return result
        },
      },
    })

    const entry = await detachOrphanedProject('project_p1', {
      ...localProjectDefaults,
      database: (dbName) => (dbName === 'project_p1' ? racing : rawDatabase(dbName)),
    })

    expect(raced).toBe(true)
    if (entry === undefined) throw new Error('the detach yielded, with no other tab around')
    await expect(rawDatabase(entry.dbName).get('device:late')).resolves.toMatchObject({
      type: 'device',
    })
    expect(await documentCount('project_p1')).toBe(0)
  })

  it('yields, leaving no trace, when another tab detached first', async () => {
    const source = await orphan()
    const racing = Object.create(source) as PouchDB.Database
    Object.defineProperty(racing, 'replicate', {
      value: {
        to: async (target: never, options: never) => {
          // Another tab finished its detach while this one was copying: the entry is gone.
          await localProfileCache().removeLocalProject('project_p1')
          return source.replicate.to(target, options)
        },
      },
    })

    const entry = await detachOrphanedProject('project_p1', {
      ...localProjectDefaults,
      database: (dbName) => (dbName === 'project_p1' ? racing : rawDatabase(dbName)),
      uuid: () => 'fixed',
    })

    expect(entry).toBeUndefined()
    // Its half copy is gone, and the source — the other tab's to destroy — was not touched.
    expect(await localProfileCache().readLocalProjects()).toEqual([])
    expect(await documentCount('project_local_fixed')).toBe(0)
    expect(await documentCount('project_p1')).toBe(2)
  })
})

describe('whose copy an entry is', () => {
  const profile = { sub: 'google|1', plan: 'free' as const, fetchedAt: '2026-10-16T08:00:00.000Z' }

  /** Signed in as `resolveAccount` sees it: a stored refresh token and the cached profile. */
  async function signIn(): Promise<void> {
    await pouchRefreshTokenStore(localDatabase()).write('refresh-token')
    await localProfileCache().writeProfile(profile)
  }

  it('stamps a created project with the signed-in account', async () => {
    await signIn()

    const entry = await createLocalProject({ name: 'Mine' })

    expect(entry.account).toBe('google|1')
    expect(await localProfileCache().readLocalProjects()).toMatchObject([{ account: 'google|1' }])
  })

  it('leaves a project created signed out unstamped', async () => {
    const entry = await createLocalProject({ name: 'Device' })

    expect(entry.account).toBeUndefined()
  })

  it('stamps an indexed server copy', async () => {
    await signIn()

    await indexServerProject({ projectId: 'p7', dbName: 'project_p7', name: 'Beta', role: 'owner' })

    expect(await localProfileCache().readLocalProjects()).toMatchObject([{ account: 'google|1' }])
  })

  it('never adopts on a rename: an unstamped entry stays unstamped', async () => {
    const { dbName } = await createLocalProject({ name: 'Old' })
    await signIn()

    await renameLocalProject(dbName, 'New')
    await setLocalClient(dbName, 'Acme')

    const [entry] = await localProfileCache().readLocalProjects()
    expect(entry?.name).toBe('New')
    expect(entry?.account).toBeUndefined()
  })
})

describe('a new credential forgets whose profile was cached', () => {
  // Every way in - email, passkey, and the Google and GitHub redirects, whose first token
  // exchange stores the cookie's token - ends by storing a refresh token. A different one may
  // be somebody else's (an expired session keeps local data), so the cached profile goes with
  // the old token, before the new one is stored.
  const previous = { sub: 'google|previous', fetchedAt: '2026-10-16T08:00:00.000Z' }

  it('forgets the cached profile when a different token is stored', async () => {
    const store = pouchRefreshTokenStore(localDatabase())
    await store.write('token-a')
    await localProfileCache().writeProfile(previous)

    await store.write('token-b')

    expect(await localProfileCache().readProfile()).toBeUndefined()
    expect(await store.read()).toBe('token-b')
  })

  it('keeps it when the same token is stored again, as every refresh does', async () => {
    const store = pouchRefreshTokenStore(localDatabase())
    await store.write('token-a')
    await localProfileCache().writeProfile(previous)

    await store.write('token-a')

    expect(await localProfileCache().readProfile()).toMatchObject({ sub: 'google|previous' })
  })

  it('forgets a profile left from before any token was stored', async () => {
    await localProfileCache().writeProfile(previous)

    await pouchRefreshTokenStore(localDatabase()).write('token-a')

    expect(await localProfileCache().readProfile()).toBeUndefined()
  })
})

describe('resolving the account to stamp', () => {
  const fetched: Profile = {
    sub: 'google|2',
    email: 'a@example.com',
    displayName: 'A',
    locale: 'auto',
    plan: 'free',
    projectLimit: 1,
  }

  /** Sources for `resolveAccount`, each overridable; by default signed in with nothing cached. */
  function sources(overrides: Partial<AccountSources> = {}) {
    const remembered: Profile[] = []
    const all: AccountSources = {
      cachedSub: async () => undefined,
      signedIn: async () => true,
      fetchProfile: async () => fetched,
      remember: async (profile) => {
        remembered.push(profile)
      },
      ...overrides,
    }
    return { all, remembered }
  }

  it('uses the cached profile without asking the server', async () => {
    const { all } = sources({
      cachedSub: async () => 'google|1',
      fetchProfile: () => Promise.reject(new Error('must not be asked')),
    })

    expect(await resolveAccount(all)).toBe('google|1')
  })

  it('ignores a profile left cached after signing out', async () => {
    const { all } = sources({ cachedSub: async () => 'google|1', signedIn: async () => false })

    expect(await resolveAccount(all)).toBeUndefined()
  })

  it('answers undefined when signed out, without asking the server', async () => {
    const { all } = sources({
      signedIn: async () => false,
      fetchProfile: () => Promise.reject(new Error('must not be asked')),
    })

    expect(await resolveAccount(all)).toBeUndefined()
  })

  it('fetches and caches the profile when signed in before it was cached', async () => {
    const { all, remembered } = sources()

    expect(await resolveAccount(all)).toBe('google|2')
    expect(remembered).toEqual([fetched])
  })

  it('treats an unreadable cache like an empty one', async () => {
    const { all } = sources({ cachedSub: () => Promise.reject(new Error('unreadable')) })

    expect(await resolveAccount(all)).toBe('google|2')
  })

  it('still stamps when the fetched profile cannot be cached', async () => {
    const { all } = sources({ remember: () => Promise.reject(new Error('full')) })

    expect(await resolveAccount(all)).toBe('google|2')
  })

  it('refuses, rather than leave the entry unstamped, when signed in and the server fails', async () => {
    const { all } = sources({ fetchProfile: () => Promise.reject(new TypeError('offline')) })

    await expect(resolveAccount(all)).rejects.toThrow(ProjectCreationError)
  })

  it('refuses when signed in but no access token is held yet', async () => {
    const { all } = sources({ fetchProfile: async () => undefined })

    await expect(resolveAccount(all)).rejects.toMatchObject({ reason: 'unreachable' })
  })

  it('creates nothing when the account cannot be resolved', async () => {
    const before = await localProfileCache().readLocalProjects()

    await expect(
      createLocalProject(
        { name: 'Orphan' },
        {
          ...localProjectDefaults,
          account: () => Promise.reject(new ProjectCreationError('unreachable')),
        },
      ),
    ).rejects.toThrow(ProjectCreationError)
    expect(await localProfileCache().readLocalProjects()).toEqual(before)
  })

  it('still indexes a server copy the server already holds when the account is unknown', async () => {
    await indexServerProject(
      { projectId: 'p8', dbName: 'project_p8', name: 'Gamma', role: 'owner' },
      {
        ...localProjectDefaults,
        account: () => Promise.reject(new ProjectCreationError('unreachable')),
      },
    )

    expect(await localProfileCache().readLocalProjects()).toMatchObject([{ dbName: 'project_p8' }])
  })
})

describe('adopting the legacy catalogue', () => {
  it('names it and indexes it, keeping its devices', async () => {
    await projectDatabase().devices.save(device('device:lamp'))

    await adoptLegacyCatalogue('My home')

    expect(await localProfileCache().readLocalProjects()).toMatchObject([
      { dbName: PROJECT_DATABASE_NAME, name: 'My home' },
    ])
    expect(await projectDatabase().devices.list()).toMatchObject([
      { _id: 'device:lamp', name: 'Kitchen lamp', manualCode: '34970112332' },
    ])
    expect(await rawDatabase(PROJECT_DATABASE_NAME).get(PROJECT_DOCUMENT_ID)).toMatchObject({
      name: 'My home',
    })
  })

  it('is idempotent and never renames', async () => {
    await projectDatabase().devices.save(device('device:lamp'))
    await adoptLegacyCatalogue('First')
    await adoptLegacyCatalogue('Second')

    expect(await localProfileCache().readLocalProjects()).toMatchObject([{ name: 'First' }])
    expect(await rawDatabase(PROJECT_DATABASE_NAME).get(PROJECT_DOCUMENT_ID)).toMatchObject({
      name: 'First',
    })
  })
})

describe('adopting the legacy catalogue keys and encrypts it (#331)', () => {
  const PAYLOAD = 'MT:Y.K9042C00KA0648G00'

  /** A catalogue device as a pre-encryption build stored it: both codes in plaintext. */
  const legacy = (id: string) => ({
    ...device(id),
    payload: PAYLOAD,
    updatedAt: '2026-08-26T09:00:00.000Z',
  })

  /** The stored (raw, undecrypted) form of a catalogue document. */
  const stored = async (id: string) =>
    (await rawDatabase(PROJECT_DATABASE_NAME).get(id)) as unknown as {
      _rev: string
      payload?: string
      manualCode?: string
      updatedAt?: string
    }

  /** Every `key:*` document in the catalogue. */
  const keyDocuments = async () =>
    (await rawDatabase(PROJECT_DATABASE_NAME).allDocs({ ...projectKeyRange(), include_docs: true }))
      .rows

  /** This device's DEK for the catalogue, failing loudly when there is none. */
  const catalogueDek = async () => {
    const dek = await unlockProject(rawDatabase(PROJECT_DATABASE_NAME))
    if (dek === null) throw new Error('the catalogue has no key for this device')
    return dek
  }

  /** Caches an escrow public key in `mm-local`, as escrow startup would. */
  async function cacheEscrowKey(): Promise<EscrowKeyInfo> {
    const pair = await crypto.subtle.generateKey(
      {
        name: 'RSA-OAEP',
        modulusLength: 2048,
        publicExponent: new Uint8Array([0x01, 0x00, 0x01]),
        hash: 'SHA-256',
      },
      false,
      ['wrapKey', 'unwrapKey'],
    )
    const publicKey = encodeBase64(
      new Uint8Array(await crypto.subtle.exportKey('spki', pair.publicKey)),
    )
    const info = { kid: await deriveKid(publicKey), alg: 'RSA-OAEP-256', publicKey }
    await localProfileCache().writeEscrowKey({ ...info, fetchedAt: '2026-10-28T08:00:00.000Z' })
    return info
  }

  it('mints key:<own kid> and, with the escrow key cached, key:escrow', async () => {
    const escrow = await cacheEscrowKey()
    await rawDatabase(PROJECT_DATABASE_NAME).put(legacy('device:lamp'))

    await adoptLegacyCatalogue('Home')

    const ids = (await keyDocuments()).map((row) => row.id).sort()
    expect(ids).toEqual(
      [ESCROW_KEY_DOCUMENT_ID, projectKeyDocumentId((await ensureDeviceKey()).kid)].sort(),
    )
    expect(await rawDatabase(PROJECT_DATABASE_NAME).get(ESCROW_KEY_DOCUMENT_ID)).toMatchObject({
      kid: escrow.kid,
    })
  })

  it('mints only key:<own kid> when no escrow key is cached', async () => {
    await rawDatabase(PROJECT_DATABASE_NAME).put(legacy('device:lamp'))

    await adoptLegacyCatalogue('Home')

    expect((await keyDocuments()).map((row) => row.id)).toEqual([
      projectKeyDocumentId((await ensureDeviceKey()).kid),
    ])
  })

  it('keys an empty first-run catalogue too, so the first device saved is encrypted', async () => {
    await adoptLegacyCatalogue('')

    expect(await keyDocuments()).toHaveLength(1)
    await projectDatabase().devices.save(device('device:new'))
    expect((await stored('device:new')).manualCode).toMatch(/^enc:v1:/)
  })

  it('stores every adopted device enc:v1:, keeping its updatedAt, and reads it back plaintext', async () => {
    await rawDatabase(PROJECT_DATABASE_NAME).bulkDocs([legacy('device:a'), legacy('device:b')])
    // A view read the catalogue before adoption, memoising its keyless, plaintext state.
    expect(await projectDatabase().devices.list()).toHaveLength(2)

    await adoptLegacyCatalogue('Home')

    const dek = await catalogueDek()
    for (const id of ['device:a', 'device:b']) {
      const raw = await stored(id)
      expect(raw.payload).toMatch(/^enc:v1:/)
      expect(raw.manualCode).toMatch(/^enc:v1:/)
      expect(await decryptField(dek, id, 'payload', raw.payload ?? '')).toBe(PAYLOAD)
      // Re-encrypting changes no user-entered field, so it must not outrank a real edit.
      expect(raw.updatedAt).toBe('2026-08-26T09:00:00.000Z')
    }
    // The memo was dropped: the same repositories now decrypt rather than pass ciphertext on.
    expect(await projectDatabase().devices.list()).toMatchObject([
      { _id: 'device:a', payload: PAYLOAD, manualCode: '34970112332' },
      { _id: 'device:b', payload: PAYLOAD, manualCode: '34970112332' },
    ])
  })

  it('finishes an adoption interrupted after the key write with the same DEK, minting no other', async () => {
    const database = rawDatabase(PROJECT_DATABASE_NAME)
    await database.bulkDocs([legacy('device:a'), legacy('device:b')])
    // The first run writes the keys and then dies at its first device rewrite.
    const dying = Object.create(database) as PouchDB.Database
    dying.put = (async (doc: { _id: string }) => {
      if (doc._id.startsWith('device:')) throw new Error('the tab was closed')
      return database.put(doc as never)
    }) as never
    await expect(
      adoptLegacyCatalogue('Home', { ...localProjectDefaults, database: () => dying }),
    ).rejects.toThrow('the tab was closed')
    // Nothing listed, so the next run adopts again; the keys are already there.
    expect(await localProfileCache().readLocalProjects()).toEqual([])
    const [wrap] = await keyDocuments()
    if (wrap?.doc === undefined) throw new Error('the interrupted run wrote no key')
    const dek = await catalogueDek()

    await adoptLegacyCatalogue('Home')

    // The same wrap, untouched: no second DEK was minted over it.
    const after = await keyDocuments()
    expect(after).toHaveLength(1)
    expect(after[0]?.doc).toEqual(wrap.doc)
    // And that one DEK opens everything the second run encrypted.
    for (const id of ['device:a', 'device:b']) {
      const raw = await stored(id)
      expect(await decryptField(dek, id, 'manualCode', raw.manualCode ?? '')).toBe('34970112332')
      expect(await decryptField(dek, id, 'payload', raw.payload ?? '')).toBe(PAYLOAD)
    }
    expect(await localProfileCache().readLocalProjects()).toMatchObject([
      { dbName: PROJECT_DATABASE_NAME, name: 'Home' },
    ])
  })

  it('leaves already-encrypted devices as stored and never re-encrypts a sealed field', async () => {
    const database = rawDatabase(PROJECT_DATABASE_NAME)
    // An interrupted run got as far as the keys and one device.
    const dek = await createProjectKeys(database, null)
    const sealed = {
      ...legacy('device:sealed'),
      payload: await encryptField(dek, 'device:sealed', 'payload', PAYLOAD),
      manualCode: await encryptField(dek, 'device:sealed', 'manualCode', '34970112332'),
    }
    // Half sealed: `encryptField` throws on `enc:` input, so re-sealing this payload would fail
    // the whole adoption — succeeding proves only the plaintext field went through it.
    const half = {
      ...legacy('device:half'),
      payload: await encryptField(dek, 'device:half', 'payload', PAYLOAD),
    }
    await database.bulkDocs([sealed, half, legacy('device:plain')])
    const sealedBefore = await stored('device:sealed')

    await adoptLegacyCatalogue('Home')

    // Not rewritten at all: same revision, same (randomised-IV) ciphertext.
    expect(await stored('device:sealed')).toEqual(sealedBefore)
    // Read back through the cipher and sealed again from plaintext: one layer, not two.
    const halfAfter = await stored('device:half')
    expect(await decryptField(dek, 'device:half', 'payload', halfAfter.payload ?? '')).toBe(PAYLOAD)
    expect(halfAfter.manualCode).toMatch(/^enc:v1:/)
    expect(await decryptField(dek, 'device:half', 'manualCode', halfAfter.manualCode ?? '')).toBe(
      '34970112332',
    )
    expect((await stored('device:plain')).payload).toMatch(/^enc:v1:/)
  })
})

describe('adopting on a device with nothing to adopt', () => {
  it('adopts the empty catalogue when nothing is indexed, so the device has a project to name', async () => {
    // Ruling C-R7: a brand-new device always has one nameable project. Without it the first
    // run would land on a page with nothing to open and nowhere to record a device.
    await adoptLegacyCatalogue('')

    expect(await localProfileCache().readLocalProjects()).toMatchObject([
      { dbName: PROJECT_DATABASE_NAME, name: '' },
    ])
    expect(await rawDatabase(PROJECT_DATABASE_NAME).get(PROJECT_DOCUMENT_ID)).toMatchObject({
      type: 'project',
      name: '',
    })
  })

  it('creates and indexes nothing on a device that has heard of server projects', async () => {
    // A signed-in member who removed their last local copy: their projects are on the server,
    // and an empty project they never made would count against their plan.
    await localProfileCache().writeProjects(
      [{ projectId: 'p1', dbName: 'project_p1', name: 'Beta', role: 'owner' }],
      '2026-10-03T08:00:00.000Z',
    )

    await adoptLegacyCatalogue('')

    expect(await localProfileCache().readLocalProjects()).toEqual([])
    expect(await documentCount(PROJECT_DATABASE_NAME)).toBe(0)
  })

  it('creates and indexes nothing when another project is already indexed', async () => {
    // A device that has projects already has somewhere to work; an empty catalogue listed
    // beside them would be a project nobody made.
    const other = await createLocalProject({ name: 'Elsewhere' })

    await adoptLegacyCatalogue('Phantom')

    expect(await localProfileCache().readLocalProjects()).toEqual([other])
    expect(await documentCount(PROJECT_DATABASE_NAME)).toBe(0)
  })

  it('overwrites a malformed project document instead of failing with a conflict', async () => {
    await rawDatabase(PROJECT_DATABASE_NAME).put({ _id: PROJECT_DOCUMENT_ID, type: 'oops' })

    await adoptLegacyCatalogue('Repaired')

    expect(await rawDatabase(PROJECT_DATABASE_NAME).get(PROJECT_DOCUMENT_ID)).toMatchObject({
      type: 'project',
      name: 'Repaired',
    })
  })
})

describe('signing out with indexed local projects', () => {
  it('destroys indexed databases that were never opened', async () => {
    // Created in a handle of its own, as a previous page load would have left it.
    const dbName = 'project_local_00000000-0000-4000-8000-000000000001'
    const untouched = new PouchDB(dbName)
    await untouched.put({ _id: 'device:left-behind' })
    await untouched.close()
    await localProfileCache().addLocalProject({ dbName, name: 'Left', createdAt: 'x' })

    await removeLocalDatabases({ includeLocalCatalogue: true })

    expect(await documentCount(dbName)).toBe(0)
    expect(await localProfileCache().readLocalProjects()).toEqual([])
  })

  it('keeps indexed local-only projects, and their listing, unless asked', async () => {
    const dbName = 'project_local_00000000-0000-4000-8000-000000000002'
    const untouched = new PouchDB(dbName)
    await untouched.put({ _id: 'device:mine' })
    await untouched.close()
    await localProfileCache().addLocalProject({ dbName, name: 'Mine', createdAt: 'x' })

    await removeLocalDatabases()

    expect(await documentCount(dbName)).toBe(1)
    expect(await localProfileCache().readLocalProjects()).toMatchObject([{ dbName }])
  })

  it('keeps an opened local-only project even when the cache cannot be read', async () => {
    // Without the index, the opened-handle fallback must not mistake local-only data for
    // account data.
    const { dbName } = await createLocalProject({ name: 'Mine' })
    await localDatabase().close()
    const destroyed: string[] = []

    await removeLocalDatabases({}, async (name) => {
      destroyed.push(name)
    })

    expect(destroyed).not.toContain(dbName)
  })

  it('keeps a local-only project whose promotion stopped half way, unless asked', async () => {
    // Its entry already carries the server's id, but its data is still only here: the id does
    // not make it a server copy, its database name says what it is.
    const dbName = 'project_local_00000000-0000-4000-8000-000000000003'
    const untouched = new PouchDB(dbName)
    await untouched.put({ _id: 'device:unpushed' })
    await untouched.close()
    await localProfileCache().addLocalProject({
      dbName,
      name: 'Half',
      projectId: 'p7',
      createdAt: 'x',
    })

    await removeLocalDatabases()

    expect(await documentCount(dbName)).toBe(1)
    expect(await localProfileCache().readLocalProjects()).toMatchObject([
      { dbName, projectId: 'p7' },
    ])
  })

  it('always destroys a downloaded server copy', async () => {
    const dbName = 'project_p9'
    const copy = new PouchDB(dbName)
    await copy.put({ _id: 'device:theirs' })
    await copy.close()
    await localProfileCache().addLocalProject({
      dbName,
      name: 'Shared',
      projectId: 'p9',
      createdAt: 'x',
    })

    await removeLocalDatabases()

    expect(await documentCount(dbName)).toBe(0)
  })
})
