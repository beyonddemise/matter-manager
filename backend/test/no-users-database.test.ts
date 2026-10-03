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

describe('the backend never touches _users', () => {
  it('names neither the database nor its document ids anywhere in src', () => {
    // Matched as a string literal only, so prose in a comment that explains the history does
    // not trip it; what must never come back is code that reads or writes the database.
    const offenders = sources(join(import.meta.dirname, '../src'))
      .filter((path) => !path.includes('/generated/'))
      .filter((path) => /['"`]_users['"`]|org\.couchdb\.user:/.test(readFileSync(path, 'utf8')))
    expect(offenders).toEqual([])
  })
})
