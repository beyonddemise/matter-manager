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
import type { Conflicted } from './conflicts.js'

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
 * @param resolve what to do about a conflicted document, from `conflicts.ts`. **Required, not
 *   optional**: a repository built without one would return the winning revision and silently
 *   drop whatever was written concurrently, which is the exact failure ADR 0010 exists to
 *   prevent. Making it a constructor argument means no repository can exist that has not said
 *   what it does about conflicts.
 */
export function repository<T extends Revision>(
  database: PouchDB.Database,
  type: DocumentType,
  now: () => string,
  resolve: (document: Conflicted<T>) => Promise<T>,
): Repository<T> {
  return {
    async get(id: string): Promise<T | undefined> {
      let document: Conflicted<T>

      try {
        // `conflicts: true` on every read, not only where one is expected. A conflict is
        // created by replication rather than by this browser, so there is no read at which one
        // is *not* expected, and the resolver is what turns the annotation back into a
        // document — including stripping it, which must happen whether or not there was one.
        document = (await database.get(id, { conflicts: true })) as unknown as Conflicted<T>
      } catch (error) {
        // Only "not there". A closed database, a corrupt file or a failed request still
        // throws, because swallowing those would turn an outage into an empty catalogue.
        if (isMissing(error)) return undefined
        throw error
      }

      // Outside the guard, and that placement is the whole point. Resolving reads each losing
      // revision by `_rev`, and one of those can be gone — compacted away, or removed by
      // another resolver — which raises the same 404 this document's own absence would. Inside
      // the guard that becomes "there is no such device", about a device that is right there.
      return resolve(document)
    },

    async list(): Promise<T[]> {
      const { rows } = await database.allDocs({
        ...idRange(type),
        include_docs: true,
        conflicts: true,
      })
      // A ranged `_all_docs` omits deleted documents entirely - verified, rather than assumed
      // from the shape of the API - so `doc` is in practice always present. The guard is a
      // type-level one: the row type declares `doc` optional (it genuinely is absent for a
      // `keys`-style query), and narrowing here is better than casting past it. A mutation
      // probe will report this branch as unreachable, and it is.
      return Promise.all(
        rows.flatMap((row) => (row.doc ? [resolve(row.doc as unknown as Conflicted<T>)] : [])),
      )
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
      // A tombstone carrying nothing but `_deleted`, which is what `remove` writes. Storing the
      // document's fields on the deleted revision instead would make a deletion orderable
      // against a concurrent edit — but no such comparison is ever made (see `conflicts.ts` on
      // why a deleted branch never reaches a merge), and it would leave `manualCode` and
      // `payload` — the setup secrets — readable on the deleted revision until compaction.
      await database.remove(document._id, document._rev)
    },
  }
}
