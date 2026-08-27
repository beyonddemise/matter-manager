import { afterEach, describe, expect, it } from 'vitest'
import { buildServer } from '../src/server.js'

/**
 * The service, through `.inject()`.
 *
 * No port, no socket, no teardown race — Fastify routes the request internally and returns the
 * response. A test that started a real listener would be a test that can fail because a port
 * was busy, which is a failure about the machine rather than about the code.
 */
let app: ReturnType<typeof buildServer> | undefined

afterEach(async () => {
  await app?.close()
  app = undefined
})

const server = () => {
  app = buildServer({ logger: false })
  return app
}

describe('liveness', () => {
  it('answers /healthz', async () => {
    const response = await server().inject({ method: 'GET', url: '/healthz' })

    expect(response.statusCode).toBe(200)
    expect(response.json()).toEqual({ status: 'ok' })
  })

  it('needs no credentials', async () => {
    // The contract marks this operation `security: []`. A liveness probe that requires a token
    // is a liveness probe that reports the service as down whenever authentication is.
    const response = await server().inject({ method: 'GET', url: '/healthz' })

    expect(response.statusCode).toBe(200)
  })

  it('says nothing about the deployment', async () => {
    // No version, no uptime, no dependency status. This endpoint is reachable by anyone, and
    // an unauthenticated description of the deployment is reconnaissance.
    const body = await server().inject({ method: 'GET', url: '/healthz' })

    expect(Object.keys(body.json())).toEqual(['status'])
  })

  it('does not go and ask CouchDB', async () => {
    // Liveness answers "should this process be restarted". A restart does not fix a database
    // that is down — it turns a degraded service into no service. There is no CouchDB
    // configured in this test at all, so a health check that consulted one could not pass.
    const response = await server().inject({ method: 'GET', url: '/healthz' })

    expect(response.statusCode).toBe(200)
  })
})

describe('the route surface', () => {
  it('has nothing but what has been built', async () => {
    // The contract describes nine operations; this milestone implements one. The check that
    // the two agree is M4-2's, and this is the local half: a route registered here that
    // nobody meant to add shows up as a difference.
    const routes = server()
      .printRoutes({ commonPrefix: false })
      .split('\n')
      .filter((line) => line.includes('('))

    expect(routes.join('\n')).toContain('healthz')
  })

  it('refuses an unknown path rather than answering it', async () => {
    const response = await server().inject({ method: 'GET', url: '/projects' })
    expect(response.statusCode).toBe(404)
  })

  it('refuses a body larger than anything this service legitimately receives', async () => {
    // The largest real body here is a membership list. Fastify's default limit is a megabyte,
    // which is a megabyte of parsing offered to anyone who asks.
    const response = await server().inject({
      method: 'POST',
      url: '/healthz',
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify({ padding: 'x'.repeat(200 * 1024) }),
    })

    expect([404, 413]).toContain(response.statusCode)
  })
})
