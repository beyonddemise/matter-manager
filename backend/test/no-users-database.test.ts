import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

/** Every .ts file under a directory. */
function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name)
    return statSync(path).isDirectory() ? sources(path) : path.endsWith('.ts') ? [path] : []
  })
}

/**
 * A quote, backtick or slash directly before `_users` (so `'_users'`, `'/_users/_find'` and
 * `` `/_users/${id}` `` all match, and prose such as "the _users database" does not), or a
 * CouchDB user document id prefix.
 */
const FORBIDDEN = /['"`/]_users\b|org\.couchdb\.user:/

describe('the backend never touches _users', () => {
  it('matches path and literal forms and not prose', () => {
    // The self-test that keeps the pattern honest: a regex loosened until it matches nothing
    // would leave the check below green for the wrong reason.
    expect(FORBIDDEN.test("'/_users/x'")).toBe(true)
    expect(FORBIDDEN.test("'_users'")).toBe(true)
    expect(FORBIDDEN.test('`/_users/' + '$' + '{id}`')).toBe(true)
    expect(FORBIDDEN.test('the old _users database')).toBe(false)
  })

  it('names neither the database nor its document ids anywhere in src', () => {
    // Matched by what precedes the name (a quote or a slash), so prose in a comment that
    // explains the history does not trip it; what must never come back is code that reads or
    // writes the database.
    const offenders = sources(join(import.meta.dirname, '../src'))
      .filter((path) => !path.includes('/generated/'))
      .filter((path) => FORBIDDEN.test(readFileSync(path, 'utf8')))
    expect(offenders).toEqual([])
  })
})
