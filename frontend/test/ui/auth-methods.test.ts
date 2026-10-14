import { describe, expect, it } from 'vitest'
import { type AuthMethods, authMethodsApi, isAuthMethods } from '../../src/ui/auth-methods.js'

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

const answering = (response: Response | Error) =>
  (async () => {
    if (response instanceof Error) throw response
    return response
  }) as unknown as typeof fetch

const ALL: AuthMethods = { google: true, github: true, email: true, passkeys: true }

describe('whether a body is an auth-methods answer', () => {
  it('accepts the contract shape', () => {
    expect(isAuthMethods(ALL)).toBe(true)
    expect(isAuthMethods({ google: true, github: false, email: false })).toBe(true)
  })

  it.each([
    ['a proxy error page', '<html>'],
    ['null', null],
    ['a missing flag', { google: true, github: true }],
    ['a flag that is not a boolean', { ...ALL, github: 'yes' }],
    ['a passkeys flag that is not a boolean', { ...ALL, passkeys: 'yes' }],
  ])('refuses %s', (_name, body) => {
    expect(isAuthMethods(body)).toBe(false)
  })

  it('accepts and keeps a passkeys flag', () => {
    expect(isAuthMethods({ ...ALL, passkeys: true })).toBe(true)
  })
})

describe('authMethodsApi', () => {
  it('reads GET /auth/methods, without a token', async () => {
    let asked: string | undefined
    const api = authMethodsApi('/api', ((url: string) => {
      asked = url
      return Promise.resolve(json(200, ALL))
    }) as unknown as typeof fetch)
    expect(await api.read()).toEqual(ALL)
    expect(asked).toBe('/api/auth/methods')
  })

  it('accepts an answer without the passkeys flag, reading it as false', async () => {
    const api = authMethodsApi(
      '/api',
      answering(json(200, { google: true, github: true, email: true })),
    )
    expect(await api.read()).toEqual({ google: true, github: true, email: true, passkeys: false })
  })

  it.each([
    ['a 404 from an older API', json(404, { title: 'Not Found' })],
    ['a 500', json(500, {})],
    ['a 200 that is not the shape', json(200, { methods: ['google'] })],
    ['a network failure', new TypeError('fetch failed')],
  ])('answers undefined, without throwing, for %s', async (_name, response) => {
    await expect(authMethodsApi('/api', answering(response)).read()).resolves.toBeUndefined()
  })
})
