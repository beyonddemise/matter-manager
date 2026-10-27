/**
 * A typed repository over one document type in a PouchDB database.
 *
 * **This package constructs no database.** A repository is handed one. That is not taste: the
 * allowlisted runtime build, `pouchdb-browser`, references `self` at module scope and cannot
 * be imported in Node at all, so a package that imported it could only be tested in a browser.
 * Inverting the dependency means `src/ui` supplies the browser build, the tests supply
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
} from '../domain/index.js'
import type { Conflicted } from './conflicts.js'

/**
 * Encrypts and decrypts one field value, bound to its document and field (#302).
 *
 * This is the whole of what `data/` knows about cryptography: an injected pair of functions.
 * The instance is built in `ui/db/` from `domain/crypto`, so this package imports WebCrypto as
 * little as it imports PouchDB — which is not at all, and for the same testability reason.
 */
export type FieldCipher = {
  encrypt(docId: string, field: string, value: string): Promise<string>
  decrypt(docId: string, field: string, value: string): Promise<string>
}

/**
 * Whether a project's data-encryption key is in hand.
 *
 * *Unlocked* carries the cipher bound to the project DEK. *Locked* means the database holds
 * ciphertext this device cannot open yet (its wrap has not arrived) — a transient state when
 * online, with a strict contract: reads omit the secrets, writes are refused. See the spec,
 * "Locked projects: the data-layer contract".
 */
export type KeyState = { kind: 'unlocked'; cipher: FieldCipher } | { kind: 'locked' }

/**
 * A key state, or a function that resolves one.
 *
 * The function form exists because repositories are constructed synchronously (`ui/db` memoises
 * them per opened database) while unlocking a project is asynchronous. The provider is consulted
 * on every operation, which is also the recovery seam: when escrow delivers the missing wrap
 * (#302 follow-up, F7), the provider starts answering `unlocked` and the same repository objects
 * every view already holds simply begin decrypting.
 */
export type KeyStateProvider = () => KeyState | undefined | Promise<KeyState | undefined>

/** The two fields the seam encrypts — the commissioning secrets, and nothing else (spec). */
const SECRET_FIELDS = ['payload', 'manualCode'] as const

/**
 * A document read from a locked project: the secret fields absent — absent, not emptied, so no
 * view renders a blank code as if it were one — and the document marked.
 *
 * The repository's method signatures keep answering `T`: the union would force every consumer
 * to narrow before F6 introduces the gates that actually handle the state. Consumers that may
 * meet a locked project test with {@link isLockedDocument}.
 */
export type LockedDocument<T> = Omit<T, (typeof SECRET_FIELDS)[number]> & {
  readonly locked: true
}

/** Whether a read answered a {@link LockedDocument} — the narrow half of its typing note. */
export function isLockedDocument(document: object): document is { readonly locked: true } {
  return (document as { locked?: unknown }).locked === true
}

/**
 * A write was refused because the project is locked.
 *
 * Deliberately its own class rather than a message: there is no DEK to encrypt with, and a
 * caller that wrote anyway — having read documents whose decrypted form dropped the ciphertext —
 * would destroy the stored secret. F6 surfaces this as a problem string; everything below it
 * only needs `instanceof`.
 */
export class ProjectLockedError extends Error {
  constructor(operation: string) {
    super(
      `This project is locked on this device (its key has not arrived yet), so ${operation} is refused.`,
    )
    this.name = 'ProjectLockedError'
  }
}

/** Normalises the two accepted forms of a key state argument. */
export async function keyStateOf(
  source: KeyState | KeyStateProvider | undefined,
): Promise<KeyState | undefined> {
  return typeof source === 'function' ? source() : source
}

/**
 * The document with each present secret field passed through `apply`. Untouched — the same
 * object — when neither field is there, so a document without a payload stays without one.
 */
async function withSecretFields<T extends Revision>(
  document: T,
  apply: (field: string, value: string) => Promise<string>,
): Promise<T> {
  const patch: Record<string, string> = {}
  for (const field of SECRET_FIELDS) {
    const value = (document as Record<string, unknown>)[field]
    if (typeof value === 'string') patch[field] = await apply(field, value)
  }
  return Object.keys(patch).length === 0 ? document : { ...document, ...patch }
}

/**
 * The locked read of a document: secrets gone, `_conflicts` stripped (as `resolve` would have),
 * marked. Cast back to `T` per the typing note on {@link LockedDocument}.
 */
function lockedView<T extends Revision>(document: Conflicted<T>): T {
  const {
    _conflicts,
    payload: _payload,
    manualCode: _manualCode,
    ...rest
  } = document as Conflicted<T> & {
    _conflicts?: unknown
    payload?: unknown
    manualCode?: unknown
  }
  return { ...rest, locked: true } as unknown as T
}

