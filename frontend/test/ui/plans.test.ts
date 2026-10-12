import { describe, expect, it } from 'vitest'
import type { CachedPlanMatrix, LocalCache } from '../../src/data/index.js'
import {
  isPlanMatrix,
  type PlanMatrix,
  type PlansApi,
  plansApi,
  resolvePlanMatrix,
} from '../../src/ui/plans.js'

/** The backend's own test fixture, pivoted: see `PlansResourceTest` in matter-manager-backend. */
const MATRIX: PlanMatrix = {
  free: { Projects: 1, Price: 'Free forever' },
  home: { Projects: 3, Price: 'Announced at launch' },
  pro: { Projects: 'Unlimited*', Price: 'Announced at launch' },
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

/**
 * The slice of {@link LocalCache} the matrix uses, over a variable. Everything else throws, so
 * a resolver that starts reading projects or the profile fails by name.
 */
function fakeCache(initial?: CachedPlanMatrix, broken?: 'read' | 'write') {
  let stored = initial
  const writes: CachedPlanMatrix[] = []
  const unused = (): never => {
    throw new Error('the plan matrix tests use no other part of the cache')
  }
  const cache: LocalCache = {
    readProfile: unused,
    writeProfile: unused,
    readProjects: unused,
    writeProjects: unused,
    setLocalState: unused,
    markAccessRemoved: unused,
    readLocalProjects: unused,
    addLocalProject: unused,
    updateLocalProject: unused,
    removeLocalProject: unused,
    clear: unused,
    async readPlanMatrix() {
      if (broken === 'read') throw new Error('the cache is unreadable')
      return stored
    },
    async writePlanMatrix(cached) {
      if (broken === 'write') throw new Error('the cache refuses the write')
      writes.push(cached)
      stored = cached
    },
  }
  return { cache, writes }
}

/** Lets a test wait for the background correction without knowing how long it takes. */
const settled = () => new Promise((resolve) => setTimeout(resolve, 0))

describe('whether a body is a plan matrix', () => {
  it('accepts the published shape, numbers and display strings alike', () => {
    expect(isPlanMatrix(MATRIX)).toBe(true)
  })

  it.each([
    ['a proxy error page', '<html>'],
    ['null', null],
    ['an array', [MATRIX]],
    ['an empty matrix, which gives the dialog nothing to show', {}],
    ['a plan whose rows are not an object', { free: 'cheap' }],
    ['a plan holding an array', { free: ['Projects'] }],
    ['a value that is neither text nor a number', { free: { Projects: { max: 1 } } }],
    ['a number no cell can display', { free: { Projects: Number.NaN } }],
  ])('refuses %s', (_name, body) => {
    expect(isPlanMatrix(body)).toBe(false)
  })
})

describe('plansApi', () => {
  it('reads the matrix from GET /plans, without a token', async () => {
    const { calls, fetchImpl } = answering(json(200, MATRIX))

    expect(await plansApi('/api/', fetchImpl).read()).toEqual(MATRIX)
    expect(calls[0]?.url).toBe('/api/plans')
    // Public marketing copy, shown before anyone signs in: no authorization header.
    expect((calls[0]?.init?.headers ?? {}) as Record<string, string>).not.toHaveProperty(
      'authorization',
    )
  })

  it.each([
    ['a 404 while nothing is published', json(404, { title: 'No plan matrix' })],
    ['a 500', json(500, {})],
    ['a 200 that is not a matrix', json(200, { free: 'cheap' })],
    [
      'a 200 that is not JSON at all',
      new Response('<html>', { status: 200, headers: { 'content-type': 'text/html' } }),
    ],
    ['a network failure', new TypeError('fetch failed')],
  ])('answers undefined, without throwing, for %s', async (_name, response) => {
    const { fetchImpl } = answering(response)

    await expect(plansApi('/api', fetchImpl).read()).resolves.toBeUndefined()
  })
})

describe('resolving the matrix, cache first', () => {
  const api = (answer: PlanMatrix | undefined): PlansApi => ({ read: async () => answer })

  it('answers the cached matrix at once and corrects the cache in the background', async () => {
    const { cache, writes } = fakeCache({ matrix: MATRIX, fetchedAt: '2026-10-11T00:00:00.000Z' })
    const changed = { ...MATRIX, pro: { Projects: 'Unlimited' } }
    const fresh: PlanMatrix[] = []

    const now = await resolvePlanMatrix(api(changed), cache, (matrix) => fresh.push(matrix))

    expect(now).toEqual(MATRIX)
    await settled()
    expect(fresh).toEqual([changed])
    expect(writes.map((write) => write.matrix)).toEqual([changed])
  })

  it('does not call back for an answer the cache already held', async () => {
    const { cache } = fakeCache({ matrix: MATRIX, fetchedAt: '2026-10-11T00:00:00.000Z' })
    const fresh: PlanMatrix[] = []

    await resolvePlanMatrix(api(MATRIX), cache, (matrix) => fresh.push(matrix))

    await settled()
    expect(fresh).toEqual([])
  })

  it('answers nothing on a device that never cached one, then calls back with the fetch', async () => {
    const { cache, writes } = fakeCache()
    const fresh: PlanMatrix[] = []

    const now = await resolvePlanMatrix(
      api(MATRIX),
      cache,
      (matrix) => fresh.push(matrix),
      () => '2026-10-12T09:00:00.000Z',
    )

    expect(now).toBeUndefined()
    await settled()
    expect(fresh).toEqual([MATRIX])
    expect(writes).toEqual([{ matrix: MATRIX, fetchedAt: '2026-10-12T09:00:00.000Z' }])
  })

  it('keeps the cached answer when the server has nothing', async () => {
    const { cache, writes } = fakeCache({ matrix: MATRIX, fetchedAt: '2026-10-11T00:00:00.000Z' })
    const fresh: PlanMatrix[] = []

    const now = await resolvePlanMatrix(api(undefined), cache, (matrix) => fresh.push(matrix))

    expect(now).toEqual(MATRIX)
    await settled()
    expect(fresh).toEqual([])
    expect(writes).toEqual([])
  })

  it('treats a cached document another build wrote as nothing', async () => {
    // Guarded again on the way out: the document is whatever build wrote it last.
    const { cache } = fakeCache({ matrix: { free: 'cheap' }, fetchedAt: 'x' })

    expect(await resolvePlanMatrix(api(undefined), cache, () => {})).toBeUndefined()
  })

  it('survives an unreadable cache and still asks the server', async () => {
    const { cache } = fakeCache(undefined, 'read')
    const fresh: PlanMatrix[] = []

    const now = await resolvePlanMatrix(api(MATRIX), cache, (matrix) => fresh.push(matrix))

    expect(now).toBeUndefined()
    await settled()
    expect(fresh).toEqual([MATRIX])
  })

  it('still calls back when the cache refuses the write', async () => {
    const { cache } = fakeCache(undefined, 'write')
    const fresh: PlanMatrix[] = []

    await resolvePlanMatrix(api(MATRIX), cache, (matrix) => fresh.push(matrix))

    await settled()
    expect(fresh).toEqual([MATRIX])
  })
})
