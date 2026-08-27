/**
 * Loading the `validate_doc_update` function that CouchDB enforces.
 *
 * **There is exactly one copy of that function**, at `infra/couchdb/design-docs/access.js`, and
 * this reads it rather than embedding it. That is lesson L13 rather than tidiness: the CI job
 * "CouchDB access model" runs `verify-access-model.sh`, which extracts the function from that
 * same file and proves against a real CouchDB that a reader cannot write and that audit entries
 * cannot be edited. An embedded copy here would mean CI verifies a file this service does not
 * install, and the two could drift with everything green.
 *
 * The file is a bare `function (` expression — not a module, so it cannot be imported — which
 * is why it is sliced out of the source exactly as the shell script does it.
 *
 * @module
 */

import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

/** Where the design documents live, relative to the repository root. */
export const DESIGN_DOCS_DIRECTORY = join('infra', 'couchdb', 'design-docs')

/** The file holding the access rules. */
export const ACCESS_DESIGN_FILE = 'access.js'

/**
 * Finds the design-doc directory by walking up from a starting point.
 *
 * Walking rather than counting `..` segments, because this module is loaded from `src/` under
 * vitest and from `dist/src/` when built, and a hard-coded depth would be right in one and
 * silently wrong in the other — wrong in the way that only shows up when a project is created.
 *
 * @param from where to start; defaults to this module's own directory
 * @returns the directory, or `undefined` if it is not above `from`
 */
export function findDesignDocs(from: string = import.meta.dirname): string | undefined {
  let directory = from
  for (;;) {
    const candidate = join(directory, DESIGN_DOCS_DIRECTORY)
    if (existsSync(join(candidate, ACCESS_DESIGN_FILE))) return candidate

    const parent = dirname(directory)
    if (parent === directory) return undefined
    directory = parent
  }
}

/**
 * The access rules, as the string CouchDB stores.
 *
 * Sliced from the first `function (`, which is how `verify-access-model.sh` does it — the file
 * begins with a comment block explaining itself, and neither the script nor this may include
 * it, because CouchDB stores the value as the function source.
 *
 * @param directory where to look; `DESIGN_DOCS_DIR` in the environment, or found by walking up
 * @throws {Error} when the file is missing. Loud, and at startup — see {@link checkDesignDocs}.
 */
export function accessValidator(directory = process.env.DESIGN_DOCS_DIR): string {
  const found = directory ?? findDesignDocs()
  // The existence check covers the configured directory as well as the discovered one. Without
  // it, `DESIGN_DOCS_DIR` pointing somewhere wrong produces `ENOENT`, which says nothing about
  // what was missing or why it matters.
  if (found === undefined || !existsSync(join(found, ACCESS_DESIGN_FILE))) {
    throw new Error(
      `Cannot find ${DESIGN_DOCS_DIRECTORY}/${ACCESS_DESIGN_FILE}. It has to ship with this ` +
        'service: without it a project database cannot be given its access rules, and a ' +
        'project database without them is writable by every member. Set DESIGN_DOCS_DIR.',
    )
  }

  const source = readFileSync(join(found, ACCESS_DESIGN_FILE), 'utf8')
  const start = source.indexOf('function (')
  if (start === -1) {
    throw new Error(
      `${join(found, ACCESS_DESIGN_FILE)} contains no "function (" — CouchDB stores this as ` +
        'the function source, so there is nothing to install.',
    )
  }

  return source.slice(start).trim()
}

/**
 * Reads the design documents once, so a deployment missing them fails at startup.
 *
 * The alternative is a service that starts, passes its health check, and fails at the moment a
 * user creates their first project — which is both the least convenient moment to find out and
 * the one where the failure is most likely to be read as "the button is broken".
 */
export function checkDesignDocs(): void {
  accessValidator()
}
