import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { CachedBillingOffer, LocalCache } from '../../src/data/index.js'
import {
  type BillingApi,
  billingApi,
  canCharge,
  isBilling,
  type OfferOutcome,
  resolveBillingOffer,
} from '../../src/ui/billing.js'
import { forgetTokens, rememberAccessToken } from '../../src/ui/tokens.js'

/** A `fetch` that answers every call with `response`, recording what it was asked. */
function answering(response: Response | Error) {
  const calls: Array<{ url: string; init: RequestInit | undefined }> = []
  const fetchImpl = (async (url: string, init?: RequestInit) => {
    calls.push({ url, init })
    if (response instanceof Error) throw response
    return response
  }) as unknown as typeof fetch
  return { calls, fetchImpl }
}

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

const problem = (status: number) =>
  new Response(JSON.stringify({ title: 'x', status }), {
    status,
    headers: { 'content-type': 'application/problem+json' },
  })

const headersOf = (init: RequestInit | undefined) => (init?.headers ?? {}) as Record<string, string>

beforeEach(() => rememberAccessToken({ accessToken: 'tok', expiresIn: 3600 }))
afterEach(() => forgetTokens())

describe('the billing offer', () => {
  it('reads GET /billing with the bearer token and answers the plans on sale', async () => {
    const { calls, fetchImpl } = answering(json(200, { plans: ['member', 'pro'] }))
    const outcome = await billingApi('/api/', fetchImpl).offer()
    expect(outcome).toEqual({ kind: 'offer', plans: ['member', 'pro'] })
    expect(calls[0]?.url).toBe('/api/billing')
    expect(calls[0]?.init?.method ?? 'GET').toBe('GET')
    expect(headersOf(calls[0]?.init)).toMatchObject({ authorization: 'Bearer tok' })
  })

  it('reads a 404 as nothing for sale: the deployment has no Stripe', async () => {
    const { fetchImpl } = answering(problem(404))
    expect(await billingApi('/api', fetchImpl).offer()).toEqual({ kind: 'none' })
  })

  it('leaves out a plan this build cannot sell, rather than refusing the list', async () => {
    const { fetchImpl } = answering(json(200, { plans: ['free', 'enterprise', 'pro'] }))
    expect(await billingApi('/api', fetchImpl).offer()).toEqual({ kind: 'offer', plans: ['pro'] })
  })

  it.each([
    ['a 401', problem(401)],
    ['a 503', problem(503)],
    ['a network failure', new TypeError('offline')],
    ['a body that is not an offer', json(200, { plans: 'pro' })],
    ['a proxy page', new Response('<html></html>', { status: 200 })],
  ])('answers unknown for %s, so the cached answer stands', async (_, response) => {
    const { fetchImpl } = answering(response)
    expect(await billingApi('/api', fetchImpl).offer()).toEqual({ kind: 'unknown' })
  })

  it('asks nothing without a token', async () => {
    forgetTokens()
    const { calls, fetchImpl } = answering(json(200, { plans: ['pro'] }))
    expect(await billingApi('/api', fetchImpl).offer()).toEqual({ kind: 'unknown' })
    expect(calls).toHaveLength(0)
  })
})

describe('starting a checkout', () => {
  it('POSTs the plan as JSON and answers the Stripe page to go to', async () => {
    const url = 'https://checkout.stripe.com/c/pay/cs_test_1'
    const { calls, fetchImpl } = answering(json(200, { url }))
    const outcome = await billingApi('/api', fetchImpl).checkout('pro')
    expect(outcome).toEqual({ kind: 'redirect', url })
    expect(calls[0]?.url).toBe('/api/billing/checkout')
    expect(calls[0]?.init?.method).toBe('POST')
    expect(JSON.parse(String(calls[0]?.init?.body))).toEqual({ plan: 'pro' })
    expect(headersOf(calls[0]?.init)).toMatchObject({
      authorization: 'Bearer tok',
      'content-type': 'application/json',
    })
  })

  it.each([
    [401, 'signed-out'],
    [409, 'already-subscribed'],
    [429, 'rate-limited'],
    [404, 'not-offered'],
    [400, 'not-offered'],
    [503, 'unavailable'],
    [500, 'unavailable'],
  ])('reads a %i as %s', async (status, kind) => {
    const { fetchImpl } = answering(problem(status))
    expect(await billingApi('/api', fetchImpl).checkout('member')).toEqual({ kind })
  })

  it.each([
    ['not https', { url: 'http://checkout.stripe.com/x' }],
    ['a script URL', { url: 'javascript:alert(1)' }],
    ['not a URL', { url: 'nowhere' }],
    ['no URL', {}],
  ])('refuses a session URL that is %s', async (_, body) => {
    const { fetchImpl } = answering(json(200, body))
    expect(await billingApi('/api', fetchImpl).checkout('pro')).toEqual({ kind: 'unavailable' })
  })

  it('answers unavailable for a network failure', async () => {
    const { fetchImpl } = answering(new TypeError('offline'))
    expect(await billingApi('/api', fetchImpl).checkout('pro')).toEqual({ kind: 'unavailable' })
  })

  it('answers signed-out without a token, asking nothing', async () => {
    forgetTokens()
    const { calls, fetchImpl } = answering(json(200, { url: 'https://x.example/' }))
    expect(await billingApi('/api', fetchImpl).checkout('pro')).toEqual({ kind: 'signed-out' })
    expect(calls).toHaveLength(0)
  })
})

