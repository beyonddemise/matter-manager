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
 * bug and is not one. Both images bake it in from `infra/couchdb/00-base.ini`, so this
 * bites during experimentation rather than in operation, and only if you assume the two
 * settings behave alike. They do not, and this module does not touch it.
 *
 * @module
 */

import { mintToken, publicKeyForCouch, type SigningKey } from './jwt.js'

/**
 * What CouchDB says when asked who is making a request.
 *
 * The status alone cannot answer the question this module exists to ask. A CouchDB with no JWT
 * handler does not *reject* a bearer token — it ignores it, and the request proceeds as nobody.
 * Whether that then reads as 401 or 200 depends on `require_valid_user`, so a status check is
 * reading a setting that has nothing to do with the key. `userCtx.name` is the direct answer:
 * it is the subject of the token when the token was understood, and absent when it was not.
 */
export interface SessionProbe {
  readonly status: number
  /** `userCtx.name`: who CouchDB believes is asking, absent when nobody. */
  readonly name?: string
  /** `info.authenticated`: which handler decided, e.g. `jwt`. */
  readonly authenticated?: string
}

/** Writing config and probing with a token are not `CouchClient` operations; they are these. */
export interface CouchAdmin {
  /** `PUT /_node/<node>/_config/<section>/<name>`. */
  putConfig(section: string, name: string, value: string): Promise<void>
  /**
   * `GET /_node/<node>/_config/<section>/<name>`, or `undefined` when it is not set.
   *
   * Absent is a real answer rather than an error: CouchDB answers 404 for a key that was never
   * written, and a setting left at its built-in default is exactly the case this module has to
   * detect.
   */
  getConfig(section: string, name: string): Promise<string | undefined>
  /**
   * Makes a request **as a bearer** and reports who CouchDB thought was asking.
   *
   * The point of the whole exercise: this is the only way to find out whether CouchDB will
   * accept the tokens this service mints, and it has to be asked rather than assumed.
   */
  sessionAsBearer(token: string, path: string): Promise<SessionProbe>
}

/**
 * The handler that makes CouchDB read a bearer token at all.
 *
 * Unlike `[jwt_keys]`, `[chttpd] authentication_handlers` is read **only at CouchDB startup**.
 * Writing it at runtime returns 200 and changes nothing, so this module refuses rather than
 * pretending it can fix it. See the note at the top of this file.
 */
const JWT_HANDLER = 'jwt_authentication_handler'

/** Thrown when CouchDB will not accept what this service mints. */
export class KeyInstallationError extends Error {
  override readonly name = 'KeyInstallationError'
}

/** Thrown when CouchDB would refuse the browsers this deployment serves. */
export class CorsOriginError extends Error {
  override readonly name = 'CorsOriginError'
}

/**
 * Confirms CouchDB will accept cross-origin replication from the origins this deployment uses.
 *
 * **Verified rather than written, deliberately.** `[cors] origins` is applied live, so this
 * service could set it — but it is a deployment value, and the two environments legitimately
 * differ: development serves `vite` and `vite preview` on separate ports, so overwriting the
 * list with the single origin the API happens to know would narrow it. Checking asserts the
 * agreement without taking ownership of a list this service does not fully know.
 *
 * What it catches is the failure the production overlay warns about in a comment and nothing
 * enforced: an `origins` left at its placeholder. Replication then fails from the real origin
 * with an opaque browser CORS error that reads as a network fault rather than a configuration
 * one — expensive to diagnose, and invisible until a user tries to sync.
 *
 * @param expected every origin the browser may replicate from, from `originsFromEnv`.
 * @throws {CorsOriginError} naming the origins CouchDB would turn away.
 */
