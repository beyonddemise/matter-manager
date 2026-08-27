import { describe, expect, it } from 'vitest'
import { remoteProject } from '../../src/sync/remote.js'

/** Captures the URL and the `fetch` wrapper a remote was opened with. */
function opened() {
  const calls: Array<{
    url: string
    fetch: (url: RequestInfo | URL, init?: RequestInit) => Promise<Response>
  }> = []
  const open = ((url: string, options: { fetch: never }) => {
    calls.push({ url, fetch: options.fetch })
    return {} as never
  }) as never

  return { calls, open }
}

/** A `fetch` that records the headers it was handed. */
function recordingFetch() {
  const sent: Headers[] = []
  const impl = (async (_url: RequestInfo | URL, init?: RequestInit) => {
    sent.push(new Headers(init?.headers))
    return new Response('{}', { status: 200 })
  }) as unknown as typeof fetch
  return { sent, impl }
}

describe('opening a project on the server', () => {
  it('builds the database URL from the CouchDB origin', () => {
    const { calls, open } = opened()
    remoteProject('project_abc', { couchUrl: 'https://couch.example', token: () => 't', open })

    expect(calls[0]?.url).toBe('https://couch.example/project_abc')
  })

  it('does not build a doubled slash from an origin that has one', () => {
    const { calls, open } = opened()
    remoteProject('project_abc', { couchUrl: 'https://couch.example/', token: () => 't', open })

    expect(calls[0]?.url).toBe('https://couch.example/project_abc')
  })

  it('uses the database name it was given rather than assembling one', () => {
    // One place assembles that name, and it is the API's `projects/names.ts`. A second rule
    // here would be a second rule that could disagree — and the two would only disagree for
    // projects created before or after whichever change was made.
    const { calls, open } = opened()
    remoteProject('project_8f14e45f-ceea-467a-9c0e-1b2c3d4e5f60', {
      couchUrl: 'https://couch.example',
      token: () => 't',
      open,
    })

    expect(calls[0]?.url).toBe('https://couch.example/project_8f14e45f-ceea-467a-9c0e-1b2c3d4e5f60')
  })

  it('puts no credential in the URL', () => {
    // CouchDB accepts `https://user:password@host`, and a URL is logged, sent as a referrer and
    // kept in history in ways a header is not.
    const { calls, open } = opened()
    remoteProject('project_abc', { couchUrl: 'https://couch.example', token: () => 'secret', open })

    expect(calls[0]?.url).not.toContain('secret')
    expect(calls[0]?.url).not.toContain('@')
  })
})

describe('the credential on each request', () => {
  it('is the access token, as a bearer', async () => {
    const { calls, open } = opened()
    const { sent, impl } = recordingFetch()
    remoteProject('project_abc', {
      couchUrl: 'https://couch.example',
      token: () => 'a.token',
      open,
      fetchImpl: impl,
    })

    await calls[0]?.fetch('https://couch.example/project_abc')

    expect(sent[0]?.get('authorization')).toBe('Bearer a.token')
  })

  it('is read again for every request, not captured once', async () => {
    // **The bug this rules out.** An access token lives about an hour; a replication lives as
    // long as the tab. A handle built with the token held at construction would work, keep
    // working, and then quietly stop — and because the sync retries, it would stop by retrying
    // forever, which reports as "offline" on a perfectly good network.
    let current = 'first'
    const { calls, open } = opened()
    const { sent, impl } = recordingFetch()
    remoteProject('project_abc', {
      couchUrl: 'https://couch.example',
      token: () => current,
      open,
      fetchImpl: impl,
    })

    await calls[0]?.fetch('https://couch.example/project_abc')
    current = 'refreshed'
    await calls[0]?.fetch('https://couch.example/project_abc')

    expect(sent.map((headers) => headers.get('authorization'))).toEqual([
      'Bearer first',
      'Bearer refreshed',
    ])
  })

  it('is absent when there is no token, rather than the word undefined', async () => {
    // CouchDB would refuse `Bearer undefined` as a malformed credential, which is a different
    // failure from being unauthenticated and a more confusing one to read in a log.
    const { calls, open } = opened()
    const { sent, impl } = recordingFetch()
    remoteProject('project_abc', {
      couchUrl: 'https://couch.example',
      token: () => undefined,
      open,
      fetchImpl: impl,
    })

    await calls[0]?.fetch('https://couch.example/project_abc')

    expect(sent[0]?.has('authorization')).toBe(false)
  })

  it('keeps the headers PouchDB set for itself', async () => {
    // PouchDB sends `content-type` and `accept` on its own requests; a wrapper that replaced
    // the headers rather than adding to them would break replication in ways that look like a
    // CouchDB problem.
    const { calls, open } = opened()
    const { sent, impl } = recordingFetch()
    remoteProject('project_abc', {
      couchUrl: 'https://couch.example',
      token: () => 't',
      open,
      fetchImpl: impl,
    })

    await calls[0]?.fetch('https://couch.example/project_abc', {
      headers: { 'content-type': 'application/json' },
    })

    expect(sent[0]?.get('content-type')).toBe('application/json')
    expect(sent[0]?.get('authorization')).toBe('Bearer t')
  })

  it('keeps the request PouchDB meant to make', async () => {
    // The method and body have to survive the wrapper, or a replication would GET where it
    // meant to POST.
    const { calls, open } = opened()
    const seen: RequestInit[] = []
    const impl = (async (_url: RequestInfo | URL, init?: RequestInit) => {
      seen.push(init ?? {})
      return new Response('{}', { status: 200 })
    }) as unknown as typeof fetch

    remoteProject('project_abc', {
      couchUrl: 'https://couch.example',
      token: () => 't',
      open,
      fetchImpl: impl,
    })

    await calls[0]?.fetch('https://couch.example/project_abc/_bulk_docs', {
      method: 'POST',
      body: '{"docs":[]}',
    })

    expect(seen[0]?.method).toBe('POST')
    expect(seen[0]?.body).toBe('{"docs":[]}')
  })
})
