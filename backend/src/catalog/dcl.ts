/**
 * The CSA's Distributed Compliance Ledger, as far as this service asks it anything.
 *
 * Two reads, both unauthenticated: a vendor by ID, and a model by vendor and product ID. **Only
 * those IDs are ever sent** — the DCL is a third party, and the rule that a payload never goes to
 * one still holds for it (ADR 0019). Nothing in this module can see a setup code: its inputs are
 * numbers.
 *
 * Native `fetch`, injected so tests answer as the DCL without reaching it (ADR 0013), and a
 * five-second timeout, because a lookup is on the path of somebody adding a device.
 *
 * @module
 */

/** MainNet, the ledger production devices are certified on. */
export const MAINNET_URL = 'https://on.dcl.csa-iot.org/dcl'
/** TestNet, for trying a deployment against records nobody relies on. */
export const TESTNET_URL = 'https://on.test-net.dcl.csa-iot.org/dcl'

/** Which ledger a cached record came from, so a switch of `DCL_BASE_URL` is visible in the data. */
export type DclNetwork = 'mainnet' | 'testnet' | 'other'

/** How long one DCL request may take, including its body, before it counts as unreachable. */
export const DCL_TIMEOUT_MS = 5000

/**
 * The largest DCL response body this service reads, in bytes.
 *
 * A vendor or model record is about a kilobyte. The DCL is a third party, and an answer a
 * thousand times larger than any real one is not a record worth parsing.
 */
const MAX_BODY_BYTES = 256 * 1024

/** A vendor record as the DCL holds it. Kept raw; `policy.ts` decides what the API exposes. */
export interface DclVendor {
  readonly vendorID: number
  readonly vendorName: string
  readonly companyLegalName?: string
  readonly companyPreferredName?: string
  readonly vendorLandingPageURL?: string
  readonly [field: string]: unknown
}

/** A model record as the DCL holds it. Kept raw, for the reason {@link DclVendor} is. */
export interface DclModel {
  readonly vid: number
  readonly pid: number
  readonly productName: string
  readonly [field: string]: unknown
}

/** The DCL could not give an answer: unreachable, slow, failing, or answering nonsense. */
export class DclUnavailable extends Error {
  override readonly name = 'DclUnavailable'
}

/** The two reads. A 404 is an answer — `'missing'` — and anything else unusable throws. */
export interface DclClient {
  /** Which ledger this client reads, recorded on every cached entry. */
  readonly network: DclNetwork
  vendor(vid: number): Promise<DclVendor | 'missing'>
  model(vid: number, pid: number): Promise<DclModel | 'missing'>
}

/** Which ledger a base URL points at. */
export function networkOf(baseUrl: string): DclNetwork {
  const base = baseUrl.replace(/\/+$/, '')
  if (base === MAINNET_URL) return 'mainnet'
  if (base === TESTNET_URL) return 'testnet'
  return 'other'
}

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

/** Thrown inside {@link readCapped}, and turned into {@link DclUnavailable} by its caller. */
class BodyTooLarge extends Error {}

/**
 * A response body as text, refusing it **while it arrives** once it passes `maxBytes`.
 *
 * Why not `response.text()` and a length check after: a chunked answer declares no length, so
 * that would buffer whatever the server chose to send before the check ever ran. Reading chunk
 * by chunk means memory is bounded by the cap plus one chunk, whoever is on the other end.
 *
 * @param response the response whose body to read; a missing body reads as `''`.
 * @param maxBytes the most bytes accepted.
 * @throws {BodyTooLarge} once more than `maxBytes` have arrived; the stream is cancelled.
 */
async function readCapped(response: Response, maxBytes: number): Promise<string> {
  if (response.body === null) return ''
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    total += value.byteLength
    if (total > maxBytes) {
      // Its own failure is ignored: the body is being abandoned either way.
      await reader.cancel().catch(() => undefined)
      throw new BodyTooLarge()
    }
    chunks.push(value)
  }
  return new TextDecoder().decode(Buffer.concat(chunks))
}

