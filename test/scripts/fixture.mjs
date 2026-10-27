/**
 * Harness for the root guard-script tests: runs a guard against a throwaway repository.
 *
 * The guards resolve the repository root from their own location (`scripts/..`), so pointing
 * one at a fixture tree means giving it a fixture tree to live in: each run copies the script
 * byte-for-byte into `<tmp>/scripts/` and builds the repository around it. The copy is made
 * from the shipped file at run time, so it cannot drift from the artefact CI executes — the
 * hand-maintained-duplicate trap (lessons L13) does not apply.
 *
 * Same shape as `frontend/test/ui/deploy/`: spawn the checker as a child process, assert on
 * its combined output and exit code, and always include a positive control so a harness that
 * failed everything could not read as thorough (lesson L3).
 */

import { spawnSync } from 'node:child_process'
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const repositoryRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..')

/**
 * Runs `scripts/<script>` against a fixture repository containing exactly `files`.
 *
 * @param {string} script  file name under `scripts/`, e.g. `check-npmrc.mjs`
 * @param {Record<string, string>} files  fixture tree: relative path -> contents
 * @returns {{ code: number, output: string }}  exit code and stdout+stderr combined
 */
export function runGuard(script, files) {
  const root = mkdtempSync(join(tmpdir(), `${script.replace(/[^\w-]/g, '-')}-`))
  try {
    mkdirSync(join(root, 'scripts'))
    copyFileSync(join(repositoryRoot, 'scripts', script), join(root, 'scripts', script))
    for (const [path, contents] of Object.entries(files)) {
      mkdirSync(dirname(join(root, path)), { recursive: true })
      writeFileSync(join(root, path), contents)
    }
    const result = spawnSync('node', [join(root, 'scripts', script)], { encoding: 'utf8' })
    return { code: result.status ?? -1, output: `${result.stdout}${result.stderr}` }
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

/**
 * Runs `scripts/<script>` against this repository itself.
 *
 * The positive control that matters most: every fixture above proves the guard can say no,
 * and this proves the tree it actually guards says yes.
 */
export function runGuardOnRepository(script) {
  const result = spawnSync('node', [join(repositoryRoot, 'scripts', script)], {
    encoding: 'utf8',
  })
  return { code: result.status ?? -1, output: `${result.stdout}${result.stderr}` }
}
