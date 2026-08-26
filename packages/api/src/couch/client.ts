/**
 * A small typed CouchDB client, over native `fetch`.
 *
 * Written rather than installed, and M4-1 says why: `nano`, `couchdb` and `axios` predate
 * global `fetch` and carry their own HTTP stack for what is now a few lines (ADR 0013). The
 * whole surface this service needs is five operations, and M0 verified that create, read,
 * write, `_security` and `_changes` all work over plain `fetch` against CouchDB 3.5.2.
 *
 * It is a wrapper rather than scattered `fetch` calls for one reason above the others:
 * **authentication and error handling happen in one place.** A `fetch` written at a call site
 * is a `fetch` where somebody eventually forgets the credentials header, or treats a 409 as a
 * failure, or logs the response body — and the response body of a project database contains
 * setup passcodes.
 *
 * @module
 */

/** Where CouchDB is, and who this service is to it. */
export interface CouchConfig {
  /** Base URL, no trailing slash: `http://localhost:5984`. */
  readonly url: string
  readonly user: string
  readonly password: string
}

/** A CouchDB response that was not a success. */
export class CouchError extends Error {
  override readonly name = 'CouchError'
  readonly status: number
  /** CouchDB's own short reason — `not_found`, `conflict`. Safe: it never echoes a document. */
  readonly reason: string

  constructor(status: number, reason: string, message: string) {
    super(message)
    this.status = status
    this.reason = reason
  }
}

/** Anything with a CouchDB revision. */
export interface Revision {
  readonly _id: string
  readonly _rev?: string
}

/** What a write returns. */
export interface WriteResult {
  readonly id: string
  readonly rev: string
}

/**
 * A database's `_security` object.
 *
 * `members.roles` is what M0 verified CouchDB preserves across upgrades, and the CI contract
 * check exists because a release that stopped preserving custom keys would silently convert
 * read-only access into read-write (lesson L2).
 */
export interface Security {
  readonly admins?: { readonly names?: string[]; readonly roles?: string[] }
  readonly members?: { readonly names?: string[]; readonly roles?: string[] }
}

/** The operations this service needs. Deliberately not "a CouchDB client" in general. */
export interface CouchClient {
  /** A document, or `undefined` when there is none — a 404 is an answer, not a failure. */
  getDoc<T extends Revision>(database: string, id: string): Promise<T | undefined>
  putDoc<T extends Revision>(database: string, document: T): Promise<WriteResult>
  /** Creates a database. `false` when it already existed, which is not an error. */
  createDb(database: string): Promise<boolean>
  putSecurity(database: string, security: Security): Promise<void>
  getSecurity(database: string): Promise<Security>
  /** A view query. `include_docs` and friends go in `params`. */
  view<T>(
    database: string,
    design: string,
    name: string,
    params?: Readonly<Record<string, string | number | boolean>>,
  ): Promise<{ readonly rows: readonly T[] }>
}

/** `Basic` credentials, encoded once rather than per request. */
function authorization(config: CouchConfig): string {
  return `Basic ${Buffer.from(`${config.user}:${config.password}`).toString('base64')}`
}

/**
 * Builds the client.
 *
 * @param config where CouchDB is
 * @param fetchImpl injected so tests drive it without a server. The default is the platform's,
 *   which is the entire point of not installing an HTTP library.
 */
export function couchClient(config: CouchConfig, fetchImpl: typeof fetch = fetch): CouchClient {
  const base = config.url.replace(/\/+$/, '')
  const auth = authorization(config)

  async function request(
    method: string,
    path: string,
    body?: unknown,
  ): Promise<{ status: number; json: unknown }> {
    const response = await fetchImpl(`${base}${path}`, {
      method,
      headers: {
        authorization: auth,
        accept: 'application/json',
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    })

    // Parsed even for an error, because CouchDB's own `reason` is the useful part — and it is
    // a short code rather than a document, so it is safe to carry into an error message.
    const text = await response.text()
    let json: unknown
    try {
      json = text === '' ? undefined : JSON.parse(text)
    } catch {
      json = undefined
    }
    return { status: response.status, json }
  }

  /** CouchDB's error shape, when it sent one. */
  const reasonOf = (json: unknown): string => {
    if (typeof json !== 'object' || json === null) return 'unknown'
    const { error, reason } = json as { error?: unknown; reason?: unknown }
    return typeof reason === 'string' ? reason : typeof error === 'string' ? error : 'unknown'
  }

  /**
   * Throws for a status the caller did not say to expect.
   *
   * The message names the operation and CouchDB's reason and **never the response body**. A
   * project database's documents contain setup passcodes, and an error message is the most
   * reliable way for one to end up somewhere it was not meant to be.
   */
  function expect(
    result: { status: number; json: unknown },
    allowed: readonly number[],
    what: string,
  ): void {
    if (allowed.includes(result.status)) return
    throw new CouchError(
      result.status,
      reasonOf(result.json),
      `CouchDB refused to ${what}: ${result.status} ${reasonOf(result.json)}`,
    )
  }

  const encode = (value: string) => encodeURIComponent(value)

  return {
    async getDoc<T extends Revision>(database: string, id: string): Promise<T | undefined> {
      const result = await request('GET', `/${encode(database)}/${encode(id)}`)
      // A missing document is an answer this service acts on — "no such project" — rather than
      // a failure. Throwing here would make every caller write the same try/catch.
      if (result.status === 404) return undefined
      expect(result, [200], `read ${database}/${id}`)
      return result.json as T
    },

    async putDoc<T extends Revision>(database: string, document: T): Promise<WriteResult> {
      const result = await request('PUT', `/${encode(database)}/${encode(document._id)}`, document)
      expect(result, [201, 202], `write ${database}/${document._id}`)
      const { id, rev } = result.json as { id: string; rev: string }
      return { id, rev }
    },

    async createDb(database: string): Promise<boolean> {
      const result = await request('PUT', `/${encode(database)}`)
      // 412 is `file_exists`, and it is the expected answer to provisioning something twice —
      // a retried request, two tabs, a resumed migration. Reported as `false` rather than
      // thrown, so a caller can be idempotent without inspecting an error's status code.
      if (result.status === 412) return false
      expect(result, [201, 202], `create ${database}`)
      return true
    },

    async putSecurity(database: string, security: Security): Promise<void> {
      const result = await request('PUT', `/${encode(database)}/_security`, security)
      expect(result, [200], `set security on ${database}`)
    },

    async getSecurity(database: string): Promise<Security> {
      const result = await request('GET', `/${encode(database)}/_security`)
      expect(result, [200], `read security of ${database}`)
      return result.json as Security
    },

    async view<T>(
      database: string,
      design: string,
      name: string,
      params: Readonly<Record<string, string | number | boolean>> = {},
    ): Promise<{ readonly rows: readonly T[] }> {
      // CouchDB view parameters are **JSON-encoded**, not plain strings: `key=abc` is a
      // parse error where `key="abc"` is a lookup. Getting this wrong produces a 400 that
      // reads like a bad query rather than a bad encoding.
      const query = Object.entries(params)
        .map(([key, value]) => `${encode(key)}=${encode(JSON.stringify(value))}`)
        .join('&')

      const result = await request(
        'GET',
        `/${encode(database)}/_design/${encode(design)}/_view/${encode(name)}${query === '' ? '' : `?${query}`}`,
      )
      expect(result, [200], `query ${database}/_design/${design}/_view/${name}`)
      return result.json as { rows: readonly T[] }
    },
  }
}
