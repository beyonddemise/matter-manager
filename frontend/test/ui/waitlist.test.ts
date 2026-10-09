import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { Profile } from '../../src/ui/profile.js'
import { forgetTokens, rememberAccessToken } from '../../src/ui/tokens.js'
import { waitlistApi } from '../../src/ui/waitlist.js'

const WAITING: Profile = {
  sub: 'google|1234',
  email: 'ada@example.com',
  displayName: 'Ada',
  locale: 'auto',
  plan: 'free',
  projectLimit: 1,
  planRequested: 'pro',
  requestedAt: '2026-10-09T08:00:00.000Z',
}

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

const headersOf = (init: RequestInit | undefined) => (init?.headers ?? {}) as Record<string, string>

beforeEach(() => rememberAccessToken({ accessToken: 'tok', expiresIn: 3600 }))
afterEach(() => forgetTokens())

describe('waitlistApi', () => {
  it('joins with a PUT carrying the plan as JSON, with the bearer token', async () => {
    const { calls, fetchImpl } = answering(json(200, WAITING))

    const outcome = await waitlistApi('/api/', fetchImpl).join('pro')

    expect(outcome).toEqual({ kind: 'done', profile: WAITING })
    expect(calls[0]?.url).toBe('/api/waitlist')
    expect(calls[0]?.init?.method).toBe('PUT')
    expect(JSON.parse(String(calls[0]?.init?.body))).toEqual({ plan: 'pro' })
    expect(headersOf(calls[0]?.init)).toMatchObject({
      authorization: 'Bearer tok',
      'content-type': 'application/json',
    })
  })

  it('leaves with a DELETE that has no body and no JSON content type', async () => {
    // The API refuses an *empty* body labelled JSON with a 400, so neither may be sent.
    const { calls, fetchImpl } = answering(json(200, { ...WAITING, planRequested: undefined }))

    await waitlistApi('/api', fetchImpl).leave()

    expect(calls[0]?.init?.method).toBe('DELETE')
    expect(calls[0]?.init?.body).toBeUndefined()
    expect(headersOf(calls[0]?.init)).not.toHaveProperty('content-type')
    expect(headersOf(calls[0]?.init).authorization).toBe('Bearer tok')
  })

  it('answers signed-out without a request when no token is held', async () => {
    forgetTokens()
    const { calls, fetchImpl } = answering(json(200, WAITING))

    expect(await waitlistApi('/api', fetchImpl).join('pro')).toEqual({ kind: 'signed-out' })
    expect(calls).toHaveLength(0)
  })

  it.each([
    [401, { kind: 'signed-out' }],
    [409, { kind: 'already-on-plan' }],
    [400, { kind: 'unavailable' }],
    [500, { kind: 'unavailable' }],
    [503, { kind: 'unavailable' }],
  ])('answers %i as %j, decided by the status', async (status, expected) => {
    const { fetchImpl } = answering(json(status, { title: 'Already on this plan', status }))

    expect(await waitlistApi('/api', fetchImpl).join('member')).toEqual(expected)
  })

  it('answers unavailable, without throwing, when the network fails', async () => {
    const { fetchImpl } = answering(new TypeError('fetch failed'))

    await expect(waitlistApi('/api', fetchImpl).join('pro')).resolves.toEqual({
      kind: 'unavailable',
    })
    await expect(waitlistApi('/api', fetchImpl).leave()).resolves.toEqual({ kind: 'unavailable' })
  })

  it('answers unavailable for a 200 that is not a profile', async () => {
    const html = new Response('<html>', { status: 200, headers: { 'content-type': 'text/html' } })
    expect(await waitlistApi('/api', answering(html).fetchImpl).join('pro')).toEqual({
      kind: 'unavailable',
    })
    expect(
      await waitlistApi('/api', answering(json(200, { sub: 1 })).fetchImpl).join('pro'),
    ).toEqual({
      kind: 'unavailable',
    })
  })
})
