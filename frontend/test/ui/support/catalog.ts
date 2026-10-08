import type { CatalogLookup } from '../../../src/domain/index.js'
import { encodePayload } from '../../../src/domain/index.js'
import type { CatalogApi, LookupOutcome } from '../../../src/ui/catalog.js'

/** The recorded Aqara answer (vendor 4447, model 4447/8194), as the API maps it. */
export const AQARA_LOOKUP: CatalogLookup = {
  vendorId: 4447,
  productId: 8194,
  source: 'dcl',
  vendor: {
    name: 'Aqara',
    preferredName: 'Aqara Home',
    legalName: 'Lumi United Technology Co., Ltd.',
    landingPageUrl: 'https://www.aqara.com/',
  },
  product: {
    name: 'Aqara Door and Window Sensor P2',
    label: 'Aqara Door and Window Sensor P2',
    partNumber: 'AS056',
    deviceTypeId: 21,
    productUrl: 'https://www.aqara.com/en/products.html',
    supportUrl: null,
    userManualUrl: null,
    commissioningCustomFlow: 0,
    commissioningCustomFlowUrl: null,
    commissioningInstructions: '1. Please make sure the sensor is powered.',
    factoryResetInstructions: null,
  },
  fetchedAt: '2026-10-05T16:20:00.000Z',
  stale: false,
}

/**
 * A real `MT:` payload for vendor 4447, product 8194, built by our own encoder.
 *
 * Encoded rather than written out so nobody has to trust a hand-copied Base38 string; the
 * reference passcode and discriminator are reused.
 */
export function aqaraPayload(): string {
  return encodePayload({
    version: 0,
    vendorId: 4447,
    productId: 8194,
    customFlow: 'standard',
    discovery: { softAp: false, ble: true, onNetwork: false, raw: 0b010 },
    discriminator: 3840,
    passcode: 20202021,
    extension: new Uint8Array(),
  })
}

/** A catalogue that records every call and answers with whatever the test says. */
export function fakeCatalog(answer: (code: string) => Promise<LookupOutcome>) {
  const calls: Array<{ readonly code: string; readonly signal: AbortSignal | undefined }> = []
  const api: CatalogApi = {
    lookup: (code, signal) => {
      calls.push({ code, signal })
      return answer(code)
    },
  }
  return { api, calls }
}

/** A promise the test settles by hand, for answers that must arrive at a chosen moment. */
export function deferred<T>() {
  let resolve: (value: T) => void = () => {}
  const promise = new Promise<T>((settle) => {
    resolve = settle
  })
  return { promise, resolve }
}
