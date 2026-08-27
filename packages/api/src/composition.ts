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

import { googleProvider, jwksCache, verifyGoogleIdToken } from './auth/google.js'
import { type SigningKey, signingKeyFromPem } from './auth/jwt.js'
import type { Provider } from './auth/oidc.js'
import type { AuthDependencies } from './auth/routes.js'
import { type CouchClient, couchClient } from './couch/client.js'
import { type ProfileStore, profileStore } from './profile/store.js'
import { checkDesignDocs } from './projects/design-docs.js'
import { originsFromEnv } from './security/config.js'
import type { ServerOptions } from './server.js'

/** The environment, as far as this module is concerned. */
export type Environment = Record<string, string | undefined>

/**
 * A variable's value, or `undefined` when it is unset **or empty**.
 *
 * The two are the same thing here. A deployment tool that renders `GOOGLE_CLIENT_ID=` for a
 * secret it has not been given has not configured sign-in, and treating the empty string as a
 * value would build a provider that reaches Google and is refused for a client id of `""`.
 */
const value = (raw: string | undefined): string | undefined =>
  raw === undefined || raw === '' ? undefined : raw

/** The signing key, if this deployment has one. */
function keyFrom(env: Environment): SigningKey | undefined {
  const pem = value(env.JWT_PRIVATE_KEY)
  const kid = value(env.JWT_KEY_ID)
  if (pem === undefined || kid === undefined) return undefined
  return signingKeyFromPem(kid, pem)
}

/** CouchDB, if this deployment has it. */
function couchFrom(env: Environment): CouchClient | undefined {
  const url = value(env.COUCHDB_URL)
  const user = value(env.COUCHDB_ADMIN_USER)
  const password = value(env.COUCHDB_ADMIN_PASSWORD)
  if (url === undefined || user === undefined || password === undefined) return undefined
  return couchClient({ url, user, password })
}

/**
 * Where the browser is returned to after signing in.
 *
 * Trailing slashes are trimmed because the callback builds `${appOrigin}/`, and
 * `https://app.example//` is a path the application does not serve — a sign-in that succeeds
 * and lands on a 404 is the least informative failure this flow has. The CORS policy tolerates
 * the slash separately, so a deployment writing one is not wrong, merely unhelpfully literal.
 */
function appOriginFrom(env: Environment): string | undefined {
  const origin = value(env.APP_ORIGIN)
  return origin === undefined ? undefined : origin.replace(/\/+$/, '')
}

/** Google, if this deployment has a client registered. */
function providerFrom(env: Environment): Provider | undefined {
  const clientId = value(env.GOOGLE_CLIENT_ID)
  const clientSecret = value(env.GOOGLE_CLIENT_SECRET)
  // No default is possible: Google matches this byte-for-byte against what was registered in
  // the console, so a value this service invented would be wrong in every deployment.
  const redirectUri = value(env.GOOGLE_REDIRECT_URI)
  if (clientId === undefined || clientSecret === undefined || redirectUri === undefined) {
    return undefined
  }
  return googleProvider({ clientId, clientSecret, redirectUri })
}

/**
 * Everything sign-in needs, if this deployment has all of it.
 *
 * Needs the profile store as well as the provider, because signing in **writes**: `remember`
 * creates or updates the `_users` document that the session then identifies. Sign-in without
 * somewhere to record the user would authenticate somebody into an account that does not exist.
 */
function authFrom(
  env: Environment,
  key: SigningKey,
  store: ProfileStore,
): AuthDependencies | undefined {
  const provider = providerFrom(env)
  const appOrigin = appOriginFrom(env)
  if (provider === undefined || appOrigin === undefined) return undefined

  // One cache per process, not per sign-in. Built here rather than inside `verifyIdToken` so
  // that Google's keys are fetched once and reused; a cache constructed per call would be a
  // cache that never hits, and would fetch a JWKS on the critical path of every sign-in.
  const keys = jwksCache(provider.jwksUri)

  return {
    provider,
    key,
    verifyIdToken: (idToken: string) => verifyGoogleIdToken(provider, idToken, keys),
    appOrigin,
    rememberUser: (identity) => store.remember(identity),
  }
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
  const couch = couchFrom(env)

  // Both halves are needed: CouchDB to hold the data, and the key to know who is asking. One
  // without the other is a deployment part-way through being set up, and the honest answer is
  // that the routes are not there yet.
  if (couch === undefined || key === undefined) return { security }

  // Read now rather than at the first project. See `design-docs.ts`.
  checkDesignDocs()

  const store = profileStore(couch)
  const auth = authFrom(env, key, store)

  return {
    security,
    projects: { couch, key },
    // Needs only what is already present. `GET /profile` answers 401 without a session, which
    // is the truthful answer whether or not this deployment can issue one.
    profile: { store, key },
    ...(auth === undefined ? {} : { auth }),
  }
}
