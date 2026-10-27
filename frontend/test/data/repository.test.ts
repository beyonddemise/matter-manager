import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  type FieldCipher,
  isLockedDocument,
  type KeyState,
  ProjectLockedError,
  type ProjectRepositories,
  projectRepositories,
} from '../../src/data/index.js'
import { type DeviceDocument, documentId, type Unsaved } from '../../src/domain/index.js'
import {
  fixedClock,
  memoryDatabase,
  reconnect,
  replicas,
  syncOnce,
} from './support/memory-database.js'

/** A room document from before ADR 0021. This application no longer writes or reads them. */
const KITCHEN = 'room:3fa85f64-5717-4562-b3fc-2c963f66afa6'
const LAMP = documentId('device', '6ba7b810-9dad-11d1-80b4-00c04fd430c8')

/**
 * A device with every optional field populated.
 *
 * Deliberately not a minimal fixture: the story's first scenario is "every field is preserved,
 * including remarks", and a fixture that omits the optional half cannot show that.
 */
const lamp = (): Unsaved<DeviceDocument> => ({
  _id: LAMP,
  type: 'device',
  name: 'Kitchen ceiling light',
  room: 'Ground Floor/Kitchen',
  spot: 'ceiling, north end',
  payload: 'MT:Y.K9042C00KA0648G00',
  manualCode: '34970112332',
  vendorId: 0xfff1,
  productId: 0x8000,
  discriminator: 3840,
  vendorName: 'Example GmbH',
  productName: 'Smart Bulb A60',
  deviceTypeId: 266,
  serial: 'SN-000123',
  installedAt: '2026-08-19',
  addedAt: '2026-08-19T08:00:00.000Z',
  disabled: false,
  remarks: [
    {
      id: '9f8e7d6c-1234-4567-89ab-cdef01234567',
      text: 'Replaced batteries',
      authorSub: 'auth0|abc123',
      authorName: 'Stephan',
      createdAt: '2026-08-19T09:30:00.000Z',
    },
  ],
})

const kitchen = () => ({
  _id: KITCHEN,
  type: 'room',
  path: 'Ground Floor/Kitchen',
  sortKey: 100,
})

let database: PouchDB.Database
let repositories: ProjectRepositories

beforeEach(() => {
  database = memoryDatabase()
  repositories = projectRepositories(database, fixedClock('2026-08-20T10:00:00.000Z'))
})

afterEach(async () => {
  await database.destroy()
})

describe('a device round trip', () => {
  it('preserves every field, remarks included', async () => {
    const original = lamp()
    const saved = await repositories.devices.save(original)
    const readBack = await repositories.devices.get(LAMP)

    expect(readBack).toEqual(saved)
    // Field by field against the input rather than against the save's return value, so that a
    // repository which dropped a field on the way in AND on the way out could not agree with
    // itself and pass.
    for (const [key, value] of Object.entries(original)) {
      expect(readBack?.[key as keyof DeviceDocument]).toEqual(value)
    }
    expect(readBack?.remarks).toHaveLength(1)
    expect(readBack?.remarks[0]?.text).toBe('Replaced batteries')
  })

  it('gives the stored document a revision and a timestamp', async () => {
    const saved = await repositories.devices.save(lamp())
    expect(saved._rev).toMatch(/^1-/)
    expect(saved.updatedAt).toBe('2026-08-20T10:00:00.000Z')
  })
})