export async function verifyCorsOrigins(
  admin: CouchAdmin,
  expected: readonly string[],
): Promise<void> {
  // Nothing to check against. A deployment that names no origin has not been told where its
  // application lives, which `serverOptions` already treats as not-yet-configured.
  if (expected.length === 0) return

  const configured = await admin.getConfig('cors', 'origins')
  const allowed = new Set(
    (configured ?? '')
      .split(',')
      .map((origin) => origin.trim())
      .filter((origin) => origin !== ''),
  )

  const missing = expected.filter((origin) => !allowed.has(origin))
  if (missing.length > 0) {
    throw new CorsOriginError(
      `CouchDB would refuse replication from ${missing.join(', ')}: its [cors] origins is ` +
        `${configured === undefined ? 'unset' : `"${configured}"`}. That list is a deployment ` +
        'value — set it in the overlay beside the image (infra/couchdb/10-production.ini, ' +
        '.devcontainer/couchdb/10-development.ini) so it names every origin the application is ' +
        'served from.',
    )
  }
}

/**
 * Publishes the public key and confirms CouchDB accepts a token signed with its private half.
 *
 * The confirmation is the point, and it is why this cannot be a fire-and-forget `PUT`. Writing a
 * key to `[jwt_keys]` succeeds for a value CouchDB cannot parse — a PEM with its banner lines
 * still attached is accepted into the config and then fails to load — so the configuration looks
 * correct while every token is refused. The only honest check is to mint one and ask.
 *
 * @param probePath the CouchDB path the minted token is tried against
 * @throws {KeyInstallationError} rather than starting. A service that serves traffic knowing its
 *   tokens do not work is a service whose users see replication fail with no explanation,
 *   intermittently, for as long as it runs. Failing to start is loud, immediate, and points at
 *   the right thing.
 */
