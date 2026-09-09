import { describe, expect, it } from 'vitest'
import { type CouchConfig, CouchError, couchClient } from '../../src/couch/client.js'

const CONFIG: CouchConfig = { url: 'http://couch.test:5984', user: 'admin', password: 'devonly' }

/** One recorded request, as the client made it. */
interface Recorded {
  url: string
  method: string
  headers: Record<string, string>
  body: string | undefined
}

/**
 * A `fetch` that answers from a script and records what it was asked.
 *
 * The client is a wrapper over `fetch` and nothing else, so a fake `fetch` tests all of it —
 * including the parts that are easy to get wrong and invisible in an integration test, like
 * whether view parameters are JSON-encoded. The CouchDB contract itself is verified against a
 * real CouchDB in CI (`infra/couchdb/verify-access-model.sh`), which is the right place for
 * "does CouchDB behave this way" as opposed to "does this client speak it correctly".
 */
function fakeFetch(answers: ReadonlyArray<{ status: number; body?: unknown }>) {
  const calls: Recorded[] = []
  let index = 0

  const impl = (async (url: string | URL, init?: RequestInit) => {
    const answer = answers[Math.min(index, answers.length - 1)] ?? { status: 500 }
    index += 1
    calls.push({
      url: String(url),
      method: init?.method ?? 'GET',
      headers: (init?.headers ?? {}) as Record<string, string>,
      body: typeof init?.body === 'string' ? init.body : undefined,
    })
    return {
      status: answer.status,
      text: async () => (answer.body === undefined ? '' : JSON.stringify(answer.body)),
    } as Response
  }) as unknown as typeof fetch

  return { impl, calls }
}

describe('authenticating', () => {
  it('sends credentials on every request', () => {
    // Not "on the first". The single most likely bug in a hand-written client is a request
    // somebody added later without the header, and it presents as an intermittent 401.
    const { impl, calls } = fakeFetch([{ status: 200, body: { _id: 'x' } }])
    const client = couchClient(CONFIG, impl)

    return client.getDoc('project_x', 'device:1').then(() => {
      expect(calls[0]?.headers.authorization).toBe(
        `Basic ${Buffer.from('admin:devonly').toString('base64')}`,
      )
    })
  })

  it('tolerates a trailing slash on the configured URL', async () => {
    const { impl, calls } = fakeFetch([{ status: 200, body: {} }])
    await couchClient({ ...CONFIG, url: 'http://couch.test:5984/' }, impl).getDoc('db', 'id')

    expect(calls[0]?.url).toBe('http://couch.test:5984/db/id')
  })
})

describe('reading a document', () => {
  it('returns it', async () => {
    const { impl } = fakeFetch([{ status: 200, body: { _id: 'device:1', _rev: '1-a' } }])
    const doc = await couchClient(CONFIG, impl).getDoc('project_x', 'device:1')

    expect(doc).toEqual({ _id: 'device:1', _rev: '1-a' })
  })

  it('answers "nothing there" for a 404 rather than throwing', async () => {
    // A missing document is something this service acts on — "no such project" — rather than a
    // failure. Throwing would make every caller write the same try/catch.
    const { impl } = fakeFetch([{ status: 404, body: { error: 'not_found' } }])

    expect(await couchClient(CONFIG, impl).getDoc('project_x', 'nope')).toBeUndefined()
  })

  it('throws for anything else', async () => {
    const { impl } = fakeFetch([{ status: 500, body: { error: 'internal', reason: 'boom' } }])

    await expect(couchClient(CONFIG, impl).getDoc('project_x', 'x')).rejects.toThrow(CouchError)
  })

  it('escapes an id that would otherwise change the path', async () => {
    // Document ids here carry a `:` and could carry a `/`. An unescaped one is not a broken
    // request — it is a request to a *different resource*.
    const { impl, calls } = fakeFetch([{ status: 200, body: {} }])
    await couchClient(CONFIG, impl).getDoc('project_x', 'device:a/b')

    expect(calls[0]?.url).toBe('http://couch.test:5984/project_x/device%3Aa%2Fb')
  })
})