describe('save', () => {
  it('stamps updatedAt from the clock, and the caller cannot override it', async () => {
    const clock = fixedClock('2026-01-01T00:00:00.000Z', '2026-02-02T00:00:00.000Z')
    const repos = projectRepositories(database, clock)

    const first = await repos.devices.save(lamp())
    expect(first.updatedAt).toBe('2026-01-01T00:00:00.000Z')

    // `updatedAt` is not in `Unsaved`, so this is the only way a caller could smuggle one in.
    const second = await repos.devices.save({
      ...first,
      updatedAt: '1999-12-31T00:00:00.000Z',
    } as Unsaved<DeviceDocument>)
    expect(second.updatedAt).toBe('2026-02-02T00:00:00.000Z')
  })

  it('saveKeepingUpdatedAt writes the document but keeps the stamp it was read with', async () => {
    // Ruling R26: a catalogue-only write is not an edit, so it must not outrank one in the
    // merge's (updatedAt, _rev) order.
    const clock = fixedClock('2026-01-01T00:00:00.000Z', '2026-02-02T00:00:00.000Z')
    const repos = projectRepositories(database, clock)
    const first = await repos.devices.save(lamp())

    const second = await repos.devices.saveKeepingUpdatedAt({ ...first, vendorName: 'Aqara' })

    expect(second._rev).toMatch(/^2-/)
    expect(second.updatedAt).toBe('2026-01-01T00:00:00.000Z')
    const stored = await repos.devices.get(LAMP)
    expect(stored?.updatedAt).toBe('2026-01-01T00:00:00.000Z')
    expect(stored?.vendorName).toBe('Aqara')
  })

  it('saveKeepingUpdatedAt refuses a stale revision and a foreign id, like save', async () => {
    const first = await repositories.devices.save(lamp())
    await repositories.devices.save({ ...first, name: 'renamed' })
    await expect(repositories.devices.saveKeepingUpdatedAt(first)).rejects.toThrow()
    await expect(
      repositories.devices.saveKeepingUpdatedAt({
        ...first,
        _id: KITCHEN,
      } as DeviceDocument),
    ).rejects.toThrow(TypeError)
  })

  it('updates in place when given the revision it read', async () => {
    const first = await repositories.devices.save(lamp())
    const second = await repositories.devices.save({ ...first, name: 'Kitchen spotlight' })

    expect(second._rev).toMatch(/^2-/)
    expect((await repositories.devices.get(LAMP))?.name).toBe('Kitchen spotlight')
    expect(await repositories.devices.list()).toHaveLength(1)
  })

  it('refuses a stale revision rather than overwriting', async () => {
    const first = await repositories.devices.save(lamp())
    await repositories.devices.save({ ...first, name: 'renamed once' })

    // Two clients editing the same device is the ordinary case; a repository that silently
    // won here would discard whichever write arrived second.
    await expect(repositories.devices.save({ ...first, name: 'renamed twice' })).rejects.toThrow()
  })

  it('refuses a document whose id is not a device id', async () => {
    // Saved through the device repository, a `room:` document would land outside the device
    // range: it reads back by id and appears in no list at all. Room documents are gone since
    // ADR 0021, so the id is one this application does not write.
    await expect(
      repositories.devices.save(kitchen() as unknown as Unsaved<DeviceDocument>),
    ).rejects.toThrow(/not one this application writes/)
  })

  it('refuses an id this application does not write at all', async () => {
    // `meta:project` is a real document in the data model, but it carries no type prefix and
    // so belongs to no repository. Saying "not one this application writes" is more useful
    // than naming a type that does not exist.
    await expect(repositories.devices.save({ ...lamp(), _id: 'meta:project' })).rejects.toThrow(
      /not one this application writes/,
    )
  })

  it('stamps an ISO-8601 UTC timestamp when no clock is supplied', async () => {
    // The default clock is not a detail: the merge string-compares `updatedAt`, so a format
    // that did not sort chronologically would break conflict resolution and nothing else.
    const before = new Date().toISOString()
    const saved = await projectRepositories(database).devices.save(lamp())
    const after = new Date().toISOString()

    expect(saved.updatedAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/)
    expect(saved.updatedAt >= before && saved.updatedAt <= after).toBe(true)
  })
})

describe('get', () => {
  it('returns undefined for a document that is not there', async () => {
    expect(await repositories.devices.get(LAMP)).toBeUndefined()
  })

  it('returns undefined after the document is removed', async () => {
    const saved = await repositories.devices.save(lamp())
    await repositories.devices.remove(saved)
    expect(await repositories.devices.get(LAMP)).toBeUndefined()
  })

  it('propagates a failure that is not a missing document', async () => {
    // Swallowing everything would turn an outage into an empty catalogue, which reads as "your
    // devices are gone". Its own database, closed rather than destroyed, so the shared
    // teardown is not left with a handle it cannot use.
    const closed = memoryDatabase()
    await closed.close()

    await expect(projectRepositories(closed, fixedClock('x')).devices.get(LAMP)).rejects.toThrow(
      /closed/i,
    )
  })
})

