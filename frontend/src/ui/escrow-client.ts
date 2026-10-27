/**
 * The escrow endpoints, and the startup pair that uses them (#301): register this browser's
 * device key, cache the escrow public key.
 *
 * Both run once per sign-in, fire-and-forget, behind the first `refreshed` outcome
 * (`app-shell.ts`). **Neither may ever block or fail sync**: a registration that did not land is
 * simply made again at the next startup (`PUT /profile/devicekeys` is idempotent), and a missing
 * escrow key only means a project created offline carries no escrow wrap until the next online
 * start. A 404 from `GET /escrowkey` is the feature being off server-side — the expected state
 * until the backend endpoints (B4/B5) are deployed — and is an answer, not an error.
 *
 * Like `profile.ts` and `projects.ts`, this module holds no PouchDB and no browser-only import,
 * so its tests run in Node; `composition.ts` wires the real cache, device key and token in.
 *
 * @module
 */

import type { CachedEscrowKey, LocalCache } from '../data/index.js'
import type { DeviceKey } from './db/device-key.js'

/** The escrow public key as `GET /escrowkey` answers it. */
export type EscrowKeyInfo = { kid: string; alg: string; publicKey: string }

/**
 * Whether a parsed body is an escrow key. Checked by shape at the trust boundary, as `isProfile`
 * does: a proxy's HTML page cached here would later be handed to the wrap path as a public key.
 */
export function isEscrowKeyInfo(body: unknown): body is EscrowKeyInfo {
  if (typeof body !== 'object' || body === null) return false
  const value = body as Record<string, unknown>
  return (
    typeof value.kid === 'string' &&
    typeof value.alg === 'string' &&
    typeof value.publicKey === 'string'
  )
}

/** How the escrow endpoints are reached. Injected so the startup pair tests without a server. */
export interface EscrowApi {
  /**
   * `PUT /profile/devicekeys` with this browser's public key — **and no kid**: the server
   * derives it from the SPKI itself (spec §Endpoints), which is what stops one member claiming
   * another's kid. With no token held, nothing is sent: the request could only earn a 401, and
   * the next startup, signed in, registers anyway.
   *
   * @throws on a response that is neither success nor 401 — the caller decides how quiet to be
   */
  registerDeviceKey(publicKeySpki: string): Promise<void>
  /**
   * `GET /escrowkey` — public, no auth. `null` on a 404, which is the escrow feature being off
   * server-side: an ordinary state, not a failure.
   */
  fetchEscrowKey(): Promise<EscrowKeyInfo | null>
}

/**
 * The API client, in the bearer-fetch style of `projects.ts`: the access token in an
 * `Authorization` header, both back ends addressed by path.
 */
export function escrowApi(
  baseUrl: string,
  token: () => string | undefined,
  fetchImpl: typeof fetch = fetch,
): EscrowApi {
  const base = baseUrl.replace(/\/+$/, '')

  return {
    async registerDeviceKey(publicKeySpki: string): Promise<void> {
      const held = token()
      if (held === undefined) return
      const response = await fetchImpl(`${base}/profile/devicekeys`, {
        method: 'PUT',
        headers: {
          'content-type': 'application/json',
          accept: 'application/json',
          authorization: `Bearer ${held}`,
        },
        body: JSON.stringify({ publicKey: publicKeySpki }),
      })
      // A 401 is "not signed in any more", an ordinary state here: the token died between the
      // `refreshed` outcome and this request landing. The next sign-in registers again.
      if (response.status === 401) return
      if (!response.ok) {
        throw new Error(`The device key could not be registered (${response.status}).`)
      }
    },

    async fetchEscrowKey(): Promise<EscrowKeyInfo | null> {
      const response = await fetchImpl(`${base}/escrowkey`, {
        headers: { accept: 'application/json' },
      })
      if (response.status === 404) return null
      if (!response.ok) throw new Error(`The escrow key could not be read (${response.status}).`)
      const body: unknown = await response.json()
      if (!isEscrowKeyInfo(body)) throw new Error('The escrow key answer was not one.')
      return { kid: body.kid, alg: body.alg, publicKey: body.publicKey }
    },
  }
}

/**
 * The escrow key as `mm-local` last cached it, or `null` when none has been heard — which is
 * what offline project creation branches on: with a key, write `key:escrow` now; without one,
 * leave it for the promote path (spec §Project keys).
 *
 * Never throws and never fetches: an unreadable cache, like an empty one, answers `null`, and
 * an entry an older or newer build wrote in a shape this one cannot read is treated the same —
 * the posture `cachedPlan` takes with the profile's plan.
 */
export async function cachedEscrowKey(cache: LocalCache): Promise<EscrowKeyInfo | null> {
  let stored: CachedEscrowKey | undefined
  try {
    stored = await cache.readEscrowKey()
  } catch {
    return null
  }
  if (stored === undefined || !isEscrowKeyInfo(stored)) return null
  return { kid: stored.kid, alg: stored.alg, publicKey: stored.publicKey }
}

/** What the startup pair needs. Injected so it tests without a server, a key store or PouchDB. */
export interface EscrowStartupDependencies {
  readonly api: EscrowApi
  readonly cache: LocalCache
  /** This browser's device key — `ensureDeviceKey` in the application, a fake in tests. */
  readonly deviceKey: () => Promise<DeviceKey>
  /** When the escrow key was fetched; this module holds no clock. */
  readonly now?: () => string
}

/**
 * The startup pair: ensure the device key is registered, and the escrow public key cached.
 *
 * The two halves are independent and each failure is its own: a backend without B4 yet must not
 * stop the escrow key being cached, and vice versa. **Never throws** — each half logs once and
 * is retried at the next sign-in, because nothing the user is doing depends on either landing
 * today, and sync must never wait on it.
 */
export async function prepareEscrowAtStartup(deps: EscrowStartupDependencies): Promise<void> {
  const { api, cache, deviceKey, now = () => new Date().toISOString() } = deps

  await Promise.all([
    (async () => {
      try {
        const key = await deviceKey()
        await api.registerDeviceKey(key.publicKeySpki)
      } catch (error) {
        console.warn('The device key was not registered; the next sign-in retries.', error)
      }
    })(),
    (async () => {
      try {
        const info = await api.fetchEscrowKey()
        if (info === null) return
        await cache.writeEscrowKey({ ...info, fetchedAt: now() })
      } catch (error) {
        console.warn('The escrow key was not cached; the next sign-in retries.', error)
      }
    })(),
  ])
}