/** Reading and writing one document type. */
export interface Repository<T extends Revision> {
  /** The document, or `undefined` if there is none with that id. */
  get(id: string): Promise<T | undefined>
  /** Every document of this type, in id order. */
  list(): Promise<T[]>
  /** Writes the document and returns it as stored, with its new `_rev` and `updatedAt`. */
  save(document: Unsaved<T>): Promise<T>
  /**
   * Writes the document as read, keeping its `updatedAt`, and returns it with its new `_rev`.
   *
   * Only for a write that changes no user-entered field: the catalogue block, which carries
   * its own clock (`catalogCheckedAt`). Restamping would let such a write, made on a stale
   * replica, outrank a real edit in the merge's `(updatedAt, _rev)` order (ruling R26).
   */
  saveKeepingUpdatedAt(document: T): Promise<T>
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
 * @param keyState the project's key state (#302), or a provider for it. **Omitted means
 *   plaintext** — the pre-encryption behaviour, kept for `mm-local`-style databases and unit
 *   tests. Unlocked: `payload` and `manualCode` are encrypted on the way in and decrypted on the
 *   way out. Locked: reads omit the two fields and mark the document ({@link LockedDocument}),
 *   writes throw {@link ProjectLockedError}.
 */
export function repository<T extends Revision>(
  database: PouchDB.Database,
  type: DocumentType,
  now: () => string,
  resolve: (document: Conflicted<T>) => Promise<T>,
  keyState?: KeyState | KeyStateProvider,
): Repository<T> {
  /** The key state right now — asked per operation, which is what lets F7 unlock in place. */
  const currentKeyState = (): Promise<KeyState | undefined> => keyStateOf(keyState)

  /** The stored document decrypted, or returned as-is on a plaintext repository. */
  const decrypted = async (
    document: T,
    state: Extract<KeyState, { kind: 'unlocked' }> | undefined,
  ): Promise<T> =>
    state === undefined
      ? document
      : withSecretFields(document, (field, value) =>
          state.cipher.decrypt(document._id, field, value),
        )

  /** Writes a document of this type exactly as given; both save paths end here. */
  async function put(document: T): Promise<T> {
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
    const state = await currentKeyState()
    // There is no DEK to encrypt with, and the caller's document — read with the ciphertext
    // dropped — would overwrite the stored secret with nothing.
    if (state?.kind === 'locked') throw new ProjectLockedError('saving')
    const stored =
      state === undefined
        ? document
        : await withSecretFields(document, (field, value) =>
            state.cipher.encrypt(document._id, field, value),
          )
    const { rev } = await database.put(stored as unknown as PouchDB.Core.PutDocument<object>)
    // The caller gets the document back as it handed it over — plaintext — with its new `_rev`:
    // the return value is what views keep and re-save, and ciphertext must never reach them.
    return { ...document, _rev: rev }
  }

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

      // Locked, the document is answered without resolving: resolution *writes* (the merge and
      // the prune), the locked contract refuses every write, and the conflict loses nothing by
      // waiting — the next unlocked read merges it exactly as this one would have.
      const state = await currentKeyState()
      if (state?.kind === 'locked') return lockedView(document)

      // Outside the guard, and that placement is the whole point. Resolving reads each losing
      // revision by `_rev`, and one of those can be gone — compacted away, or removed by
      // another resolver — which raises the same 404 this document's own absence would. Inside
      // the guard that becomes "there is no such device", about a device that is right there.
      return decrypted(await resolve(document), state)
    },

    async list(): Promise<T[]> {
      const { rows } = await database.allDocs({
        ...idRange(type),
        include_docs: true,
        conflicts: true,
      })
      const state = await currentKeyState()
      // A ranged `_all_docs` omits deleted documents entirely - verified, rather than assumed
      // from the shape of the API - so `doc` is in practice always present. The guard is a
      // type-level one: the row type declares `doc` optional (it genuinely is absent for a
      // `keys`-style query), and narrowing here is better than casting past it. A mutation
      // probe will report this branch as unreachable, and it is.
      const documents = rows.flatMap((row) =>
        row.doc ? [row.doc as unknown as Conflicted<T>] : [],
      )
      // Locked rows skip `resolve` for the reason `get` gives: resolution writes.
      if (state?.kind === 'locked') return documents.map((document) => lockedView(document))
      return Promise.all(
        documents.map(async (document) => decrypted(await resolve(document), state)),
      )
    },

    async save(document: Unsaved<T>): Promise<T> {
      // Spread last so a caller cannot supply their own `updatedAt`, even by casting past
      // `Unsaved`. The stamp is half of the conflict merge's total order (ADR 0010).
      return put({ ...document, updatedAt: now() } as unknown as T)
    },

    saveKeepingUpdatedAt(document: T): Promise<T> {
      return put(document)
    },

    async remove(document: T): Promise<void> {
      // Refused like the saves: not because a tombstone could leak anything, but because a
      // deletion is a write the reader decided on while unable to see what they were deleting.
      if ((await currentKeyState())?.kind === 'locked') throw new ProjectLockedError('deleting')
      // A tombstone carrying nothing but `_deleted`, which is what `remove` writes. Storing the
      // document's fields on the deleted revision instead would make a deletion orderable
      // against a concurrent edit — but no such comparison is ever made (see `conflicts.ts` on
      // why a deleted branch never reaches a merge), and it would leave `manualCode` and
      // `payload` — the setup secrets — readable on the deleted revision until compaction.
      await database.remove(document._id, document._rev)
    },
  }
}