/**
 * Builds the client.
 *
 * @param baseUrl the DCL REST base, e.g. {@link MAINNET_URL}; a trailing slash is tolerated.
 * @param fetchImpl injected so tests drive it without the network.
 * @param timeoutMs injected so the timeout test does not wait five seconds.
 */
export function dclClient(
  baseUrl: string,
  fetchImpl: typeof fetch = fetch,
  timeoutMs: number = DCL_TIMEOUT_MS,
): DclClient {
  const base = baseUrl.replace(/\/+$/, '')

  /**
   * One GET, and its JSON body; `'missing'` for the DCL's own "not found".
   *
   * Every failure becomes {@link DclUnavailable} with a message naming the path and status and
   * **never the body**: it is a third party's text, and the route decides between a stale entry
   * and a 503 on the class alone.
   */
  async function get(path: string): Promise<unknown> {
    let status: number
    let text: string
    try {
      // One signal for the request *and* the body: a server that sends headers promptly and
      // then trickles the body is as unreachable as one that never answers.
      const response = await fetchImpl(`${base}${path}`, {
        headers: { accept: 'application/json' },
        signal: AbortSignal.timeout(timeoutMs),
      })
      status = response.status
      // A declared length past the cap is refused before a byte of the body is read.
      if (Number(response.headers.get('content-length') ?? '0') > MAX_BODY_BYTES) {
        await response.body?.cancel().catch(() => undefined)
        throw new BodyTooLarge()
      }
      text = await readCapped(response, MAX_BODY_BYTES)
    } catch (error) {
      if (error instanceof BodyTooLarge) throw new DclUnavailable(`DCL ${path}: body too large`)
      throw new DclUnavailable(`DCL ${path}: unreachable`, { cause: error })
    }

    let body: unknown
    try {
      body = JSON.parse(text) as unknown
    } catch {
      throw new DclUnavailable(`DCL ${path}: answered ${status} with something that is not JSON`)
    }

    // **Only the DCL's own not-found is a miss**: a 404 carrying `code: 5`. A 404 from anything
    // else — a proxy, a mistyped `DCL_BASE_URL` — would otherwise cache every product in the
    // world as missing for a day, and answer "unknown device" while the ledger is fine.
    if (status === 404 && isObject(body) && body.code === 5) return 'missing'
    if (status !== 200) throw new DclUnavailable(`DCL ${path}: answered ${status}`)
    return body
  }

  return {
    network: networkOf(base),

    async vendor(vid: number): Promise<DclVendor | 'missing'> {
      const path = `/vendorinfo/vendors/${vid}`
      const body = await get(path)
      if (body === 'missing') return 'missing'
      const record = isObject(body) ? body.vendorInfo : undefined
      // A 200 that does not hold a vendor is a ledger answering something else, not a vendor
      // with no name. Treated as an outage, so a cached entry is served rather than overwritten.
      // That includes **another** vendor: cached under the requested ID, it would name every
      // device of this vendor wrongly for ninety days.
      if (!isObject(record) || record.vendorID !== vid || typeof record.vendorName !== 'string') {
        throw new DclUnavailable(`DCL ${path}: answered an unexpected shape`)
      }
      return record as DclVendor
    },

    async model(vid: number, pid: number): Promise<DclModel | 'missing'> {
      const path = `/model/models/${vid}/${pid}`
      const body = await get(path)
      if (body === 'missing') return 'missing'
      const record = isObject(body) ? body.model : undefined
      if (
        !isObject(record) ||
        record.vid !== vid ||
        record.pid !== pid ||
        typeof record.productName !== 'string'
      ) {
        throw new DclUnavailable(`DCL ${path}: answered an unexpected shape`)
      }
      return record as DclModel
    },
  }
}