describe('list', () => {
  it('returns the documents of its own type and nothing else', async () => {
    // A room document left on the server from before ADR 0021 replicates in like any other.
    // The device list must pass over it rather than mistake it for a device.
    await repositories.devices.save(lamp())
    await database.put(kitchen())

    const devices = await repositories.devices.list()

    expect(devices.map((device) => device._id)).toEqual([LAMP])
  })

  it('excludes an id that sorts immediately after the range', async () => {
    // `;` is the character right after `:`, so `device;…` is the closest thing to a device id
    // that is not one. `device:` and `room:` are far apart alphabetically, so the test above
    // passes with a far too generous endkey; this is the one that pins the bound.
    await repositories.devices.save(lamp())
    await database.put({ _id: 'device;not-a-device', type: 'device' })

    expect((await repositories.devices.list()).map((device) => device._id)).toEqual([LAMP])
  })

  it('is empty when nothing has been written', async () => {
    expect(await repositories.devices.list()).toEqual([])
  })

  it('does not list a removed document', async () => {
    const saved = await repositories.devices.save(lamp())
    await repositories.devices.remove(saved)

    // A ranged `_all_docs` omits deleted documents, so no tombstone reaches the mapping. That
    // was checked against the adapter rather than inferred - an earlier version of this file
    // claimed the opposite in a comment and passed anyway.
    expect(await repositories.devices.list()).toEqual([])
  })

  it('returns documents in id order', async () => {
    const second = documentId('device', 'ffffffff-0000-0000-0000-000000000000')
    const first = documentId('device', '00000000-0000-0000-0000-000000000000')
    await repositories.devices.save({ ...lamp(), _id: second })
    await repositories.devices.save({ ...lamp(), _id: first })

    expect((await repositories.devices.list()).map((device) => device._id)).toEqual([first, second])
  })
})

describe('remove', () => {
  it('needs the revision, so it cannot race a concurrent write', async () => {
    const first = await repositories.devices.save(lamp())
    await repositories.devices.save({ ...first, name: 'renamed' })

    await expect(repositories.devices.remove(first)).rejects.toThrow()
    expect(await repositories.devices.get(LAMP)).toBeDefined()
  })
})

/**
 * A stub cipher with the real one's contract, not its cryptography: deterministic output in the
 * `enc:v1:` format, bound to `(docId, field)` so a transplanted value fails, refusing to encrypt
 * a value that already carries the prefix, and passing an unprefixed value through on decrypt.
 * Deterministic on purpose — two replicas encrypting the same value must agree here, so a
 * replication test can tell "ciphertext carried through" from "ciphertext re-made".
 */
function stubCipher(): FieldCipher {
  return {
    async encrypt(docId: string, field: string, value: string): Promise<string> {
      if (value.startsWith('enc:')) throw new Error(`double encryption of ${docId}.${field}`)
      return `enc:v1:${docId}|${field}|${value}`
    },
    async decrypt(docId: string, field: string, value: string): Promise<string> {
      if (!value.startsWith('enc:v1:')) return value
      const [boundId, boundField, ...plain] = value.slice('enc:v1:'.length).split('|')
      if (boundId !== docId || boundField !== field) {
        throw new Error(`a ciphertext of ${boundId}.${boundField} was read as ${docId}.${field}`)
      }
      return plain.join('|')
    },
  }
}

const unlocked = (): KeyState => ({ kind: 'unlocked', cipher: stubCipher() })

/** The raw stored document, ciphertext and all, read past the repository seam. */
const rawDocument = async (db: PouchDB.Database, id: string): Promise<DeviceDocument> =>
  (await db.get(id)) as unknown as DeviceDocument

