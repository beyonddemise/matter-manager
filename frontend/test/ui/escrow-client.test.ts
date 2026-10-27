import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import type { CachedEscrowKey, LocalCache } from '../../src/data/index.js'
import { encodeBase64 } from '../../src/domain/crypto/base64.js'
import { deriveKid, generateDek, wrapDek } from '../../src/domain/crypto/envelope.js'
import { projectKeyDocumentId } from '../../src/domain/documents/keys.js'
import { PROJECT_DOCUMENT_ID } from '../../src/domain/documents/project.js'
import type { DeviceKey } from '../../src/ui/db/device-key.js'
import {
  type KeyringDependencies,
  resolveKeyState,
  unlockProject,
} from '../../src/ui/db/keyring.js'
import {
  cachedEscrowKey,
  type EscrowKeyInfo,
  escrowApi,
  prepareEscrowAtStartup,
  recoverProjectKey,
} from '../../src/ui/escrow-client.js'
import { memoryDatabase } from '../data/support/memory-database.js'

/** The escrow key as `GET /escrowkey` would answer it (B5); tests stub the network throughout. */
const ESCROW_KEY: EscrowKeyInfo = {
  kid: 'c'.repeat(64),
  alg: 'RSA-OAEP-256',
  publicKey: 'ZXNjcm93LXNwa2k=',
}

/** This browser's device key, faked: nothing here runs WebCrypto or IndexedDB. */
const DEVICE_KEY: DeviceKey = {
  kid: 'd'.repeat(64),
  publicKeySpki: 'ZGV2aWNlLXNwa2k=',
  privateKey: {} as CryptoKey,
}

/** The rest of `mm-local`, which nothing in this file touches — throwing keeps that honest. */
const unused = async (): Promise<never> => {
  throw new Error('the escrow tests use no other part of the cache')
}

/** A cache backed by a variable, so a test can start it full, empty or broken. */
function fakeCache(initial?: CachedEscrowKey, broken = false) {
  let stored = initial
  const writes: CachedEscrowKey[] = []
  const cache: LocalCache = {
    readProfile: unused,
    writeProfile: unused,
    clearProfile: unused,
    readPlanMatrix: unused,
    writePlanMatrix: unused,
    readProjects: unused,
    writeProjects: unused,
    setLocalState: unused,
    markAccessRemoved: unused,
    readLocalProjects: unused,
    addLocalProject: unused,
    updateLocalProject: unused,
    removeLocalProject: unused,
    clear: unused,
    async readEscrowKey() {
      if (broken) throw new Error('the cache is unreadable')
      return stored
    },
    async writeEscrowKey(cached) {
      writes.push(cached)
      stored = cached
    },
  }
  return { cache, writes }
}

/** A fetch that answers by status and body, recording every request it sees. */
function fakeFetch(
  answer: (url: string, init?: RequestInit) => { status: number; body?: unknown },
) {
  const calls: { url: string; init?: RequestInit }[] = []
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    calls.push({ url, ...(init === undefined ? {} : { init }) })
    const { status, body } = answer(url, init)
    return { ok: status < 400, status, json: async () => body } as Response
  }) as typeof fetch
  return { fetchImpl, calls }
}

/** A fetch that never reaches the server — the stubbed-out network of the offline tests. */
const noNetwork = (() => {
  throw new Error('nothing may fetch here')
}) as typeof fetch

