import { describe, expect, it } from 'vitest'
import {
  DclUnavailable,
  dclClient,
  MAINNET_URL,
  networkOf,
  TESTNET_URL,
} from '../../src/catalog/dcl.js'
import { AQARA_MODEL, AQARA_ROUTES, AQARA_VENDOR, DCL_NOT_FOUND, fakeDcl } from '../support/dcl.js'

describe('dclClient reading the ledger', () => {
  it('returns the recorded Aqara vendor record as the DCL sent it', async () => {
    const dcl = fakeDcl(AQARA_ROUTES)
    expect(await dclClient(MAINNET_URL, dcl.fetch).vendor(4447)).toEqual(AQARA_VENDOR.vendorInfo)
  })

  it('returns the recorded Aqara model record as the DCL sent it', async () => {
    const dcl = fakeDcl(AQARA_ROUTES)
    expect(await dclClient(MAINNET_URL, dcl.fetch).model(4447, 8194)).toEqual(AQARA_MODEL.model)
  })

  it('asks by decimal IDs, under the base URL, and nothing else', async () => {
    // The only thing the DCL ever learns is these two numbers (ADR 0019).
    const dcl = fakeDcl(AQARA_ROUTES)
    const client = dclClient(`${MAINNET_URL}/`, dcl.fetch)
    await client.vendor(0x115f)
    await client.model(0x115f, 0x2002)
    expect(dcl.requests).toEqual(['/vendorinfo/vendors/4447', '/model/models/4447/8194'])
  })

  it("answers 'missing' for the DCL's real 404", async () => {
    const client = dclClient(MAINNET_URL, fakeDcl().fetch)
    expect(await client.vendor(4999)).toBe('missing')
    expect(await client.model(4447, 9999)).toBe('missing')
  })
})