describe('opening the portal', () => {
  it('POSTs with no body and answers the portal page', async () => {
    const url = 'https://billing.stripe.com/p/session/test_1'
    const { calls, fetchImpl } = answering(json(200, { url }))
    expect(await billingApi('/api', fetchImpl).portal()).toEqual({ kind: 'redirect', url })
    expect(calls[0]?.url).toBe('/api/billing/portal')
    expect(calls[0]?.init?.method).toBe('POST')
    expect(calls[0]?.init?.body).toBeUndefined()
    expect(headersOf(calls[0]?.init)['content-type']).toBeUndefined()
  })

  it('reads its 409 as no billing account, not as already subscribed', async () => {
    const { fetchImpl } = answering(problem(409))
    expect(await billingApi('/api', fetchImpl).portal()).toEqual({ kind: 'no-billing-account' })
  })
})

describe('the subscription on the profile', () => {
  it('accepts what the contract describes', () => {
    expect(isBilling({ status: 'active', cancelAtPeriodEnd: false })).toBe(true)
    expect(
      isBilling({
        status: 'past_due',
        currentPeriodEnd: '2026-12-01T00:00:00Z',
        cancelAtPeriodEnd: true,
      }),
    ).toBe(true)
  })

  it.each([
    ['no status', { cancelAtPeriodEnd: false }],
    ['an unknown status', { status: 'lapsed', cancelAtPeriodEnd: false }],
    ['no cancellation flag', { status: 'active' }],
    [
      'a date that is not a string',
      { status: 'active', cancelAtPeriodEnd: false, currentPeriodEnd: 1 },
    ],
    ['null', null],
  ])('refuses %s', (_, value) => {
    expect(isBilling(value)).toBe(false)
  })

  it('says which subscriptions can still charge, as the backend refuses a second checkout', () => {
    for (const status of [
      'active',
      'trialing',
      'past_due',
      'unpaid',
      'incomplete',
      'paused',
    ] as const)
      expect(canCharge({ status, cancelAtPeriodEnd: false })).toBe(true)
    for (const status of ['canceled', 'incomplete_expired'] as const)
      expect(canCharge({ status, cancelAtPeriodEnd: false })).toBe(false)
    expect(canCharge(undefined)).toBe(false)
  })
})

/** The slice of {@link LocalCache} the offer uses, over a variable. */
function fakeCache(initial?: CachedBillingOffer, broken?: 'read' | 'write') {
  let stored = initial
  const writes: CachedBillingOffer[] = []
  const cache = {
    async readBillingOffer() {
      if (broken === 'read') throw new Error('unreadable')
      return stored
    },
    async writeBillingOffer(next: CachedBillingOffer) {
      if (broken === 'write') throw new Error('refused')
      writes.push(next)
      stored = next
    },
  } as unknown as LocalCache
  return { cache, writes }
}

const api = (outcome: OfferOutcome): BillingApi => ({
  offer: async () => outcome,
  checkout: async () => ({ kind: 'unavailable' }),
  portal: async () => ({ kind: 'unavailable' }),
})

const NOW = () => '2026-11-24T10:00:00.000Z'

describe('resolveBillingOffer', () => {
  it('answers the cache first, then the server when it differs, and caches the server', async () => {
    const { cache, writes } = fakeCache({ plans: ['pro'], fetchedAt: 'then' })
    const heard: unknown[] = []
    await resolveBillingOffer(
      api({ kind: 'offer', plans: ['member', 'pro'] }),
      cache,
      (p) => heard.push(p),
      NOW,
    )
    expect(heard).toEqual([['pro'], ['member', 'pro']])
    expect(writes).toEqual([{ plans: ['member', 'pro'], fetchedAt: NOW() }])
  })

  it('does not repeat an answer the cache already gave', async () => {
    const { cache } = fakeCache({ plans: ['pro'], fetchedAt: 'then' })
    const heard: unknown[] = []
    await resolveBillingOffer(api({ kind: 'offer', plans: ['pro'] }), cache, (p) => heard.push(p))
    expect(heard).toEqual([['pro']])
  })

  it('caches a 404 as nothing for sale, so a deployment that drops Stripe stops offering it', async () => {
    const { cache, writes } = fakeCache({ plans: ['pro'], fetchedAt: 'then' })
    const heard: unknown[] = []
    await resolveBillingOffer(api({ kind: 'none' }), cache, (p) => heard.push(p), NOW)
    expect(heard).toEqual([['pro'], []])
    expect(writes).toEqual([{ plans: [], fetchedAt: NOW() }])
  })

  it('keeps the cached answer when the server cannot say', async () => {
    const { cache, writes } = fakeCache({ plans: ['pro'], fetchedAt: 'then' })
    const heard: unknown[] = []
    await resolveBillingOffer(api({ kind: 'unknown' }), cache, (p) => heard.push(p))
    expect(heard).toEqual([['pro']])
    expect(writes).toEqual([])
  })

  it('ignores a cached document another build wrote in another shape', async () => {
    const { cache } = fakeCache({ plans: 'pro', fetchedAt: 'then' })
    const heard: unknown[] = []
    await resolveBillingOffer(api({ kind: 'unknown' }), cache, (p) => heard.push(p))
    expect(heard).toEqual([])
  })

  it('never throws on a cache that cannot be read or written', async () => {
    const heard: unknown[] = []
    await resolveBillingOffer(
      api({ kind: 'offer', plans: ['pro'] }),
      fakeCache(undefined, 'read').cache,
      (p) => heard.push(p),
    )
    await resolveBillingOffer(
      api({ kind: 'offer', plans: ['pro'] }),
      fakeCache(undefined, 'write').cache,
      (p) => heard.push(p),
    )
    expect(heard).toEqual([['pro'], ['pro']])
  })
})