const startupDeps = (fetchImpl: typeof fetch, cache: LocalCache) => ({
  api: escrowApi('/api', () => 'token-1', fetchImpl),
  cache,
  deviceKey: async () => DEVICE_KEY,
  now: () => '2026-10-27T09:00:00.000Z',
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('registering the device key at startup', () => {
  it('registersOnStartupWhenOnline', async () => {
    const { cache } = fakeCache()
    const { fetchImpl, calls } = fakeFetch((url) =>
      url.endsWith('/escrowkey') ? { status: 200, body: ESCROW_KEY } : { status: 204 },
    )

    await prepareEscrowAtStartup(startupDeps(fetchImpl, cache))

    const put = calls.find((call) => call.init?.method === 'PUT')
    expect(put?.url).toBe('/api/profile/devicekeys')
    const headers = (put?.init?.headers ?? {}) as Record<string, string>
    expect(headers.authorization).toBe('Bearer token-1')
    const body = JSON.parse(String(put?.init?.body)) as Record<string, unknown>
    // The public key and nothing else: the server derives the kid itself (spec §Endpoints), so
    // a client-supplied one would at best be ignored and at worst be trusted.
    expect(body).toEqual({ publicKey: DEVICE_KEY.publicKeySpki })
    expect(Object.keys(body)).not.toContain('kid')
  })

  it('sends nothing while no token is held', async () => {
    // Between a token's expiry and its refresh the request could only earn a 401; like
    // `profile.read`, not asking is the same answer without the round trip.
    const { fetchImpl, calls } = fakeFetch(() => ({ status: 204 }))

    await escrowApi('/api', () => undefined, fetchImpl).registerDeviceKey(DEVICE_KEY.publicKeySpki)

    expect(calls).toHaveLength(0)
  })

  it('never blocks startup on a registration that fails', async () => {
    // The network is down, or the backend predates B4: the startup pair resolves anyway, logs
    // once, and the next sign-in simply tries again — nothing waits on the server for this.
    const warned = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const { cache, writes } = fakeCache()
    const failing = (async () => {
      throw new TypeError('network down')
    }) as typeof fetch

    await expect(prepareEscrowAtStartup(startupDeps(failing, cache))).resolves.toBeUndefined()

    expect(warned).toHaveBeenCalled()
    expect(writes).toHaveLength(0)
  })
})

describe('caching the escrow key', () => {
  it('cachesEscrowKeyForOffline', async () => {
    // Fetched once while online, then served from `mm-local` with the network stubbed out —
    // which is what lets a project be created in a basement (spec §Device key).
    const { cache, writes } = fakeCache()
    const { fetchImpl } = fakeFetch((url) =>
      url.endsWith('/escrowkey') ? { status: 200, body: ESCROW_KEY } : { status: 204 },
    )

    await prepareEscrowAtStartup(startupDeps(fetchImpl, cache))

    expect(writes).toEqual([{ ...ESCROW_KEY, fetchedAt: '2026-10-27T09:00:00.000Z' }])
    expect(await cachedEscrowKey(cache)).toEqual(ESCROW_KEY)
  })

  it('toleratesEscrowDisabled', async () => {
    // A 404 is the feature being off server-side, not a failure: `null`, no throw, and nothing
    // cached — which is what makes this shippable before the backend endpoints exist.
    const { cache, writes } = fakeCache()
    const { fetchImpl } = fakeFetch((url) =>
      url.endsWith('/escrowkey') ? { status: 404 } : { status: 204 },
    )

    await expect(escrowApi('/api', () => 'token-1', fetchImpl).fetchEscrowKey()).resolves.toBeNull()

    await prepareEscrowAtStartup(startupDeps(fetchImpl, cache))
    expect(writes).toHaveLength(0)
    expect(await cachedEscrowKey(cache)).toBeNull()
  })

  it('refuses to cache a body that is not an escrow key', async () => {
    // A proxy's HTML error page parsed as JSON, or a newer server's different shape: cached, it
    // would be handed to the wrap path as a public key. Checked at the trust boundary, as
    // `isProfile` does.
    const warned = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const { cache, writes } = fakeCache()
    const { fetchImpl } = fakeFetch(() => ({ status: 200, body: { oops: true } }))

    await prepareEscrowAtStartup(startupDeps(fetchImpl, cache))

    expect(writes).toHaveLength(0)
    expect(warned).toHaveBeenCalled()
  })

  it('answers nothing from an empty or unreadable cache', async () => {
    expect(await cachedEscrowKey(fakeCache().cache)).toBeNull()
    // An unreadable cache is a reason to go online for the key, not a reason to crash a startup.
    expect(await cachedEscrowKey(fakeCache(undefined, true).cache)).toBeNull()
  })

  it('serves the cached key without touching the network', async () => {
    const stored = { ...ESCROW_KEY, fetchedAt: '2026-10-26T00:00:00.000Z' }
    const { cache } = fakeCache(stored)
    // `cachedEscrowKey` takes no fetch at all; `noNetwork` documents what offline means here.
    expect(noNetwork).toBeDefined()

    expect(await cachedEscrowKey(cache)).toEqual(ESCROW_KEY)
  })

  it('answers nothing for a cache entry this build cannot read as a key', async () => {
    // Whatever an older or newer build wrote: the reader's shape guard decides, the posture
    // `CachedProfile` takes with `plan`.
    const junk = { kid: 42, alg: 'RSA-OAEP-256', fetchedAt: 'x' } as unknown as CachedEscrowKey
    expect(await cachedEscrowKey(fakeCache(junk).cache)).toBeNull()
  })
})

/**
 * Escrow recovery on a locked open (#304), over an in-memory PouchDB standing in for this
 * browser's copy, a real RSA pair standing in for the device key, and a stubbed network: `pull`
 * plays the server's replication into the copy, the fetch stub plays `POST /escrow`.
 */
describe('recovering a locked project through escrow', () => {
  const NOW = '2026-10-28T09:00:00.000Z'
  /** A kid in the right shape that belongs to some other device of the project. */
  const FOREIGN_KID = 'f'.repeat(64)

  let device: DeviceKey
  let keyring: KeyringDependencies
  /** The project's DEK, wrapped for this device — what the server writes on a 204. */
  let ownWrap: { _id: string; type: string; kid: string; alg: string; wrapped: string }

  beforeAll(async () => {
    const pair = await crypto.subtle.generateKey(
      {
        name: 'RSA-OAEP',
        modulusLength: 3072,
        publicExponent: new Uint8Array([0x01, 0x00, 0x01]),
        hash: 'SHA-256',
      },
      false,
      ['wrapKey', 'unwrapKey'],
    )
    const spki = encodeBase64(new Uint8Array(await crypto.subtle.exportKey('spki', pair.publicKey)))
    device = { kid: await deriveKid(spki), publicKeySpki: spki, privateKey: pair.privateKey }
    keyring = { deviceKey: async () => device, now: () => NOW }
    ownWrap = {
      _id: projectKeyDocumentId(device.kid),
      type: 'projectKey',
      kid: device.kid,
      alg: 'RSA-OAEP-256',
      wrapped: await wrapDek(await generateDek(), spki),
    }
  })

  const databases: PouchDB.Database[] = []
  afterEach(async () => {
    await Promise.all(databases.splice(0).map((database) => database.destroy()))
  })

  /** This browser's copy of a server project, locked: a wrap exists, none for this device. */
  async function lockedCopy(): Promise<PouchDB.Database> {
    const database = memoryDatabase()
    databases.push(database)
    await database.put({
      _id: PROJECT_DOCUMENT_ID,
      type: 'project',
      name: 'Villa Rosa',
      serverDb: 'project_6ba7b810',
    })
    await database.put({
      _id: projectKeyDocumentId(FOREIGN_KID),
      type: 'projectKey',
      kid: FOREIGN_KID,
      alg: 'RSA-OAEP-256',
      wrapped: 'AAAA',
      createdAt: NOW,
    })
    return database
  }

  /** The server's `project` document moving on: a rename lands in the copy on the next pull. */
  async function renameProject(database: PouchDB.Database, name: string): Promise<void> {
    const current = await database.get(PROJECT_DOCUMENT_ID)
    await database.put({ ...current, name })
  }

  /** The re-wrap arriving: what the next pull brings once the server answered 204. */
  async function deliverOwnWrap(database: PouchDB.Database): Promise<void> {
    await database.put({ ...ownWrap, createdAt: NOW })
  }

  /** A scripted `pull`: each call runs the next step against the copy, and is counted. */
  function scriptedPull(
    database: PouchDB.Database,
    ...steps: ((db: PouchDB.Database) => Promise<void>)[]
  ) {
    let count = 0
    const pull = async (): Promise<void> => {
      const step = steps[count]
      count += 1
      await step?.(database)
    }
    return { pull, pulls: () => count }
  }

  /** `POST /escrow` answering a scripted status per request; every other request is an error. */
  function escrowFetch(...answers: { status: number; body?: unknown }[]) {
    return fakeFetch((url, init) => {
      if (!url.endsWith('/escrow') || init?.method !== 'POST') {
        throw new Error(`unexpected request ${init?.method ?? 'GET'} ${url}`)
      }
      return answers.shift() ?? { status: 500 }
    })
  }

  const posted = (call: { init?: RequestInit } | undefined) =>
    JSON.parse(String(call?.init?.body)) as {
      document: { _id: string; _rev: string; name: string }
      deviceKeyId: string
    }

  const MISMATCH = {
    status: 409,
    body: { type: 'about:blank', title: 'Conflict', status: 409, reason: 'document-mismatch' },
  }

  it('pullsBeforePosting', async () => {
    const database = await lockedCopy()
    // The first pull brings a rename the server already has: the posted copy must be that one,
    // or the server's comparison (spec endpoint 3, step 2) refuses it as stale.
    const { pull } = scriptedPull(
      database,
      (db) => renameProject(db, 'Villa Rosa (renovated)'),
      deliverOwnWrap,
    )
    const { fetchImpl, calls } = escrowFetch({ status: 204 })

    const recovered = await recoverProjectKey(database, {
      api: escrowApi('/api', () => 'token-1', fetchImpl),
      pull,
      reachable: () => true,
      keyring,
    })

    expect(recovered).toBe(true)
    expect(calls).toHaveLength(1)
    const pulledRev = (await database.get(PROJECT_DOCUMENT_ID))._rev
    const body = posted(calls[0])
    expect(body.document._rev).toBe(pulledRev)
    expect(body.document.name).toBe('Villa Rosa (renovated)')
    expect(body.deviceKeyId).toBe(device.kid)
    const headers = (calls[0]?.init?.headers ?? {}) as Record<string, string>
    expect(headers.authorization).toBe('Bearer token-1')
  })

  it('unlocksWithoutPostWhenWrapArrivesOnPull', async () => {
    const database = await lockedCopy()
    // Another of this user's sessions (or an earlier attempt) already had the wrap made: the
    // first pull delivers it, and there is nothing to ask the server for.
    const { pull, pulls } = scriptedPull(database, deliverOwnWrap)
    const { fetchImpl, calls } = escrowFetch()

    const recovered = await recoverProjectKey(database, {
      api: escrowApi('/api', () => 'token-1', fetchImpl),
      pull,
      reachable: () => true,
      keyring,
    })

    expect(recovered).toBe(true)
    expect(calls).toHaveLength(0)
    expect(pulls()).toBe(1)
  })

  it('recoversTransparently', async () => {
    const database = await lockedCopy()
    expect(await resolveKeyState(database, keyring)).toEqual({ kind: 'locked' })
    const { pull, pulls } = scriptedPull(database, async () => {}, deliverOwnWrap)
    const { fetchImpl, calls } = escrowFetch({ status: 204 })

    const recovered = await recoverProjectKey(database, {
      api: escrowApi('/api', () => 'token-1', fetchImpl),
      pull,
      reachable: () => true,
      keyring,
    })

    expect(recovered).toBe(true)
    expect(calls).toHaveLength(1)
    // Pull, post, pull: the 204 means the wrap is on the server, and only a pull brings it here.
    expect(pulls()).toBe(2)
    expect(await unlockProject(database, keyring)).not.toBeNull()
    expect((await resolveKeyState(database, keyring))?.kind).toBe('unlocked')
  })

  it('retriesOnceOnDocumentMismatch', async () => {
    const database = await lockedCopy()
    // The document moved between the first pull and the post: the 409 earns one re-pull, which
    // brings the rename, and one more post with the fresh copy.
    const { pull, pulls } = scriptedPull(
      database,
      async () => {},
      (db) => renameProject(db, 'Villa Rosa (renamed meanwhile)'),
      deliverOwnWrap,
    )
    const { fetchImpl, calls } = escrowFetch(MISMATCH, { status: 204 })

    const recovered = await recoverProjectKey(database, {
      api: escrowApi('/api', () => 'token-1', fetchImpl),
      pull,
      reachable: () => true,
      keyring,
    })

    expect(recovered).toBe(true)
    expect(calls).toHaveLength(2)
    expect(pulls()).toBe(3)
    const first = posted(calls[0])
    const second = posted(calls[1])
    expect(second.document._rev).not.toBe(first.document._rev)
    expect(second.document._rev).toBe((await database.get(PROJECT_DOCUMENT_ID))._rev)
    expect(second.document.name).toBe('Villa Rosa (renamed meanwhile)')
  })

  it('retries a mismatch exactly once, never in a loop', async () => {
    const database = await lockedCopy()
    const { pull } = scriptedPull(database)
    const { fetchImpl, calls } = escrowFetch(MISMATCH, MISMATCH, { status: 204 })

    const recovered = await recoverProjectKey(database, {
      api: escrowApi('/api', () => 'token-1', fetchImpl),
      pull,
      reachable: () => true,
      keyring,
    })

    expect(recovered).toBe(false)
    expect(calls).toHaveLength(2)
    expect(await unlockProject(database, keyring)).toBeNull()
  })

  it('staysLockedOn4xx', async () => {
    const database = await lockedCopy()
    const { pull, pulls } = scriptedPull(database)
    // A 403, and a 409 that names some other refusal: neither is fixed by asking again now.
    for (const answer of [{ status: 403 }, { status: 409, body: { reason: 'other' } }]) {
      const { fetchImpl, calls } = escrowFetch(answer, { status: 204 })

      const recovered = await recoverProjectKey(database, {
        api: escrowApi('/api', () => 'token-1', fetchImpl),
        pull,
        reachable: () => true,
        keyring,
      })

      expect(recovered).toBe(false)
      expect(calls).toHaveLength(1)
    }
    expect(pulls()).toBe(2)
    expect(await unlockProject(database, keyring)).toBeNull()
  })

  it('offlineDoesNotCall', async () => {
    const database = await lockedCopy()
    const { pull, pulls } = scriptedPull(database, deliverOwnWrap)

    const recovered = await recoverProjectKey(database, {
      api: escrowApi('/api', () => 'token-1', noNetwork),
      pull,
      reachable: () => false,
      keyring,
    })

    expect(recovered).toBe(false)
    // Not even the pull: offline, it could only fail, and the project is simply locked.
    expect(pulls()).toBe(0)
  })

  it('sends no re-wrap request while no token is held', async () => {
    const { fetchImpl, calls } = escrowFetch({ status: 204 })

    const outcome = await escrowApi('/api', () => undefined, fetchImpl).rewrap(
      { _id: PROJECT_DOCUMENT_ID },
      device.kid,
    )

    expect(outcome).toBe('refused')
    expect(calls).toHaveLength(0)
  })

  it('throws on a server failure, so the caller can tell it from a refusal', async () => {
    const { fetchImpl } = escrowFetch({ status: 503 })

    await expect(
      escrowApi('/api', () => 'token-1', fetchImpl).rewrap(
        { _id: PROJECT_DOCUMENT_ID },
        device.kid,
      ),
    ).rejects.toThrow(/503/)
  })

  it('answers false for a copy with no project document to prove', async () => {
    const database = memoryDatabase()
    databases.push(database)
    await database.put({ ...ownWrap, _id: projectKeyDocumentId(FOREIGN_KID), kid: FOREIGN_KID })
    const { pull } = scriptedPull(database)
    const { fetchImpl, calls } = escrowFetch({ status: 204 })

    const recovered = await recoverProjectKey(database, {
      api: escrowApi('/api', () => 'token-1', fetchImpl),
      pull,
      reachable: () => true,
      keyring,
    })

    expect(recovered).toBe(false)
    expect(calls).toHaveLength(0)
  })
})
