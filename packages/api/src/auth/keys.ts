/**
 * Getting the signing key into CouchDB, and refusing to serve traffic until it is in effect.
 *
 * The public key is written to CouchDB's configuration at startup, so **key material never
 * enters the image**. The private half comes from the environment; the public half is pushed to
 * `PUT /_node/<node>/_config/jwt_keys/ec:<kid>`.
 *
 * `[jwt_keys]` is applied **live** — verified against CouchDB 3.5.2 in
 * `infra/couchdb/verify-jwt-model.sh` — which is what makes zero-downtime rotation possible:
 * add a key under a new `kid`, switch issuance to it, and tokens carrying the old `kid` keep
 * validating until they expire.
 *
 * **The trap is a neighbouring setting.** `[chttpd] authentication_handlers` is read only at
 * *startup*. Setting it at runtime returns 200, does nothing, and leaves every request
 * authenticating as **anonymous** rather than failing — which looks exactly like a permissions
 * bug and is not one. Production bakes it into the image (`infra/couchdb/local.ini`), so this
 * bites during experimentation rather than in operation, and only if you assume the two
 * settings behave alike. They do not, and this module does not touch it.
 *
 * @module
 */

import { mintToken, publicKeyForCouch, type SigningKey } from './jwt.js'

/** Writing config and probing with a token are not `CouchClient` operations; they are these. */
export interface CouchAdmin {
  /** `PUT /_node/<node>/_config/<section>/<name>`. */
  putConfig(section: string, name: string, value: string): Promise<void>
  /**
   * Makes a request **as a bearer**, returning the status.
   *
   * The point of the whole exercise: this is the only way to find out whether CouchDB will
   * accept the tokens this service mints, and it has to be asked rather than assumed.
   */
  statusAsBearer(token: string, path: string): Promise<number>
}

/** Thrown when CouchDB will not accept what this service mints. */
export class KeyInstallationError extends Error {
  override readonly name = 'KeyInstallationError'
}

/**
 * Installs a signing key in CouchDB and verifies that CouchDB accepts tokens signed with it.
 *
 * @param key - The signing key to install and validate
 * @param probePath - The CouchDB path used to verify token authentication
 * @throws KeyInstallationError if CouchDB rejects the signed token or is unavailable
 */
export async function installSigningKey(
  admin: CouchAdmin,
  key: SigningKey,
  probePath = '/_session',
): Promise<void> {
  // `ec:` because CouchDB keys the section by algorithm family. An `rsa:` prefix here is a key
  // CouchDB looks for when validating RS256 and never finds when validating ES256.
  await admin.putConfig('jwt_keys', `ec:${key.kid}`, publicKeyForCouch(key.publicKey))

  const probe = mintToken(key, {
    purpose: 'access',
    sub: `startup-probe-${key.kid}`,
    exp: Math.floor(Date.now() / 1000) + 60,
  })

  const status = await admin.statusAsBearer(probe, probePath)

  // 401 is the answer that matters: CouchDB read the token and rejected it, which means the key
  // did not take. A 403 would mean the token was *accepted* and the probe user simply has no
  // rights, which is expected and fine — the question here is authentication, not authorisation.
  if (status === 401) {
    throw new KeyInstallationError(
      `CouchDB refused a token signed with key "${key.kid}" immediately after that key was installed. ` +
        'The key is in the configuration but not in effect — check that the value has no PEM banner ' +
        'or newlines, and that the section is [jwt_keys] with an "ec:" prefix.',
    )
  }

  if (status >= 500) {
    throw new KeyInstallationError(
      `CouchDB answered ${status} while checking key "${key.kid}". It is not ready to authenticate anyone.`,
    )
  }
}

/**
 * A {@link CouchAdmin} over the same `fetch` the rest of the service uses.
 *
 * `_local` rather than a resolved node name: it is the alias CouchDB gives to the node handling
 * the request, and using it means this works on a single node without anybody having to
 * configure what that node is called.
 */
export function couchAdmin(
  url: string,
  user: string,
  password: string,
  fetchImpl: typeof fetch = fetch,
): CouchAdmin {
  const base = url.replace(/\/+$/, '')
  const auth = `Basic ${Buffer.from(`${user}:${password}`).toString('base64')}`

  return {
    async putConfig(section, name, value) {
      const response = await fetchImpl(
        `${base}/_node/_local/_config/${encodeURIComponent(section)}/${encodeURIComponent(name)}`,
        {
          method: 'PUT',
          headers: { authorization: auth, 'content-type': 'application/json' },
          // A config value is a JSON *string*, quotes and all. Sending it bare is a 400 that
          // reads like a bad key rather than a bad body.
          body: JSON.stringify(value),
        },
      )
      if (!response.ok) {
        throw new KeyInstallationError(
          `CouchDB refused the configuration write ${section}/${name}: ${response.status}.`,
        )
      }
    },

    async statusAsBearer(token, path) {
      const response = await fetchImpl(`${base}${path}`, {
        headers: { authorization: `Bearer ${token}` },
      })
      return response.status
    },
  }
}