describe('the encryption seam, unlocked', () => {
  it('encryptsOnSaveDecryptsOnRead', async () => {
    const repos = projectRepositories(database, fixedClock('2026-08-20T10:00:00.000Z'), unlocked())

    const saved = await repos.devices.save(lamp())
    // The save answers plaintext: the caller keeps the returned document and reads it.
    expect(saved.payload).toBe('MT:Y.K9042C00KA0648G00')
    expect(saved.manualCode).toBe('34970112332')

    const stored = await rawDocument(database, LAMP)
    expect(stored.payload).toMatch(/^enc:v1:/)
    expect(stored.manualCode).toMatch(/^enc:v1:/)
    // Only the two secrets are encrypted; everything else stays readable to the merge.
    expect(stored.name).toBe('Kitchen ceiling light')

    const read = await repos.devices.get(LAMP)
    expect(read?.payload).toBe('MT:Y.K9042C00KA0648G00')
    expect(read?.manualCode).toBe('34970112332')
    if (read === undefined) throw new Error('the saved device must read back')
    expect(isLockedDocument(read)).toBe(false)
  })

  it('saveKeepingUpdatedAt encrypts through the same seam', async () => {
    const repos = projectRepositories(database, fixedClock('2026-08-20T10:00:00.000Z'), unlocked())
    const saved = await repos.devices.save(lamp())

    const kept = await repos.devices.saveKeepingUpdatedAt({ ...saved, vendorName: 'Aqara' })

    expect(kept.manualCode).toBe('34970112332')
    expect((await rawDocument(database, LAMP)).manualCode).toMatch(/^enc:v1:/)
    expect((await repos.devices.get(LAMP))?.vendorName).toBe('Aqara')
  })

  it('listDecryptsEveryDoc', async () => {
    const repos = projectRepositories(database, fixedClock('2026-08-20T10:00:00.000Z'), unlocked())
    const other = documentId('device', 'aaaaaaaa-0000-0000-0000-000000000000')
    await repos.devices.save(lamp())
    // A manual-code-only device: `payload` is legitimately absent and must stay absent.
    const { payload: _absent, ...manualOnly } = lamp()
    await repos.devices.save({ ...manualOnly, _id: other })

    const devices = await repos.devices.list()

    expect(devices).toHaveLength(2)
    for (const device of devices) expect(device.manualCode).toBe('34970112332')
    expect(devices.find((device) => device._id === LAMP)?.payload).toBe('MT:Y.K9042C00KA0648G00')
    expect('payload' in (devices.find((device) => device._id === other) ?? {})).toBe(false)
  })

  it('tombstoneStaysBare', async () => {
    const repos = projectRepositories(database, fixedClock('2026-08-20T10:00:00.000Z'), unlocked())
    const saved = await repos.devices.save(lamp())

    await repos.devices.remove(saved)

    const { rows } = await database.allDocs({ keys: [LAMP] })
    const value = (rows[0] as { value?: { rev: string; deleted?: boolean } }).value
    expect(value?.deleted).toBe(true)
    // The deleted revision itself: nothing but the tombstone — no secret, no ciphertext.
    const tombstone = await database.get(LAMP, { rev: value?.rev ?? '' })
    expect(tombstone).toEqual({ _id: LAMP, _rev: value?.rev, _deleted: true })
  })

  it('conflictMergeCarriesCiphertext', async () => {
    const { deviceA, server, deviceB } = replicas()
    const a = projectRepositories(
      deviceA,
      fixedClock('2026-08-20T10:00:00.000Z', '2026-08-20T11:00:00.000Z'),
      unlocked(),
    )
    const b = projectRepositories(deviceB, fixedClock('2026-08-20T10:30:00.000Z'), unlocked())

    await a.devices.save(lamp())
    await syncOnce(deviceA, server)
    await syncOnce(deviceB, server)

    // Two edits of the same revision, neither touching a secret, so the merge's `{...latest}`
    // carries the ciphertext as an opaque atom — or corrupts it, which is what this pins.
    const onB = await b.devices.get(LAMP)
    if (onB === undefined) throw new Error('device B never received the document')
    await b.devices.save({ ...onB, room: 'Cellar' })
    const onA = await a.devices.get(LAMP)
    if (onA === undefined) throw new Error('device A lost the document')
    await a.devices.save({ ...onA, name: 'Kitchen spotlight' })
    await reconnect({ deviceA, server, deviceB })

    const merged = await a.devices.get(LAMP)

    expect(merged?.name).toBe('Kitchen spotlight')
    expect(merged?.payload).toBe('MT:Y.K9042C00KA0648G00')
    expect(merged?.manualCode).toBe('34970112332')
    // The resolution wrote below the seam: what is stored is still ciphertext.
    expect((await rawDocument(deviceA, LAMP)).payload).toMatch(/^enc:v1:/)

    await Promise.all([deviceA.destroy(), server.destroy(), deviceB.destroy()])
  })
})