export async function installSigningKey(
  admin: CouchAdmin,
  key: SigningKey,
  probePath = '/_session',
): Promise<void> {
  // Checked before anything is written, because this one cannot be repaired from here and the
  // diagnosis is otherwise indistinguishable from a bad key: without the handler CouchDB never
  // looks at the token, so every symptom points at the key that is in fact perfectly good.
  const handlers = await admin.getConfig('chttpd', 'authentication_handlers')
  if (handlers === undefined || !handlers.includes(JWT_HANDLER)) {
    throw new KeyInstallationError(
      `CouchDB is not configured to read bearer tokens: [chttpd] authentication_handlers ${
        handlers === undefined ? 'is unset, so the built-in default applies' : `is "${handlers}"`
      } and does not include ${JWT_HANDLER}. ` +
        'That setting is read only when CouchDB starts, so this service cannot fix it — add the ' +
        'handler to infra/couchdb/00-base.ini, which both images bake in, and restart CouchDB.',
    )
  }

  // `ec:` because CouchDB keys the section by algorithm family. An `rsa:` prefix here is a key
  // CouchDB looks for when validating RS256 and never finds when validating ES256.
  await admin.putConfig('jwt_keys', `ec:${key.kid}`, publicKeyForCouch(key.publicKey))

  // Applied live, like `[jwt_keys]`, so it is set here rather than baked in — one less thing
  // that can differ between the image and what this service assumes. Without it CouchDB accepts
  // a token carrying no `exp` at all, which is a credential that never stops working.
  await admin.putConfig('jwt_auth', 'required_claims', 'exp')

  const sub = `startup-probe-${key.kid}`
  const probe = mintToken(key, {
    purpose: 'access',
    sub,
    exp: Math.floor(Date.now() / 1000) + 60,
  })

  const session = await admin.sessionAsBearer(probe, probePath)

  if (session.status >= 500) {
    throw new KeyInstallationError(
      `CouchDB answered ${session.status} while checking key "${key.kid}". It is not ready to authenticate anyone.`,
    )
  }

  // The positive assertion, and the reason this is not a status check. CouchDB naming the
  // probe's own subject is proof the token was read, understood and believed. Anything else —
  // a 401, or a 200 as nobody — means the tokens this service is about to mint are not
  // credentials as far as the database is concerned.
  if (session.name !== sub) {
    throw new KeyInstallationError(
      `CouchDB did not accept a token signed with key "${key.kid}" immediately after that key was ` +
        `installed: it answered ${session.status} and identified the caller as ` +
        `${session.name === undefined ? 'nobody' : `"${session.name}"`}` +
        `${session.authenticated === undefined ? '' : ` (via ${session.authenticated})`}, ` +
        `not as "${sub}". The key is in the configuration but not in effect — check that the ` +
        'value has no PEM banner or newlines, and that the section is [jwt_keys] with an ' +
        '"ec:" prefix.',
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
  timeoutMs = 10_000,
): CouchAdmin {
  const base = url.replace(/\/+$/, '')
  const auth = `Basic ${Buffer.from(`${user}:${password}`).toString('base64')}`

  /**
   * Every request this module makes, with a deadline.
   *
   * Node's `fetch` applies no request timeout of its own, so a CouchDB that accepts the
   * connection and then says nothing leaves the promise pending forever. Startup awaits these
   * before anything listens, which turns that into a process that hangs with no log line and
   * no failure — the exact outcome this module exists to prevent, reached by another route.
   */
  async function ask(
    target: string,
    init: RequestInit,
  ): Promise<{ status: number; ok: boolean; body: string }> {
    try {
      const response = await fetchImpl(target, { ...init, signal: AbortSignal.timeout(timeoutMs) })
      // **The body is read inside the boundary, deliberately.** A CouchDB that sends headers
      // and then stalls aborts here rather than at `fetch`, and outside this `try` that
      // surfaces as an ordinary error: `sessionAsBearer` would swallow it as an unparseable
      // body, report nobody, and `installSigningKey` would blame a key that is perfectly good.
      // Which is the misdiagnosis this whole module exists to prevent.
      return { status: response.status, ok: response.ok, body: await response.text() }
    } catch (error) {
      const name = error instanceof Error ? error.name : ''
      if (name === 'TimeoutError' || name === 'AbortError') {
        throw new KeyInstallationError(
          `CouchDB did not answer within ${timeoutMs}ms. It is reachable but not responding, so ` +
            'this service cannot confirm it will accept the tokens it issues.',
        )
      }
      throw error
    }
  }

  return {
    async putConfig(section, name, value) {
      const response = await ask(
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

    async getConfig(section, name) {
      const response = await ask(
        `${base}/_node/_local/_config/${encodeURIComponent(section)}/${encodeURIComponent(name)}`,
        { headers: { authorization: auth, accept: 'application/json' } },
      )
      // A key that was never written is not a failure to report — it is the answer, and it is
      // the one that matters most here.
      if (response.status === 404) return undefined
      if (!response.ok) {
        throw new KeyInstallationError(
          `CouchDB refused the configuration read ${section}/${name}: ${response.status}.`,
        )
      }
      // Values come back as JSON strings, the same shape `putConfig` sends.
      return JSON.parse(response.body) as string
    },

    async sessionAsBearer(token, path) {
      const response = await ask(`${base}${path}`, {
        headers: { authorization: `Bearer ${token}`, accept: 'application/json' },
      })

      // The body is the answer, but a refusal is allowed to have no usable one: CouchDB may
      // return a problem document, or nothing. Failing to parse it is not itself the failure —
      // the caller reads an absent name as "not authenticated", which is exactly right.
      let name: string | undefined
      let authenticated: string | undefined
      try {
        const body = JSON.parse(response.body) as {
          userCtx?: { name?: string | null }
          info?: { authenticated?: string }
        }
        name = body.userCtx?.name ?? undefined
        authenticated = body.info?.authenticated
      } catch {
        // Left undefined.
      }

      return {
        status: response.status,
        ...(name === undefined ? {} : { name }),
        ...(authenticated === undefined ? {} : { authenticated }),
      }
    },
  }
}