describe('writing a document', () => {
  it('returns the new revision', async () => {
    const { impl, calls } = fakeFetch([{ status: 201, body: { id: 'x', rev: '2-b', ok: true } }])
    const result = await couchClient(CONFIG, impl).putDoc('project_x', { _id: 'x', _rev: '1-a' })

    expect(result).toEqual({ id: 'x', rev: '2-b' })
    expect(calls[0]?.method).toBe('PUT')
    expect(calls[0]?.body).toContain('"_rev":"1-a"')
  })

  it('accepts an accepted-but-not-yet-durable write', async () => {
    // 202 is what CouchDB returns when the write is queued rather than flushed. Treating it as
    // a failure would make a correctly configured cluster look broken.
    const { impl } = fakeFetch([{ status: 202, body: { id: 'x', rev: '1-a' } }])

    await expect(couchClient(CONFIG, impl).putDoc('project_x', { _id: 'x' })).resolves.toBeDefined()
  })

  it('throws on a conflict', async () => {
    const { impl } = fakeFetch([
      { status: 409, body: { error: 'conflict', reason: 'Doc update conflict.' } },
    ])

    await expect(couchClient(CONFIG, impl).putDoc('project_x', { _id: 'x' })).rejects.toMatchObject(
      { status: 409, reason: 'Doc update conflict.' },
    )
  })
})

describe('creating a database', () => {
  it('reports that it made one', async () => {
    const { impl } = fakeFetch([{ status: 201, body: { ok: true } }])
    expect(await couchClient(CONFIG, impl).createDb('project_x')).toBe(true)
  })

  it('reports an existing one as false rather than throwing', async () => {
    // 412 is `file_exists`, and it is the expected answer to provisioning something twice — a
    // retried request, two tabs, a resumed migration. A caller can be idempotent without
    // inspecting an error's status code.
    const { impl } = fakeFetch([{ status: 412, body: { error: 'file_exists' } }])

    expect(await couchClient(CONFIG, impl).createDb('project_x')).toBe(false)
  })

  it('throws when it was refused for a real reason', async () => {
    const { impl } = fakeFetch([{ status: 401, body: { error: 'unauthorized' } }])

    await expect(couchClient(CONFIG, impl).createDb('project_x')).rejects.toThrow(CouchError)
  })
})

describe('deleting a database', () => {
  it('reports that it removed one', async () => {
    const { impl } = fakeFetch([{ status: 200, body: { ok: true } }])
    expect(await couchClient(CONFIG, impl).deleteDb('project_x')).toBe(true)
  })

  it('sends a DELETE to the database itself', async () => {
    // Asserted because the consequence of getting the URL wrong is deleting the wrong thing,
    // and the only caller is a rollback that runs when something has already gone wrong.
    const { impl, calls } = fakeFetch([{ status: 200, body: { ok: true } }])
    await couchClient(CONFIG, impl).deleteDb('project_x')

    expect(calls[0]?.method).toBe('DELETE')
    expect(calls[0]?.url).toBe('http://couch.test:5984/project_x')
  })

  it('reports an absent one as false rather than throwing', async () => {
    // The expected answer when the rollback runs because creation itself is what failed.
    const { impl } = fakeFetch([{ status: 404, body: { error: 'not_found' } }])

    expect(await couchClient(CONFIG, impl).deleteDb('project_x')).toBe(false)
  })

  it('throws when it was refused for a real reason', async () => {
    // A rollback that cannot complete must be loud. The database it failed to remove has no
    // `_security`, so it is readable by anyone with an account.
    const { impl } = fakeFetch([{ status: 401, body: { error: 'unauthorized' } }])

    await expect(couchClient(CONFIG, impl).deleteDb('project_x')).rejects.toThrow(CouchError)
  })
})

