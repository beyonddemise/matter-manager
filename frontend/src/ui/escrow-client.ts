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
 * The third use is recovery (#304): a project that opens locked asks `POST /escrow` to re-wrap
 * its key for this device ({@link recoverProjectKey}), pull-first and with a single retry on a
 * stale document. `ui/db/project-database.ts` triggers it; `composition.ts` binds the pull.
 *
 * Like `profile.ts` and `projects.ts`, this module holds no PouchDB and no browser-only import,
 * so its tests run in Node; `composition.ts` wires the real cache, device key and token in.
 *
 * @module
 */

import type { CachedEscrowKey, LocalCache } from '../data/index.js'
import { PROJECT_DOCUMENT_ID } from '../domain/documents/project.js'
import type { DeviceKey } from './db/device-key.js'
import { type KeyringDependencies, unlockProject } from './db/keyring.js'

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
  /**
   * `POST /escrow {document, deviceKeyId}` — asks the server to re-wrap the project's DEK for
   * this device (spec endpoint 3). With no token held, nothing is sent and the answer is
   * `refused`: the request could only earn a 401.
   *
   * @param document this browser's copy of the project document, freshly pulled — the server
   *   compares it with its own (decision 5)
   * @throws on a network failure or a 5xx — not a refusal, and the caller decides how quiet to be
   */
  rewrap(document: object, deviceKeyId: string): Promise<RewrapOutcome>
}

/**
 * What `POST /escrow` answered, as recovery branches on it:
 *
 * - `rewrapped` — 204, the wrap for this device is on the server now; a pull brings it here.
 * - `document-mismatch` — 409 naming that reason: the posted copy is stale, and one re-pull fixes it.
 * - `refused` — any other 4xx: not a member, an unregistered kid, no escrow wrap to unwrap.
 *   Nothing asking again right now could change, so recovery stops.
 */
export type RewrapOutcome = 'rewrapped' | 'document-mismatch' | 'refused'

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

    async rewrap(document: object, deviceKeyId: string): Promise<RewrapOutcome> {
      const held = token()
      if (held === undefined) return 'refused'
      const response = await fetchImpl(`${base}/escrow`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          accept: 'application/problem+json, application/json',
          authorization: `Bearer ${held}`,
        },
        body: JSON.stringify({ document, deviceKeyId }),
      })
      if (response.ok) return 'rewrapped'
      if (response.status >= 500) {
        throw new Error(`The project key could not be recovered (${response.status}).`)
      }
      // Branched on the problem's `reason`, never its title (the contract's `Problem` schema):
      // a body that is missing or not JSON reads as a plain refusal, which stops recovery
      // rather than retrying on a guess.
      if (response.status === 409) {
        const body = (await response.json().catch(() => undefined)) as
          | { reason?: unknown }
          | undefined
        if (body?.reason === 'document-mismatch') return 'document-mismatch'
      }
      return 'refused'
    },
  }
}

/** What escrow recovery reaches outside the database it is handed. Injected, so tests own it. */
export interface RecoveryDependencies {
  /** The escrow endpoints; only the re-wrap is used. */
  readonly api: Pick<EscrowApi, 'rewrap'>
  /**
   * One pull of this project from the server into the database (`pullOnce` in the application).
   * Rejects when the server cannot be reached, which recovery lets through.
   */
  readonly pull: () => Promise<unknown>
  /** Whether a request can be made now: online, and signed in. Checked before anything is sent. */
  readonly reachable: () => boolean
  /** The device key, for the unlock and for the kid the server wraps for. */
  readonly keyring: KeyringDependencies
  /**
   * Resolves once this device's key is registered with the server (`PUT /profile/devicekeys`);
   * rejects when it could not be. Awaited before `POST /escrow` only — a kid the server does not
   * know yet earns `400 unknown-device-key`, which is exactly the race on a brand-new device's
   * first sign-in, when the startup registration is still in flight. See
   * {@link sharedDeviceKeyRegistration}.
   */
  readonly ensureRegistered: () => Promise<void>
}

/**
 * One device key registration per access token, shared by every caller that needs it.
 *
 * The startup pair and escrow recovery both need the key registered, and on a brand-new device
 * they run at the same moment: recovery must wait on the startup request, not race it or send
 * a second one. So the first call starts `PUT /profile/devicekeys` and every caller until it
 * settles shares that promise; a success is kept **for the token it was made with** — a new
 * token may be another account signing in on this page, whose user record has never seen the
 * key (the PUT is idempotent, so registering again is harmless). A failure is forgotten, so the
 * next caller tries again rather than inheriting a stale rejection.
 *
 * @returns a function that resolves once registered, and rejects — without a request — while no
 *   token is held, or when the registration fails
 */
