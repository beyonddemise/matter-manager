/**
 * Turning environment variables into a configured service.
 *
 * `buildServer` registers a route group only when its dependencies are supplied, and this is
 * what decides whether they are. **Absent means absent**: a deployment with no CouchDB
 * credentials serves `/healthz` and nothing else, rather than serving `POST /projects` and
 * failing at the moment somebody presses the button.
 *
 * Separate from `main.ts` so that it can be tested. `main.ts` listens on a port, which makes it
 * the one file that cannot be, so it should hold nothing worth testing.
 *
 * @module
 */

import { type SigningKey, signingKeyFromPem } from './auth/jwt.js'
import { couchClient } from './couch/client.js'
import { checkDesignDocs } from './projects/design-docs.js'
import { originsFromEnv } from './security/config.js'
import type { ServerOptions } from './server.js'

/** The environment, as far as this module is concerned. */
export type Environment = Record<string, string | undefined>

/** The signing key, if this deployment has one. */
function keyFrom(env: Environment): SigningKey | undefined {
  const pem = env.JWT_PRIVATE_KEY
  const kid = env.JWT_KEY_ID
  if (pem === undefined || pem === '' || kid === undefined || kid === '') return undefined
  return signingKeyFromPem(kid, pem)
}

/**
 * What the service should be built with, given this environment.
 *
 * @throws {Error} when CouchDB is configured but the design documents cannot be found, or when
 *   an origin is unusable. Both at startup, deliberately: a service that starts and then cannot
 *   create a project has moved the failure to the least convenient moment, and made it look
 *   like the button is broken rather than like the deployment is incomplete.
 */
export function serverOptions(env: Environment = process.env): ServerOptions {
  const security = { origins: originsFromEnv(env) }
  const key = keyFrom(env)

  const url = env.COUCHDB_URL
  const user = env.COUCHDB_ADMIN_USER
  const password = env.COUCHDB_ADMIN_PASSWORD

  const couchConfigured =
    url !== undefined && url !== '' && user !== undefined && password !== undefined

  // Both halves are needed: CouchDB to create the database, and the key to know who is asking.
  // One without the other is a deployment part-way through being set up, and the honest answer
  // is that the routes are not there yet.
  if (!couchConfigured || key === undefined) return { security }

  // Read now rather than at the first project. See `design-docs.ts`.
  checkDesignDocs()

  return {
    security,
    projects: { couch: couchClient({ url, user, password }), key },
  }
}
