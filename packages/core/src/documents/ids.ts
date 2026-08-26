/**
 * Document ids, and the key range that lists one type of them.
 *
 * Every document id is `<type>:<uuid>`. The type is in the id rather than only in a `type`
 * field because that makes each type a **contiguous key range**, and a contiguous key range is
 * listable through `_all_docs` — which the database maintains itself, from the first write,
 * with no view to define, index, replicate or find stale.
 *
 * The cost of that choice is that the only free query is by id prefix. It is why a device
 * refers to its room by a full document id rather than a bare uuid: `roomId` is then something
 * `get` accepts directly.
 *
 * @module
 */

/** A document type that owns an id prefix. */
export type DocumentType = 'device' | 'room'

/** Separates the type from the uuid. Nothing else in an id may contain it. */
export const ID_SEPARATOR = ':'

/** The id prefix of each type, separator included. */
export const DOCUMENT_PREFIX = {
  device: `device${ID_SEPARATOR}`,
  room: `room${ID_SEPARATOR}`,
} as const satisfies Record<DocumentType, string>

/**
 * The upper bound of a prefix range.
 *
 * U+FFF0 is CouchDB's documented convention for "higher than anything you will put in a key".
 * It sits above every character an id here can contain, and below the surrogate range and the
 * non-characters at U+FFFE and U+FFFF, which are the values most likely to be mishandled
 * somewhere between a JavaScript string comparison and ICU collation.
 */
export const HIGHEST_ID_CHARACTER = '￰'

/**
 * Builds a document id.
 *
 * @param type the document type
 * @param uuid a client-generated UUID; `core` deliberately does not generate it, so that this
 *   package keeps its promise to reach for nothing ambient
 * @throws {RangeError} If the uuid is empty or contains the separator. Either would put the id
 *   outside its own prefix range, where it is simply never listed - a document that exists,
 *   reads back by id, and is invisible to every list in the application.
 */
export function documentId(type: DocumentType, uuid: string): string {
  if (uuid === '') throw new RangeError('A document id needs a uuid; it must not be empty.')
  if (uuid.includes(ID_SEPARATOR)) {
    throw new RangeError(
      `A document id's uuid must not contain a colon; received ${JSON.stringify(uuid)}.`,
    )
  }
  return `${DOCUMENT_PREFIX[type]}${uuid}`
}

/** The type an id belongs to, or `undefined` if this application did not write it. */
export function documentTypeOf(id: string): DocumentType | undefined {
  for (const [type, prefix] of Object.entries(DOCUMENT_PREFIX)) {
    if (id.startsWith(prefix) && id.length > prefix.length) return type as DocumentType
  }
  return undefined
}

/** The uuid part of an id, or `undefined` if the id is not one of ours. */
export function uuidOf(id: string): string | undefined {
  const type = documentTypeOf(id)
  return type === undefined ? undefined : id.slice(DOCUMENT_PREFIX[type].length)
}

/**
 * The `_all_docs` bounds that cover exactly one document type.
 *
 * Both ends are inclusive, which is `_all_docs`'s default and the reason `endkey` needs a
 * character above every real id rather than the next prefix.
 */
export function idRange(type: DocumentType): {
  readonly startkey: string
  readonly endkey: string
} {
  const prefix = DOCUMENT_PREFIX[type]
  return { startkey: prefix, endkey: `${prefix}${HIGHEST_ID_CHARACTER}` }
}