describe('the encryption seam, locked', () => {
  /** Stores one encrypted device, then reopens the same database locked. */
  async function seededLocked(): Promise<{
    locked: ProjectRepositories
    saved: DeviceDocument
  }> {
    const writer = projectRepositories(database, fixedClock('2026-08-20T10:00:00.000Z'), unlocked())
    const saved = await writer.devices.save(lamp())
    // As a provider rather than a value: the UI wiring resolves the key state lazily, so the
    // locked tests exercise that form of the argument.
    const locked = projectRepositories(database, fixedClock('2026-08-20T10:00:00.000Z'), () => ({
      kind: 'locked',
    }))
    return { locked, saved }
  }

  it('lockedReadsOmitSecrets', async () => {
    const { locked } = await seededLocked()

    const read = await locked.devices.get(LAMP)
    const listed = await locked.devices.list()

    for (const document of [read, ...listed]) {
      expect(document).toBeDefined()
      // Absent, not emptied: `'' as manualCode` would render as a device with a blank code.
      expect('payload' in (document ?? {})).toBe(false)
      expect('manualCode' in (document ?? {})).toBe(false)
      expect(document !== undefined && isLockedDocument(document)).toBe(true)
      // The whole contract in one line: no ciphertext reaches a consumer, under any key.
      expect(JSON.stringify(document)).not.toContain('enc:')
      expect(document?.name).toBe('Kitchen ceiling light')
    }
  })

  it('lockedWritesThrow', async () => {
    const { locked, saved } = await seededLocked()

    await expect(locked.devices.save(lamp())).rejects.toThrow(ProjectLockedError)
    await expect(locked.devices.saveKeepingUpdatedAt(saved)).rejects.toThrow(ProjectLockedError)
    await expect(locked.devices.remove(saved)).rejects.toThrow(ProjectLockedError)
    // Nothing was written: the stored document still holds its ciphertext, undisturbed.
    expect((await rawDocument(database, LAMP)).payload).toMatch(/^enc:v1:/)
  })

  // Found by F7: a document read while locked outlives the lock. Once the key arrives, the
  // cipher would encrypt what the stale read holds — which is no secrets at all — and the
  // device would be stored without its commissioning code. Silent, and unrecoverable.
  it('staleLockedReadIsRefusedAfterUnlock', async () => {
    const writer = projectRepositories(database, fixedClock('2026-08-20T10:00:00.000Z'), unlocked())
    await writer.devices.save(lamp())
    let state: KeyState = { kind: 'locked' }
    const repos = projectRepositories(database, fixedClock('2026-08-20T10:00:00.000Z'), () => state)
    const stale = await repos.devices.get(LAMP)
    if (stale === undefined) throw new Error('the seeded device is missing')
    expect(isLockedDocument(stale)).toBe(true)

    state = unlocked()

    // As a view would hand it over: the stale read with an edit spread onto it.
    const { updatedAt: _stamp, ...unsaved } = stale
    await expect(repos.devices.save({ ...unsaved, name: 'Renamed' })).rejects.toThrow(
      ProjectLockedError,
    )
    await expect(repos.devices.saveKeepingUpdatedAt(stale)).rejects.toThrow(ProjectLockedError)
    await expect(repos.devices.remove(stale)).rejects.toThrow(ProjectLockedError)
    const stored = await rawDocument(database, LAMP)
    expect(stored.payload).toMatch(/^enc:v1:/)
    expect(stored.manualCode).toMatch(/^enc:v1:/)
    expect(stored.name).toBe('Kitchen ceiling light')
    // A fresh read under the key is the way forward, and it carries the secrets again.
    const fresh = await repos.devices.get(LAMP)
    expect(fresh !== undefined && isLockedDocument(fresh)).toBe(false)
    expect(fresh?.payload).toBe(lamp().payload)
  })
})

