/**
 * The document every project database keeps about itself.
 *
 * It replicates to every device with the project's data, so a replica can say which project it
 * is, and which server database it belongs to, without asking the registry. The backend writes
 * it at provisioning and keeps it in step on rename (`backend/src/projects`); it lives here so
 * the frontend and the backend agree on one shape.
 *
 * @module
 */

/** The fixed id of the project document, so it can be fetched without a query. */
export const PROJECT_DOCUMENT_ID = 'project'

/** The project as its own database describes it. */
export interface ProjectDocument {
  readonly _id: typeof PROJECT_DOCUMENT_ID
  readonly _rev?: string
  readonly type: 'project'
  readonly name: string
  /** Who the project is for. Absent rather than empty. */
  readonly client?: string
  /**
   * The name of the project's database on the server. Absent while the project is local-only:
   * the frontend writes this document there, and there is no server database to name yet.
   *
   * Vestigial on the frontend: the service writes it on server databases, and promote no longer
   * does — the copy is the server-named database itself, and the `project` document does not
   * travel with it. Kept optional so a document written either way still reads as valid.
   */
  readonly serverDb?: string
}

/**
 * Whether a value read from a database is a project document.
 *
 * Checks the discriminators and the required fields (`serverDb` and `client` strict when present),
 * not the extras: documents may gain fields in later phases and an old client must still recognise
 * one.
 */
export function isProjectDocument(value: unknown): value is ProjectDocument {
  if (typeof value !== 'object' || value === null) return false
  const doc = value as Record<string, unknown>
  return (
    doc._id === PROJECT_DOCUMENT_ID &&
    doc.type === 'project' &&
    typeof doc.name === 'string' &&
    (doc.serverDb === undefined || typeof doc.serverDb === 'string') &&
    (doc.client === undefined || typeof doc.client === 'string')
  )
}