describe('security', () => {
  it('carries the writers key CouchDB does not interpret', async () => {
    // `writers` is not a CouchDB concept: the server understands `admins` and `members` and
    // preserves anything else, and `_design/access` reads this from the `_security` object it
    // is handed. A client that dropped unknown keys would produce a project every member
    // could write to, silently.
    const { impl, calls } = fakeFetch([{ status: 200, body: { ok: true } }])
    await couchClient(CONFIG, impl).putSecurity('project_x', {
      members: { names: ['ada', 'grace'], roles: [] },
      writers: { names: ['ada'] },
    })

    expect(JSON.parse(String(calls[0]?.body))).toEqual({
      members: { names: ['ada', 'grace'], roles: [] },
      writers: { names: ['ada'] },
    })
  })

  it('writes a security object', async () => {
    const { impl, calls } = fakeFetch([{ status: 200, body: { ok: true } }])
    await couchClient(CONFIG, impl).putSecurity('project_x', { members: { roles: ['reader'] } })

    expect(calls[0]?.url).toBe('http://couch.test:5984/project_x/_security')
    expect(calls[0]?.body).toBe('{"members":{"roles":["reader"]}}')
  })

  it('reads one back', async () => {
    const { impl } = fakeFetch([{ status: 200, body: { members: { roles: ['reader'] } } }])

    expect(await couchClient(CONFIG, impl).getSecurity('project_x')).toEqual({
      members: { roles: ['reader'] },
    })
  })
})

describe('querying a view', () => {
  it('JSON-encodes the parameters', async () => {
    // CouchDB view parameters are JSON, not plain strings: `key=abc` is a parse error where
    // `key="abc"` is a lookup. Getting this wrong produces a 400 that reads like a bad query
    // rather than a bad encoding — which is exactly the kind of thing an integration test
    // against a live server tells you about in the least useful way.
    const { impl, calls } = fakeFetch([{ status: 200, body: { rows: [] } }])
    await couchClient(CONFIG, impl).view('registry', 'access', 'by_member', {
      key: 'auth0|abc',
      include_docs: true,
      limit: 10,
    })

    const url = calls[0]?.url ?? ''
    expect(url).toContain('key=%22auth0%7Cabc%22')
    expect(url).toContain('include_docs=true')
    expect(url).toContain('limit=10')
  })

  it('asks for no query string when there are no parameters', async () => {
    const { impl, calls } = fakeFetch([{ status: 200, body: { rows: [] } }])
    await couchClient(CONFIG, impl).view('registry', 'access', 'by_member')

    expect(calls[0]?.url).toBe('http://couch.test:5984/registry/_design/access/_view/by_member')
  })

  it('returns the rows', async () => {
    const { impl } = fakeFetch([{ status: 200, body: { rows: [{ id: 'a' }, { id: 'b' }] } }])
    const { rows } = await couchClient(CONFIG, impl).view('registry', 'access', 'by_member')

    expect(rows).toHaveLength(2)
  })
})

describe('what an error says', () => {
  it('names the operation and CouchDB’s reason', async () => {
    const { impl } = fakeFetch([{ status: 403, body: { error: 'forbidden', reason: 'no' } }])

    await expect(couchClient(CONFIG, impl).getSecurity('project_x')).rejects.toThrow(
      /read security of project_x.*403/,
    )
  })

  it('never echoes the response body', async () => {
    // The most reliable way for a setup passcode to end up somewhere it was not meant to be is
    // an error message that helpfully includes what came back. A project database's documents
    // are full of them.
    const { impl } = fakeFetch([
      {
        status: 500,
        body: { error: 'internal', reason: 'boom', payload: 'MT:Y.K9042C00KA0648G00' },
      },
    ])

    let message = ''
    try {
      await couchClient(CONFIG, impl).getDoc('project_x', 'device:1')
    } catch (thrown) {
      message = (thrown as Error).message
    }

    expect(message).not.toContain('MT:')
    expect(message).toContain('boom')
  })

  it('copes with a response that is not JSON at all', async () => {
    // A proxy's HTML error page, or an empty body. Reporting "unknown" beats throwing a
    // SyntaxError from inside the client, which would obscure the status that actually
    // explains what happened.
    const { impl } = fakeFetch([{ status: 502 }])

    await expect(couchClient(CONFIG, impl).getDoc('db', 'id')).rejects.toMatchObject({
      status: 502,
      reason: 'unknown',
    })
  })
})