// #333: nothing orders a pull so the `key:*` documents land before the `device:*` ones (a
// multi-shard `_changes` feed keeps no global order), and until they do the database is keyless
// — the plaintext state. Ciphertext met there must fail closed: read as locked, never handed on.
describe('the encryption seam, keyless over ciphertext', () => {
  /** Stores one encrypted device, then reopens the same database with no key state at all. */
  async function seededKeyless(): Promise<ProjectRepositories> {
    const writer = projectRepositories(database, fixedClock('2026-08-20T10:00:00.000Z'), unlocked())
    await writer.devices.save(lamp())
    return projectRepositories(database, fixedClock('2026-08-20T10:00:00.000Z'))
  }

  it('keylessCiphertextReadsLocked', async () => {
    const keyless = await seededKeyless()

    const read = await keyless.devices.get(LAMP)
    const listed = await keyless.devices.list()

    expect(listed).toHaveLength(1)
    for (const document of [read, ...listed]) {
      expect(document).toBeDefined()
      expect(document !== undefined && isLockedDocument(document)).toBe(true)
      expect('payload' in (document ?? {})).toBe(false)
      expect('manualCode' in (document ?? {})).toBe(false)
      // The bug in one line: before the fix, both secrets reached the consumer as `enc:v1:…`.
      expect(JSON.stringify(document)).not.toContain('enc:')
      expect(document?.name).toBe('Kitchen ceiling light')
    }
  })

  it('keylessCiphertextInOneFieldStillLocksTheDocument', async () => {
    // A device filed from a pairing code alone carries one secret, so one prefixed field is the
    // whole of the evidence — and it is enough.
    const writer = projectRepositories(database, fixedClock('2026-08-20T10:00:00.000Z'), unlocked())
    const { payload: _absent, ...manualOnly } = lamp()
    await writer.devices.save(manualOnly)
    const keyless = projectRepositories(database, fixedClock('2026-08-20T10:00:00.000Z'))

    const read = await keyless.devices.get(LAMP)

    expect(read !== undefined && isLockedDocument(read)).toBe(true)
    expect(JSON.stringify(read)).not.toContain('enc:')
  })

  it('keylessCiphertextWritesRefused', async () => {
    const keyless = await seededKeyless()
    const read = await keyless.devices.get(LAMP)
    if (read === undefined) throw new Error('the seeded device is missing')

    // As a view would hand it over: the locked read with an edit spread onto it. Before the
    // fix this stored the ciphertext strings back as if they were plaintext codes.
    const { updatedAt: _stamp, ...unsaved } = read
    await expect(keyless.devices.save({ ...unsaved, name: 'Renamed' })).rejects.toThrow(
      ProjectLockedError,
    )
    await expect(keyless.devices.saveKeepingUpdatedAt(read)).rejects.toThrow(ProjectLockedError)
    await expect(keyless.devices.remove(read)).rejects.toThrow(ProjectLockedError)
    const stored = await rawDocument(database, LAMP)
    expect(stored.name).toBe('Kitchen ceiling light')
    expect(stored.payload).toMatch(/^enc:v1:/)
    expect(stored.manualCode).toMatch(/^enc:v1:/)
  })

  it('keylessPlaintextStillReadsPlaintext', async () => {
    // The regression guard: "keyless = plaintext" stays true for a database that is plaintext —
    // one from before encryption existed, which decision 2 migrates nothing in.
    await repositories.devices.save(lamp())

    const read = await repositories.devices.get(LAMP)
    const [listed] = await repositories.devices.list()

    for (const document of [read, listed]) {
      expect(document !== undefined && isLockedDocument(document)).toBe(false)
      expect(document?.payload).toBe('MT:Y.K9042C00KA0648G00')
      expect(document?.manualCode).toBe('34970112332')
    }
  })

  // Review of #335: the winner is not the only revision a read can surface. Resolution merges
  // by `updatedAt`, so a ciphertext *losing* revision that is newer would win the merge and pass
  // through the keyless state as a code — and resolving it would write while unable to read it.
  /**
   * One device with two roots, written as replication writes them: a plaintext winner (the
   * higher revision id wins) and a newer ciphertext loser, which resolution's merge would pick.
   */
  async function seededCiphertextLoser(): Promise<void> {
    const plaintext = { ...lamp(), updatedAt: '2026-08-20T10:00:00.000Z' }
    const cipher = stubCipher()
    const encrypted = {
      ...lamp(),
      name: 'Kitchen spotlight',
      payload: await cipher.encrypt(LAMP, 'payload', lamp().payload ?? ''),
      manualCode: await cipher.encrypt(LAMP, 'manualCode', lamp().manualCode),
      updatedAt: '2026-08-20T11:00:00.000Z',
    }
    await database.bulkDocs(
      [
        { ...plaintext, _rev: '1-ffffffffffffffffffffffffffffffff' },
        { ...encrypted, _rev: '1-00000000000000000000000000000000' },
      ],
      { new_edits: false },
    )
  }

  it('keylessCiphertextInALosingRevisionLocksTheReadAndWritesNothing', async () => {
    await seededCiphertextLoser()
    const stored = (await database.get(LAMP, { conflicts: true })) as unknown as {
      payload: string
      _conflicts?: string[]
    }
    expect(stored.payload).toBe(lamp().payload)
    expect(stored._conflicts).toEqual(['1-00000000000000000000000000000000'])
    const { update_seq: before } = await database.info()

    const read = await repositories.devices.get(LAMP)
    const [listed] = await repositories.devices.list()

    for (const document of [read, listed]) {
      expect(document !== undefined && isLockedDocument(document)).toBe(true)
      expect(JSON.stringify(document)).not.toContain('enc:')
    }
    // Locked reads never write: no merge stored, no branch pruned.
    expect((await database.info()).update_seq).toBe(before)
    const after = (await database.get(LAMP, { conflicts: true })) as unknown as {
      _conflicts?: string[]
    }
    expect(after._conflicts).toEqual(['1-00000000000000000000000000000000'])
  })

  // #336: reads fail closed, but a device *created* in the same window carries no prefix and
  // used to go straight through "keyless = plaintext" — one plaintext secret at rest, for good.
  describe('a new device written while the database is keyless', () => {
    const OTHER = documentId('device', 'aaaaaaaa-0000-0000-0000-000000000000')
    const another = (): Unsaved<DeviceDocument> => ({ ...lamp(), _id: OTHER, name: 'Hall sensor' })
    const isStored = async (id: string): Promise<boolean> =>
      (await database.allDocs({ keys: [id] })).rows.some((row) => 'value' in row)

    it('is refused as locked once the database has served a ciphertext read', async () => {
      const keyless = await seededKeyless()
      await keyless.devices.list()

      await expect(keyless.devices.save(another())).rejects.toThrow(ProjectLockedError)
      expect(await isStored(OTHER)).toBe(false)
    })

    it('is refused in a fresh handle that has read nothing yet', async () => {
      // A new tab whose first act is a write: nothing has been read, so the one-time scan is
      // what knows the database is an encrypted project.
      const keyless = await seededKeyless()

      await expect(keyless.devices.save(another())).rejects.toThrow(ProjectLockedError)
      expect(await isStored(OTHER)).toBe(false)
    })

    it('is refused when the only ciphertext is a losing revision, before any read', async () => {
      // Review of #335 on 1e64655: a scan of winners alone answers "no ciphertext" here.
      await seededCiphertextLoser()
      const { update_seq: before } = await database.info()

      await expect(repositories.devices.save(another())).rejects.toThrow(ProjectLockedError)
      expect(await isStored(OTHER)).toBe(false)
      // The scan read the losing revision; it did not resolve or prune it.
      expect((await database.info()).update_seq).toBe(before)
    })

    it('is accepted in a genuinely plaintext database', async () => {
      await repositories.devices.save(lamp())
      await repositories.devices.list()

      const saved = await repositories.devices.save(another())

      expect((await rawDocument(database, OTHER)).manualCode).toBe(saved.manualCode)
    })

    it('is encrypted once the wraps arrive', async () => {
      const writer = projectRepositories(
        database,
        fixedClock('2026-08-20T10:00:00.000Z'),
        unlocked(),
      )
      await writer.devices.save(lamp())
      let state: KeyState | undefined
      const repos = projectRepositories(
        database,
        fixedClock('2026-08-20T10:00:00.000Z'),
        () => state,
      )
      await repos.devices.list()
      await expect(repos.devices.save(another())).rejects.toThrow(ProjectLockedError)

      state = unlocked()

      const saved = await repos.devices.save(another())
      expect(saved.manualCode).toBe('34970112332')
      expect((await rawDocument(database, OTHER)).manualCode).toMatch(/^enc:v1:/)
    })
  })

  it('keylessCiphertextUnlocksInPlaceWhenTheKeyArrives', async () => {
    const writer = projectRepositories(database, fixedClock('2026-08-20T10:00:00.000Z'), unlocked())
    await writer.devices.save(lamp())
    // The provider the UI hands the repositories: keyless now, unlocked once the wraps land.
    let state: KeyState | undefined
    const repos = projectRepositories(database, fixedClock('2026-08-20T10:00:00.000Z'), () => state)
    const before = await repos.devices.get(LAMP)
    expect(before !== undefined && isLockedDocument(before)).toBe(true)

    state = unlocked()

    const after = await repos.devices.get(LAMP)
    expect(after !== undefined && isLockedDocument(after)).toBe(false)
    expect(after?.payload).toBe('MT:Y.K9042C00KA0648G00')
    expect(after?.manualCode).toBe('34970112332')
  })
})
