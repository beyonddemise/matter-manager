/**
 * A typed repository over one document type in a PouchDB database.
 *
 * **This package constructs no database.** A repository is handed one. That is not taste: the
 * allowlisted runtime build, `pouchdb-browser`, references `self` at module scope and cannot
 * be imported in Node at all, so a package that imported it could only be tested in a browser.
 * Inverting the dependency means `packages/web` supplies the browser build, the tests supply
 * `pouchdb-core` plus the memory adapter, and this code cares about neither.
 *
 * The only PouchDB thing named here is the *type* `PouchDB.Database`, which is erased.
 *
 * @module
 */

import {
  type DocumentType,
  documentTypeOf,
  idRange,
  type Revision,
  type Unsaved,
} from '@matter-manager/core'

/** Reading and writing one document type. */
export interface Repository<T extends Revision> {
  /** The document, or `undefined` if there is none with that id. */
  get(id: string): Promise<T | undefined>
  /** Every document of this type, in id order. */
  list(): Promise<T[]>
  /** Writes the document and returns it as stored, with its new `_rev` and `updatedAt`. */
  save(document: Unsaved<T>): Promise<T>
  /** Deletes the document. Takes the document, not the id, because the `_rev` must be current. */
  remove(document: T): Promise<void>
}

/** PouchDB reports a missing document with `status: 404`; everything else is a real failure. */
function isMissing(error: unknown): boolean {
  return (
    typeof error === 'object' && error !== null && (error as { status?: unknown }).status === 404
  )
}

/**
 * Builds a repository for one document type.
 *
 * @param database an open PouchDB database, supplied by the caller
 * @param type the document type this repository owns; it bounds `list` and guards `save`
 * @param now the clock, injected so tests are deterministic and this package holds no ambient
 *   time. Every write is stamped with it.
 */
export function repository<T extends Revision>(
  database: PouchDB.Database,
  type: DocumentType,
  now: () => string,
): Repository<T> {
  return {
    async get(id: string): Promise<T | undefined> {
      try {
        return (await database.get(id)) as unknown as T
      } catch (error) {
        // Only "not there". A closed database, a corrupt file or a failed request still
        // throws, because swallowing those would turn an outage into an empty catalogue.
        if (isMissing(error)) return undefined
        throw error
      }
    },

    async list(): Promise<T[]> {
      const { rows } = await database.allDocs({ ...idRange(type), include_docs: true })
      // A ranged `_all_docs` omits deleted documents entirely - verified, rather than assumed
      // from the shape of the API - so `doc` is in practice always present. The guard is a
      // type-level one: the row type declares `doc` optional (it genuinely is absent for a
      // `keys`-style query), and narrowing here is better than casting past it. A mutation
      // probe will report this branch as unreachable, and it is.
      return rows.flatMap((row) => (row.doc ? [row.doc as unknown as T] : []))
    },

    async save(document: Unsaved<T>): Promise<T> {
      const actualType = documentTypeOf(document._id)
      if (actualType !== type) {
        // Saved through the wrong repository, a document is outside this type's key range and
        // outside the other's guard: it reads back by id and appears in no list at all.
        throw new TypeError(
          `A ${type} repository cannot save ${JSON.stringify(document._id)}; that id is ${
            actualType === undefined ? 'not one this application writes' : `a ${actualType}`
          }.`,
        )
      }

      // Spread last so a caller cannot supply their own `updatedAt`, even by casting past
      // `Unsaved`. The stamp is half of the conflict merge's total order (ADR 0010).
      const stored = { ...document, updatedAt: now() } as unknown as T
      const { rev } = await database.put(stored as unknown as PouchDB.Core.PutDocument<object>)
      return { ...stored, _rev: rev }
    },

    async remove(document: T): Promise<void> {
      await database.remove(document._id, document._rev)
    },
  }
}
