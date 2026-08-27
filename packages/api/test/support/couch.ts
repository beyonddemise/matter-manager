import type { CouchClient, Revision, Security, WriteResult } from '../../src/couch/client.js'
import { CouchError } from '../../src/couch/client.js'

/** One thing the client was asked to do, in the order it was asked. */
export interface CouchCall {
  readonly operation:
    | 'getDoc'
    | 'putDoc'
    | 'createDb'
    | 'deleteDb'
    | 'putSecurity'
    | 'getSecurity'
    | 'view'
  readonly database: string
  readonly detail?: unknown
}

/**
 * Which operation should fail.
 *
 * `true` fails it everywhere; a **database name** fails it only there. The second form is what
 * the provisioning tests need: `putDoc` happens both to install the registry's view and to
 * install a project's access rules, and a failure that hit both would never reach the code
 * under test.
 */
export interface CouchFailures {
  readonly getDoc?: boolean | string
  readonly putDoc?: boolean | string
  readonly createDb?: boolean | string
  readonly deleteDb?: boolean | string
  readonly putSecurity?: boolean | string
  readonly getSecurity?: boolean | string
  readonly view?: boolean | string
}

export interface FakeCouch {
  readonly couch: CouchClient
  /** Documents, keyed `database/id`. Seeded, and updated by writes. */
  readonly documents: Map<string, Record<string, unknown>>
  /** `_security` per database, so a test can assert what was written rather than that it was. */
  readonly security: Map<string, Security>
  /** Databases that currently exist. A rollback that worked has removed one from here. */
  readonly databases: Set<string>
  /** Every call, in order. The order is the substance of the atomicity tests. */
  readonly calls: CouchCall[]
  /** Rows the next `view` returns. */
  rows: readonly unknown[]
}

/**
 * A CouchDB that lives in a `Map`.
 *
 * Shared rather than redefined per suite, and it records **calls** as well as state: the
 * provisioning tests are largely about what happened in which order and what did *not* happen
 * after a failure, which final state alone cannot show — a database that was created and then
 * removed looks exactly like one that was never created.
 *
 * @param options.seed documents to start with, keyed `database/id`
 * @param options.fails which operation should throw, so the rollback path can be reached
 */
export function fakeCouch(
  options: {
    seed?: Record<string, Record<string, unknown>>
    fails?: CouchFailures
    databases?: readonly string[]
  } = {},
): FakeCouch {
  const documents = new Map(Object.entries(options.seed ?? {}))
  const security = new Map<string, Security>()
  const databases = new Set(options.databases ?? [])
  const calls: CouchCall[] = []
  const fails = options.fails ?? {}

  const state = { rows: [] as readonly unknown[] }

  /** Whether this operation is set to fail for this database. */
  const failing = (operation: keyof CouchFailures, database: string): boolean => {
    const rule = fails[operation]
    return rule === true || rule === database
  }

  /** Refuses the way the real client refuses, so a caller's `catch` is exercised honestly. */
  const refuse = (what: string): never => {
    throw new CouchError(500, 'internal_server_error', what)
  }

  const record = (call: CouchCall): void => {
    calls.push(call)
  }

  const couch: CouchClient = {
    async getDoc<T extends Revision>(database: string, id: string): Promise<T | undefined> {
      record({ operation: 'getDoc', database, detail: id })
      if (failing('getDoc', database)) refuse(`read ${id}`)
      return documents.get(`${database}/${id}`) as T | undefined
    },

    async putDoc<T extends Revision>(database: string, document: T): Promise<WriteResult> {
      record({ operation: 'putDoc', database, detail: document })
      if (failing('putDoc', database)) refuse(`write ${document._id}`)

      // **`_rev` is enforced, as CouchDB enforces it.** A fake that accepts any write makes a
      // whole class of bug invisible: code that reads a document, forgets to carry its `_rev`
      // and writes it back passes every test here and fails against a real server on the second
      // write. The mutation probe found exactly that in `storeInvitation`.
      const key = `${database}/${document._id}`
      const existing = documents.get(key) as { _rev?: string } | undefined
      if (existing !== undefined && existing._rev !== document._rev) {
        throw new CouchError(409, 'conflict', `Document update conflict: ${document._id}`)
      }

      const rev = `${Number((existing?._rev ?? '0-x').split('-')[0]) + 1}-a`
      documents.set(key, { ...document, _rev: rev } as unknown as Record<string, unknown>)
      return { id: document._id, rev }
    },

    async createDb(database: string): Promise<boolean> {
      record({ operation: 'createDb', database })
      if (failing('createDb', database)) refuse(`create ${database}`)
      if (databases.has(database)) return false
      databases.add(database)
      return true
    },

    async deleteDb(database: string): Promise<boolean> {
      record({ operation: 'deleteDb', database })
      if (failing('deleteDb', database)) refuse(`delete ${database}`)
      return databases.delete(database)
    },

    async putSecurity(database: string, value: Security): Promise<void> {
      record({ operation: 'putSecurity', database, detail: value })
      if (failing('putSecurity', database)) refuse(`set security on ${database}`)
      security.set(database, value)
    },

    async getSecurity(database: string): Promise<Security> {
      record({ operation: 'getSecurity', database })
      if (failing('getSecurity', database)) refuse(`read security of ${database}`)
      return security.get(database) ?? {}
    },

    async view<T>(
      database: string,
      design: string,
      name: string,
      params?: Readonly<Record<string, string | number | boolean>>,
    ): Promise<{ readonly rows: readonly T[] }> {
      record({ operation: 'view', database, detail: { design, name, params } })
      if (failing('view', database)) refuse(`query ${design}/${name}`)
      return { rows: state.rows as readonly T[] }
    },
  }

  return {
    couch,
    documents,
    security,
    databases,
    calls,
    get rows() {
      return state.rows
    },
    set rows(value: readonly unknown[]) {
      state.rows = value
    },
  }
}

/** The operations performed, in order. What most atomicity assertions are actually about. */
export function operations(fake: FakeCouch): string[] {
  return fake.calls.map((call) => call.operation)
}
