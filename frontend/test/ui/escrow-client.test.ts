import { afterEach, describe, expect, it, vi } from 'vitest'
import type { CachedEscrowKey, LocalCache } from '../../src/data/index.js'
import type { DeviceKey } from '../../src/ui/db/device-key.js'
import {
  cachedEscrowKey,
  type EscrowKeyInfo,
  escrowApi,
  prepareEscrowAtStartup,
} from '../../src/ui/escrow-client.js'

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
