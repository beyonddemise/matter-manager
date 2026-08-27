import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import {
  ACCESS_DESIGN_FILE,
  accessValidator,
  DESIGN_DOCS_DIRECTORY,
  findDesignDocs,
} from '../../src/projects/design-docs.js'

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '../../../..')

describe('finding the design documents', () => {
  it('finds them from this module', () => {
    expect(findDesignDocs()).toBe(join(repoRoot, DESIGN_DOCS_DIRECTORY))
  })

  it('finds them from a built layout too', () => {
    // The reason this walks up instead of counting `..`: the module runs from `src/` under
    // vitest and from `dist/src/` when built, and a hard-coded depth is right in one and
    // silently wrong in the other — wrong at the moment somebody creates a project.
    expect(findDesignDocs(join(repoRoot, 'packages/api/dist/src/projects'))).toBe(
      join(repoRoot, DESIGN_DOCS_DIRECTORY),
    )
  })

  it('gives back nothing when they are not above the starting point', () => {
    const empty = mkdtempSync(join(tmpdir(), 'design-docs-test-'))
    try {
      expect(findDesignDocs(empty)).toBeUndefined()
    } finally {
      rmSync(empty, { recursive: true, force: true })
    }
  })
})

describe('the access rules', () => {
  it('are the ones this repository ships', () => {
    // **The point of reading rather than embedding.** CI's "CouchDB access model" job proves
    // against a real CouchDB that this exact function refuses a reader's write and an edit to
    // an audit entry. A copy here would mean CI verifies a file this service does not install.
    const shipped = readFileSync(join(repoRoot, DESIGN_DOCS_DIRECTORY, ACCESS_DESIGN_FILE), 'utf8')

    expect(shipped).toContain(accessValidator())
  })

  it('begin at the function, not at the comment above it', () => {
    // CouchDB stores this as the function source. A leading comment block is not a function.
    expect(accessValidator().startsWith('function (')).toBe(true)
  })

  it('are sliced exactly the way the verifier slices them', () => {
    // Same file, same rule, two readers — so this asserts they agree rather than assuming it.
    // `verify-access-model.sh` uses `src.indexOf("function (")`; anything else here would
    // install a function CI never tested.
    const viaNode = execFileSync(
      'node',
      [
        '-e',
        `const s = require('fs').readFileSync(process.argv[1], 'utf8');` +
          `process.stdout.write(s.slice(s.indexOf('function (')).trim())`,
        join(repoRoot, DESIGN_DOCS_DIRECTORY, ACCESS_DESIGN_FILE),
      ],
      { encoding: 'utf8' },
    )

    expect(accessValidator()).toBe(viaNode)
  })

  it('still enforce the two rules the whole model rests on', () => {
    // Not a duplicate of the CI job, which runs this against a real server. This is the cheap
    // check that the file being installed is the file somebody meant — if a refactor emptied
    // it, every project would be created with rules that permit everything, and nothing here
    // would fail until CI ran.
    const source = accessValidator()

    expect(source).toContain('read-only access')
    expect(source).toContain('Audit entries are immutable')
  })
})

describe('when they are missing', () => {
  it('says so, and says why it matters', () => {
    // A deployment that did not ship them must not discover it at the moment a user presses
    // the button — see `checkDesignDocs`, which is called at startup.
    const empty = mkdtempSync(join(tmpdir(), 'design-docs-test-'))
    try {
      expect(() => accessValidator(empty)).toThrow(/writable by every member/)
    } finally {
      rmSync(empty, { recursive: true, force: true })
    }
  })

  it('refuses a file with no function in it', () => {
    const directory = mkdtempSync(join(tmpdir(), 'design-docs-test-'))
    try {
      mkdirSync(directory, { recursive: true })
      writeFileSync(join(directory, ACCESS_DESIGN_FILE), '// nothing here yet\n')

      expect(() => accessValidator(directory)).toThrow(/nothing to install/)
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })
})
