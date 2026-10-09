/**
 * The DCL, as recorded from the live MainNet API on 2026-10-05, and a fake `fetch` that answers
 * with it.
 *
 * Recorded rather than invented, so the mapping is tested against the shape the ledger really
 * sends — including its habit of `""` and `0` for "not set". `creator` is shortened; nothing
 * reads it, and the store drops it.
 *
 * @module
 */

/** `GET /vendorinfo/vendors/4447`. */
export const AQARA_VENDOR = {
  vendorInfo: {
    vendorID: 4447,
    vendorName: 'Aqara',
    companyLegalName: 'Lumi United Technology Co., Ltd.',
    companyPreferredName: '',
    vendorLandingPageURL: 'https://www.aqara.com/',
    creator: 'cosmos1qpz3',
    schemaVersion: 0,
  },
}

/** `GET /model/models/4447/8194`. */
export const AQARA_MODEL = {
  model: {
    vid: 4447,
    pid: 8194,
    deviceTypeId: 21,
    productName: 'Aqara Door and Window Sensor P2',
    productLabel: 'Aqara Door and Window Sensor P2',
    partNumber: 'AS056',
    commissioningCustomFlow: 0,
    commissioningCustomFlowUrl: '',
    commissioningModeInitialStepsHint: 0,
    commissioningModeInitialStepsInstruction:
      '1. Please make sure you have the Matter-compatible app',
    commissioningModeSecondaryStepsHint: 0,
    commissioningModeSecondaryStepsInstruction: '',
    userManualUrl: '',
    supportUrl: '',
    productUrl: 'https://www.aqara.com/en/products.html',
    lsfUrl: 'https://www.aqara.com/en/products.html',
    lsfRevision: 2,
    creator: 'cosmos1',
    schemaVersion: 0,
    enhancedSetupFlowOptions: 0,
    maintenanceUrl: '',
    discoveryCapabilitiesBitmask: 0,
    commissioningFallbackUrl: '',
    factoryResetStepsHint: 0,
    factoryResetStepsInstruction: '',
  },
}

/** The DCL's not-found body, served with HTTP 404. */
export const DCL_NOT_FOUND = { code: 5, message: 'not found', details: [] }

/** One recorded answer: a status and a body, JSON unless it is a string. */
export interface Recorded {
  readonly status: number
  readonly body: unknown
}

/** A fake DCL: the URLs it was asked for, and the `fetch` to inject. */
export interface FakeDcl {
  readonly requests: string[]
  readonly fetch: typeof fetch
}

/**
 * A `fetch` answering from `routes`, keyed by path below the base URL (`/vendorinfo/vendors/4447`).
 *
 * An unknown path answers the DCL's real 404, which is what the ledger does for an ID nobody
 * registered. A route set to an `Error` rejects with it, the way `fetch` does when the network
 * is down.
 */
export function fakeDcl(routes: Readonly<Record<string, Recorded | Error>> = {}): FakeDcl {
  const requests: string[] = []
  const fakeFetch = async (input: string | URL | Request): Promise<Response> => {
    const url = new URL(
      typeof input === 'string' ? input : input instanceof URL ? input.href : input.url,
    )
    const path = url.pathname.replace(/^\/dcl/, '')
    requests.push(path)
    const answer = routes[path] ?? { status: 404, body: DCL_NOT_FOUND }
    if (answer instanceof Error) throw answer
    const text = typeof answer.body === 'string' ? answer.body : JSON.stringify(answer.body)
    return new Response(text, { status: answer.status })
  }
  return { requests, fetch: fakeFetch as typeof fetch }
}

/** The Aqara vendor and model, as the DCL answers them. */
export const AQARA_ROUTES: Readonly<Record<string, Recorded>> = {
  '/vendorinfo/vendors/4447': { status: 200, body: AQARA_VENDOR },
  '/model/models/4447/8194': { status: 200, body: AQARA_MODEL },
}
