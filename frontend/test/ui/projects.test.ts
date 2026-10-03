import { describe, expect, it } from 'vitest'
import {
  createProject,
  type NewProject,
  type Project,
  ProjectCreationError,
  ProjectUpdateError,
  projectsApi,
} from '../../src/ui/projects.js'

const PROJECT: Project = {
  projectId: '8f14e45f-ceea-467a-9c0e-1b2c3d4e5f60',
  dbName: 'project_8f14e45f-ceea-467a-9c0e-1b2c3d4e5f60',
  name: 'Musterstraße 12',
  role: 'owner',
  owner: { ownerType: 'user', ownerId: 'google|1234' },
  // Required by the contract since #55, even though the stored field is optional: the API
  // answers the question for every project, so no client reads an absence as a `false`.
  archived: false,
}

/** An API that records what it was asked, and can be told to fail. */
function fakeApi(behaviour: { fails?: unknown } = {}) {
  const attempts: NewProject[] = []
  return {
    attempts,
    api: {
      list: async () => [PROJECT],
      update: async () => PROJECT,
      create: async (request: NewProject) => {
        attempts.push(request)
        if (behaviour.fails !== undefined) throw behaviour.fails
        return PROJECT
      },
    },
  }
}

describe('creating a project needs a connection', () => {
  it('creates one when there is a network', async () => {
    const { api } = fakeApi()

    expect(await createProject({ api, online: () => true }, { name: 'Musterstraße 12' })).toEqual(
      PROJECT,
    )
  })

  it('refuses immediately when the browser is certain there is none', async () => {
    const { api } = fakeApi()

    await expect(
      createProject({ api, online: () => false }, { name: 'Musterstraße 12' }),
    ).rejects.toThrow(ProjectCreationError)
  })

  it('says that being offline is what stopped it', async () => {
    // A reason, not a sentence. The interface writes the sentence, in the user's language —
    // which is issue #75, and what happens when a domain module writes English into a German
    // interface.
    const { api } = fakeApi()

    const error = await createProject({ api, online: () => false }, { name: 'x' }).catch(
      (thrown: unknown) => thrown,
    )
    expect((error as ProjectCreationError).reason).toBe('offline')
  })

  it('sends nothing at all when offline', async () => {
    // **Nothing is queued.** Not "queued and cancelled" — never attempted, so there is nothing
    // in flight to wonder about and nothing that could arrive later.
    const { api, attempts } = fakeApi()
    await createProject({ api, online: () => false }, { name: 'x' }).catch(() => undefined)

    expect(attempts).toEqual([])
  })

  it('does not try again when the attempt fails', async () => {
    // A retry is indistinguishable to the user from a success that has not appeared yet, and
    // this is the operation where believing it worked is expensive: they would name the
    // project, put devices in it, and find later that neither was ever real.
    const { api, attempts } = fakeApi({ fails: new TypeError('Failed to fetch') })
    await createProject({ api, online: () => true }, { name: 'x' }).catch(() => undefined)

    expect(attempts).toHaveLength(1)
  })

  it('distinguishes "you are offline" from "that did not arrive"', async () => {
    // The browser thought there was a network and there was not — a captive portal, DNS, a
    // dropped connection. A different sentence, because the user may be right about the wifi
    // and wrong about the internet.
    const { api } = fakeApi({ fails: new TypeError('Failed to fetch') })

    const error = await createProject({ api, online: () => true }, { name: 'x' }).catch(
      (thrown: unknown) => thrown,
    )
    expect((error as ProjectCreationError).reason).toBe('unreachable')
  })

  it('keeps the reason the API gave it', async () => {
    // A 403 is an entitlement refusal, and telling somebody their connection failed would send
    // them to look at their wifi about a problem no amount of network will fix.
    const { api } = fakeApi({ fails: new ProjectCreationError('not-entitled') })

    const error = await createProject({ api, online: () => true }, { name: 'x' }).catch(
      (thrown: unknown) => thrown,
    )
    expect((error as ProjectCreationError).reason).toBe('not-entitled')
  })
})

