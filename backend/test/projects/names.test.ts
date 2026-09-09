import { describe, expect, it } from 'vitest'
import {
  COUCHDB_DATABASE_NAME,
  isProjectDatabase,
  PROJECT_DATABASE_PREFIX,
  projectDatabaseName,
  projectIdOf,
} from '../../src/projects/names.js'

const PROJECT_ID = '8f14e45f-ceea-467a-9c0e-1b2c3d4e5f60'

describe('naming a project database', () => {
  it('is the prefix and the project id', () => {
    // ADR 0003 and the OpenAPI contract both say `project_<uuid>`. `docs/DATA-MODEL.md` had an
    // example with the hyphens replaced by underscores; CouchDB permits hyphens, this
    // repository's own access-model verifier creates `verify-access-model-$$`, and one
    // representation beats two — so the hyphens stay and the example was corrected.
    expect(projectDatabaseName(PROJECT_ID)).toBe(`project_${PROJECT_ID}`)
  })

  it('produces a name CouchDB accepts', () => {
    // The rule from the CouchDB documentation, which is stricter than it looks: it must begin
    // with a lower-case letter, which is why the prefix is not optional.
    expect(projectDatabaseName(PROJECT_ID)).toMatch(COUCHDB_DATABASE_NAME)
  })

  it('refuses anything that is not a uuid', () => {
    // A database name is assembled from this. Anything that reaches CouchDB unvalidated is a
    // name somebody else chose, and `../` and `_users` are both names somebody might choose.
    for (const bad of ['', '../_users', 'Project', `${PROJECT_ID} `, `${PROJECT_ID}/x`]) {
      expect(() => projectDatabaseName(bad)).toThrow(/uuid/i)
    }
  })

  it('refuses a uuid in capitals rather than folding it', () => {
    // Folding would mean two project ids naming one database. Refusing means whoever generated
    // it finds out immediately — and `crypto.randomUUID()` is lower case, so nothing legitimate
    // is refused.
    expect(() => projectDatabaseName(PROJECT_ID.toUpperCase())).toThrow(/uuid/i)
  })
})

describe('reading a database name back', () => {
  it('recovers the project id', () => {
    expect(projectIdOf(projectDatabaseName(PROJECT_ID))).toBe(PROJECT_ID)
  })

  it('does not recognise a database this application did not name', () => {
    // `_users`, `_replicator`, `projects`. The rollback path deletes a database by name, so
    // "is this one of ours" is a question with consequences.
    for (const other of ['_users', '_replicator', 'projects', 'project', 'projects_x']) {
      expect(isProjectDatabase(other)).toBe(false)
    }
  })

  it('does not recognise the prefix with something that is not a uuid after it', () => {
    expect(isProjectDatabase(`${PROJECT_DATABASE_PREFIX}../_users`)).toBe(false)
  })

  it('recognises one it named', () => {
    expect(isProjectDatabase(projectDatabaseName(PROJECT_ID))).toBe(true)
  })

  it('gives back nothing for a name it does not recognise', () => {
    expect(projectIdOf('_users')).toBeUndefined()
  })
})