describe('dclClient when the ledger cannot answer', () => {
  /** The rejection of one vendor read against these routes. */
  const vendorFailure = (routes: Parameters<typeof fakeDcl>[0], timeoutMs?: number) =>
    dclClient(MAINNET_URL, fakeDcl(routes).fetch, timeoutMs).vendor(4447)

  it('throws DclUnavailable when the network is down', async () => {
    await expect(
      vendorFailure({ '/vendorinfo/vendors/4447': new TypeError('fetch failed') }),
    ).rejects.toBeInstanceOf(DclUnavailable)
  })

  it('throws DclUnavailable for a 5xx that is not JSON', async () => {
    await expect(
      vendorFailure({
        '/vendorinfo/vendors/4447': { status: 502, body: '<html>Bad gateway</html>' },
      }),
    ).rejects.toBeInstanceOf(DclUnavailable)
  })

  it('throws DclUnavailable for a 5xx that is JSON', async () => {
    await expect(
      vendorFailure({ '/vendorinfo/vendors/4447': { status: 503, body: { code: 14 } } }),
    ).rejects.toBeInstanceOf(DclUnavailable)
  })

  it('throws DclUnavailable for a 404 that is not the DCL talking', async () => {
    // A proxy's 404, or a mistyped DCL_BASE_URL. Read as a miss, it would be cached for a day
    // and every device would come back "unknown" while the ledger is fine.
    await expect(
      vendorFailure({ '/vendorinfo/vendors/4447': { status: 404, body: '<html>nope</html>' } }),
    ).rejects.toBeInstanceOf(DclUnavailable)
    await expect(
      vendorFailure({ '/vendorinfo/vendors/4447': { status: 404, body: { message: 'no route' } } }),
    ).rejects.toBeInstanceOf(DclUnavailable)
  })

  it('throws DclUnavailable for a 200 that is not a vendor', async () => {
    for (const body of [{}, { vendorInfo: null }, { vendorInfo: { vendorID: '4447' } }, []]) {
      await expect(
        vendorFailure({ '/vendorinfo/vendors/4447': { status: 200, body } }),
      ).rejects.toBeInstanceOf(DclUnavailable)
    }
  })

  it('throws DclUnavailable for a 200 that is not a model', async () => {
    const client = dclClient(
      MAINNET_URL,
      fakeDcl({ '/model/models/4447/8194': { status: 200, body: { model: { vid: 4447 } } } }).fetch,
    )
    await expect(client.model(4447, 8194)).rejects.toBeInstanceOf(DclUnavailable)
  })

  it('throws DclUnavailable for a body far larger than any record', async () => {
    const huge = { vendorInfo: { ...AQARA_VENDOR.vendorInfo, padding: 'x'.repeat(300 * 1024) } }
    await expect(
      vendorFailure({ '/vendorinfo/vendors/4447': { status: 200, body: huge } }),
    ).rejects.toBeInstanceOf(DclUnavailable)
  })

  it('throws DclUnavailable for a vendor record under a different ID', async () => {
    // A wrong 200 would otherwise be cached under the requested ID for ninety days.
    const other = { vendorInfo: { ...AQARA_VENDOR.vendorInfo, vendorID: 4448 } }
    await expect(
      vendorFailure({ '/vendorinfo/vendors/4447': { status: 200, body: other } }),
    ).rejects.toBeInstanceOf(DclUnavailable)
  })

  it.each([
    ['vid', { vid: 4448 }],
    ['pid', { pid: 8195 }],
  ])('throws DclUnavailable for a model record under a different %s', async (_field, change) => {
    const other = { model: { ...AQARA_MODEL.model, ...change } }
    const client = dclClient(
      MAINNET_URL,
      fakeDcl({ '/model/models/4447/8194': { status: 200, body: other } }).fetch,
    )
    await expect(client.model(4447, 8194)).rejects.toBeInstanceOf(DclUnavailable)
  })

  it('stops reading a body that grows past the cap, without a content-length', async () => {
    // A chunked answer declares no length, so the cap has to hold while the body arrives: read
    // to the end first, and a hostile or broken server decides how much memory this takes.
    const chunk = new Uint8Array(64 * 1024).fill(0x20)
    let delivered = 0
    const endless = new ReadableStream<Uint8Array>({
      pull(controller) {
        delivered += chunk.byteLength
        // Ends eventually, so a client that reads it all fails the assertion rather than hangs.
        if (delivered > 16 * 1024 * 1024) controller.close()
        else controller.enqueue(chunk)
      },
    })
    const streaming = (async () => new Response(endless, { status: 200 })) as typeof fetch
    const error: unknown = await dclClient(MAINNET_URL, streaming)
      .vendor(4447)
      .catch((caught: unknown) => caught)
    expect(error).toBeInstanceOf(DclUnavailable)
    expect((error as Error).message).toContain('too large')
    expect(delivered).toBeLessThan(1024 * 1024)
  })

  it('refuses a declared content-length past the cap without reading the body', async () => {
    let read = false
    // A high-water mark of zero, so nothing is pulled until somebody reads.
    const body = new ReadableStream<Uint8Array>(
      {
        pull(controller) {
          read = true
          controller.close()
        },
      },
      { highWaterMark: 0 },
    )
    const declared = (async () =>
      new Response(body, {
        status: 200,
        headers: { 'content-length': String(10 * 1024 * 1024) },
      })) as typeof fetch
    const error: unknown = await dclClient(MAINNET_URL, declared)
      .vendor(4447)
      .catch((caught: unknown) => caught)
    expect(error).toBeInstanceOf(DclUnavailable)
    expect((error as Error).message).toContain('too large')
    expect(read).toBe(false)
  })

  it('throws DclUnavailable when the DCL does not answer in time', async () => {
    // A fetch that only ever ends by being aborted, which is what the timeout signal does.
    const hanging = ((_input: unknown, init?: RequestInit) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(init.signal?.reason))
      })) as typeof fetch
    await expect(dclClient(MAINNET_URL, hanging, 20).vendor(4447)).rejects.toBeInstanceOf(
      DclUnavailable,
    )
  })

  it('never puts the response body into the error message', async () => {
    const error: unknown = await vendorFailure({
      '/vendorinfo/vendors/4447': { status: 500, body: 'secret-ish upstream text' },
    }).then(
      () => undefined,
      (caught: unknown) => caught,
    )
    expect(error).toBeInstanceOf(DclUnavailable)
    expect((error as Error).message).not.toContain('secret-ish')
  })

  it('still treats the real not-found body as a miss, not an outage', async () => {
    expect(
      await vendorFailure({ '/vendorinfo/vendors/4447': { status: 404, body: DCL_NOT_FOUND } }),
    ).toBe('missing')
  })
})

describe('networkOf', () => {
  it.each([
    [MAINNET_URL, 'mainnet'],
    [`${MAINNET_URL}/`, 'mainnet'],
    [TESTNET_URL, 'testnet'],
    ['https://dcl.example.test/dcl', 'other'],
  ])('reads %s as %s', (url, network) => {
    expect(networkOf(url)).toBe(network)
  })
})