describe('talking to the API', () => {
  /** A `fetch` that records its call and answers with the given status and body. */
  function stubFetch(status: number, body: unknown = {}) {
    const calls: Array<{ url: string; init: RequestInit | undefined }> = []
    const impl = (async (url: string, init?: RequestInit) => {
      calls.push({ url, init })
      return new Response(JSON.stringify(body), {
        status,
        headers: { 'content-type': 'application/json' },
      })
    }) as unknown as typeof fetch
    return { calls, impl }
  }

  it('sends the access token as a bearer', async () => {
    // What the contract declares, and what `auth/bearer.ts` reads. No cookie authenticates
    // these routes: the only one the API sets after sign-in is the handoff, which authorises a
    // single `POST /auth/token` and nothing else.
    const { calls, impl } = stubFetch(201, PROJECT)
    await projectsApi('https://api.example', () => 'a.token', impl).create({ name: 'x' })

    const sent = calls[0]?.init?.headers as Record<string, string> | undefined
    expect(sent?.authorization).toBe('Bearer a.token')
  })

  it('sends no authorization header when there is no token', async () => {
    // Rather than `Bearer undefined`, which is a credential the server has to parse and refuse.
    const { calls, impl } = stubFetch(401)
    await projectsApi('https://api.example', () => undefined, impl)
      .create({ name: 'x' })
      .catch(() => undefined)

    const sent = calls[0]?.init?.headers as Record<string, string> | undefined
    expect(sent?.authorization).toBeUndefined()
  })

  it('posts the name and client', async () => {
    const { calls, impl } = stubFetch(201, PROJECT)
    await projectsApi('https://api.example', () => 't', impl).create({
      name: 'Musterstraße 12',
      client: 'Meier GmbH',
    })

    expect(JSON.parse(String(calls[0]?.init?.body))).toEqual({
      name: 'Musterstraße 12',
      client: 'Meier GmbH',
    })
  })

  it('does not build a doubled slash from a base url that has one', async () => {
    const { calls, impl } = stubFetch(200, [])
    await projectsApi('https://api.example/', () => 't', impl).list()

    expect(calls[0]?.url).toBe('https://api.example/projects')
  })

  it.each([
    [401, 'not-signed-in'],
    [403, 'not-entitled'],
    [400, 'refused'],
    [500, 'failed'],
  ])('reads %i as %s', async (status, reason) => {
    const { impl } = stubFetch(status)

    const error = await projectsApi('https://api.example', () => 't', impl)
      .create({ name: 'x' })
      .catch((thrown: unknown) => thrown)

    expect((error as ProjectCreationError).reason).toBe(reason)
  })

  /** A problem body as the API answers a refusal: RFC 9457 with a pinned `reason`. */
  const refusal = (reason: string) => ({ title: 'Forbidden', status: 403, reason })

  it.each([['plan-no-sync'], ['project-limit-reached'], ['not-a-manager']])(
    'tells a 403 for %s apart from the others',
    async (reason) => {
      // The page branches on these: "upgrade", "make room" and "ask the owner" are three
      // different next steps, and all of them used to read as `not-entitled`.
      const api = projectsApi(
        'https://api.example',
        () => 't',
        stubFetch(403, refusal(reason)).impl,
      )

      const created = await api.create({ name: 'x' }).catch((thrown: unknown) => thrown)
      const updated = await api.update('p1', { archived: false }).catch((thrown: unknown) => thrown)

      expect((created as ProjectCreationError).reason).toBe(reason)
      expect((updated as ProjectUpdateError).reason).toBe(reason)
    },
  )

  it.each([
    ['an unknown reason', { reason: 'something-new' }],
    ['no reason', { title: 'Forbidden' }],
    ['a body that is not JSON', undefined],
  ])('keeps not-entitled for a 403 with %s', async (_label, body) => {
    const impl = (async () =>
      new Response(body === undefined ? 'nope' : JSON.stringify(body), {
        status: 403,
      })) as unknown as typeof fetch

    const error = await projectsApi('https://api.example', () => 't', impl)
      .create({ name: 'x' })
      .catch((thrown: unknown) => thrown)

    expect((error as ProjectCreationError).reason).toBe('not-entitled')
  })

  it('patches a project with the bearer token and a JSON body', async () => {
    const { calls, impl } = stubFetch(200, { ...PROJECT, client: 'Meier GmbH' })
    const updated = await projectsApi('https://api.example/', () => 'a.token', impl).update(
      PROJECT.projectId,
      { client: null, archived: true },
    )

    expect(calls[0]?.url).toBe(`https://api.example/projects/${PROJECT.projectId}`)
    expect(calls[0]?.init?.method).toBe('PATCH')
    const sent = calls[0]?.init?.headers as Record<string, string>
    expect(sent.authorization).toBe('Bearer a.token')
    expect(sent['content-type']).toBe('application/json')
    // `null` is how a client is cleared; absent would leave it alone.
    expect(JSON.parse(String(calls[0]?.init?.body))).toEqual({ client: null, archived: true })
    expect(updated.client).toBe('Meier GmbH')
  })

  it.each([
    [401, 'not-signed-in'],
    [404, 'not-found'],
    [400, 'refused'],
    [500, 'failed'],
  ])('reads %i from a patch as %s', async (status, reason) => {
    const error = await projectsApi('https://api.example', () => 't', stubFetch(status).impl)
      .update('p1', { name: 'y' })
      .catch((thrown: unknown) => thrown)

    expect(error).toBeInstanceOf(ProjectUpdateError)
    expect((error as ProjectUpdateError).reason).toBe(reason)
  })

  it('lists what the server returned', async () => {
    const { impl } = stubFetch(200, [PROJECT])

    expect(await projectsApi('https://api.example', () => 't', impl).list()).toEqual([PROJECT])
  })
})