export function sharedDeviceKeyRegistration(
  api: Pick<EscrowApi, 'registerDeviceKey'>,
  deviceKey: () => Promise<DeviceKey>,
  token: () => string | undefined,
): () => Promise<void> {
  let memo: { token: string; registration: Promise<void> } | undefined
  return () => {
    const held = token()
    if (held === undefined) {
      return Promise.reject(new Error('The device key cannot be registered while signed out.'))
    }
    if (memo?.token === held) return memo.registration
    const registration = (async () => {
      const key = await deviceKey()
      await api.registerDeviceKey(key.publicKeySpki)
    })()
    const entry = { token: held, registration }
    memo = entry
    registration.catch(() => {
      if (memo === entry) memo = undefined
    })
    return registration
  }
}

/** The project document as this copy holds it, or `undefined` when it has none to prove. */
async function readProjectDocument(database: PouchDB.Database): Promise<object | undefined> {
  try {
    return await database.get(PROJECT_DOCUMENT_ID)
  } catch (error) {
    if ((error as { status?: unknown }).status === 404) return undefined
    throw error
  }
}

/**
 * Recovers a locked project's key through escrow (spec §Project keys, "Missing wrap"; #304).
 *
 * The protocol, in the order that matters:
 *
 * 1. **Pull first.** The wrap may already be on the server — an earlier attempt's, or one
 *    another session asked for — and then there is nothing to ask for: the unlock that follows
 *    succeeds and **no request is made**.
 * 2. Still locked → `POST /escrow` with the **freshly pulled** `project` document: the server
 *    compares it with its own copy and `_rev` (decision 5), so a copy from before the pull
 *    would be refused as stale. The post first waits for this device's key registration
 *    (`ensureRegistered`); a registration that failed means no post and `false`.
 * 3. 204 → pull again (the server wrote `key:<kid>` into its copy) and unlock.
 * 4. 409 `document-mismatch` → the document moved between pull and post: re-pull and post
 *    **exactly once** more. Stale local metadata must not leave an online project locked, and
 *    must not become a loop either.
 * 5. Any other refusal → `false`. The project stays locked; the next open tries again.
 *
 * @returns whether the project now unlocks on this device
 * @throws when the pull or the request fails outright (offline mid-way, a 5xx), or the wrap
 *   that arrived does not unwrap — the caller logs it; the project simply stays locked
 */
export async function recoverProjectKey(
  database: PouchDB.Database,
  deps: RecoveryDependencies,
): Promise<boolean> {
  const { api, pull, reachable, keyring, ensureRegistered } = deps
  // Offline or signed out: nothing could succeed, so nothing is attempted — not even the pull.
  if (!reachable()) return false

  await pull()
  if ((await unlockProject(database, keyring)) !== null) return true

  // Only the post waits on the registration; the pull and the unlock retry above did not. A
  // registration that failed would make the post a doomed `400 unknown-device-key`, so it is
  // not sent: the project stays locked and the next open retries.
  try {
    await ensureRegistered()
  } catch {
    return false
  }
  const { kid } = await keyring.deviceKey()
  for (let attempt = 0; attempt < 2; attempt += 1) {
    if (attempt > 0) await pull()
    const document = await readProjectDocument(database)
    // No project document means nothing to prove membership with: a copy that never received
    // one cannot be re-wrapped, and asking would only earn a refusal.
    if (document === undefined) return false
    const outcome = await api.rewrap(document, kid)
    if (outcome === 'rewrapped') {
      await pull()
      return (await unlockProject(database, keyring)) !== null
    }
    if (outcome === 'refused') return false
  }
  return false
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
  /**
   * The registration to run, shared with escrow recovery ({@link sharedDeviceKeyRegistration}),
   * so a locked open on a brand-new device waits on this very request instead of racing it.
   * Without one, the startup pair registers directly.
   */
  readonly register?: () => Promise<void>
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
  const register =
    deps.register ??
    (async () => {
      const key = await deviceKey()
      await api.registerDeviceKey(key.publicKeySpki)
    })

  await Promise.all([
    (async () => {
      try {
        await register()
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
