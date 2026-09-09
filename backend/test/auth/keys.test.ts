import { generateKeyPairSync } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { signingKeyFromPem, verifyToken } from '../../src/auth/jwt.js'
import {
  CorsOriginError,
  type CouchAdmin,
  couchAdmin,
  installSigningKey,
  KeyInstallationError,
  verifyCorsOrigins,
} from '../../src/auth/keys.js'

function newKey(kid = 'ec-test') {
  const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' })
  return signingKeyFromPem(kid, privateKey.export({ type: 'pkcs8', format: 'pem' }).toString())
}

/** The handler list a correctly configured CouchDB reports. */
const WITH_JWT =
  '{chttpd_auth, jwt_authentication_handler}, {chttpd_auth, default_authentication_handler}'

/** What CouchDB reports when the JWT handler was never added. */
const WITHOUT_JWT = '{chttpd_auth, cookie_authentication_handler}'

interface FakeOptions {
  readonly status?: number
  /**
   * `userCtx.name`. Defaults to echoing the probe token's own subject, which is what a CouchDB
   * that understood the token answers. `null` means "authenticated as nobody" — the case where
   * the token was silently ignored.
   */
  readonly name?: string | null
  readonly authenticated?: string
  /** `[chttpd] authentication_handlers`, or `undefined` when it was never set. */
  readonly handlers?: string | undefined
}

/** A CouchDB that records what it was configured with and answers a scripted session. */
function fakeAdmin(options: FakeOptions = {}) {
  const { status = 200, name, authenticated = 'jwt' } = options
  const handlers = 'handlers' in options ? options.handlers : WITH_JWT
  const config: Array<{ section: string; name: string; value: string }> = []
  const probes: Array<{ token: string; path: string }> = []

  const admin: CouchAdmin = {
    async putConfig(section, key, value) {
      config.push({ section, name: key, value })
    },
    async getConfig(section, key) {
      return section === 'chttpd' && key === 'authentication_handlers' ? handlers : undefined
    },
    async sessionAsBearer(token, path) {
      probes.push({ token, path })
      // Echo the token's own subject unless the test says otherwise: that is what a CouchDB
      // which read and believed the token reports back.
      const claims = JSON.parse(Buffer.from(token.split('.')[1] ?? '', 'base64url').toString()) as {
        sub?: string
      }
      const answered = name === undefined ? claims.sub : (name ?? undefined)
      return {
        status,
        ...(answered === undefined ? {} : { name: answered }),
        ...(answered === undefined ? {} : { authenticated }),
      }
    },
  }
  return { admin, config, probes }
}

describe('installing the signing key', () => {
  it('publishes the public half under an ec-prefixed kid', async () => {
    // `ec:` because CouchDB keys the section by algorithm family. An `rsa:` prefix is a key
    // CouchDB looks for when validating RS256 and never finds when validating ES256.
    const { admin, config } = fakeAdmin()
    await installSigningKey(admin, newKey('ec-2026-08'))

    expect(config).toContainEqual(
      expect.objectContaining({ section: 'jwt_keys', name: 'ec:ec-2026-08' }),
    )
  })

  it('publishes a value CouchDB can parse', async () => {
    // A PEM with its banner lines and newlines intact is accepted into an ini config and then
    // fails to load — so the configuration looks correct while every token is refused.
    const { admin, config } = fakeAdmin()
    await installSigningKey(admin, newKey())

    expect(config[0]?.value).not.toContain('BEGIN')
    expect(config[0]?.value).not.toContain('\n')
  })

  it('never publishes the private half', async () => {
    // The whole reason the public key is pushed at startup: key material stays out of the
    // image, and it has to stay out of the configuration too.
    const key = newKey()
    const { admin, config } = fakeAdmin()
    await installSigningKey(admin, key)

    expect(config[0]?.value).not.toContain('PRIVATE')
    expect(config[0]?.value).not.toBe(
      key.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
    )
  })

  it('proves the key is in effect by minting a token and asking', async () => {
    // Not a fire-and-forget PUT. The write succeeds for a value CouchDB cannot use, so the only
    // honest check is to mint a token and find out whether it is accepted.
    const key = newKey()
    const { admin, probes } = fakeAdmin()
    await installSigningKey(admin, key)

    expect(probes).toHaveLength(1)
    expect(verifyToken(probes[0]?.token ?? '', key.publicKey, 'access').sub).toContain(
      'startup-probe',
    )
  })

  it('refuses to continue when CouchDB rejects that token', async () => {
    // The scenario in the issue: "the API refuses to serve traffic and says why". A service
    // that starts knowing its tokens do not work is one whose users see replication fail with
    // no explanation, intermittently, for as long as it runs.
    const { admin } = fakeAdmin({ status: 401, name: null })

    await expect(installSigningKey(admin, newKey('ec-a'))).rejects.toThrow(KeyInstallationError)
  })

  it('says what to check when it refuses', async () => {
    const { admin } = fakeAdmin({ status: 401, name: null })

    await expect(installSigningKey(admin, newKey('ec-a'))).rejects.toThrow(/PEM banner/)
  })

  it('treats a 403 as success, because that is authentication working', async () => {
    // The probe user has rights to nothing, which is expected. CouchDB still names the subject,
    // so the token was *accepted* and then found insufficient — authorisation, not
    // authentication. Failing on it would mean refusing to start for the very outcome that
    // proves the key works.
    const { admin } = fakeAdmin({ status: 403 })

    await expect(installSigningKey(admin, newKey())).resolves.toBeUndefined()
  })

  it('refuses when CouchDB is not well', async () => {
    const { admin } = fakeAdmin({ status: 503 })

    await expect(installSigningKey(admin, newKey())).rejects.toThrow(/503/)
  })

  it('refuses when CouchDB was never told to read bearer tokens', async () => {
    // The case this whole check exists for. Without the handler CouchDB does not *reject* the
    // token — it ignores it and proceeds as nobody, so every symptom points at the key, which
    // is in fact perfectly good. Left unchecked it presents as a permissions bug that no amount
    // of looking at permissions explains.
    const { admin } = fakeAdmin({ handlers: WITHOUT_JWT, name: null })

    await expect(installSigningKey(admin, newKey())).rejects.toThrow(
      /authentication_handlers .* does not include jwt_authentication_handler/s,
    )
  })

  it('refuses when the handler list was never set at all', async () => {
    // Unset is not "no opinion": CouchDB falls back to a built-in default that has no JWT
    // handler in it, so absent and wrong have the same consequence.
    const { admin } = fakeAdmin({ handlers: undefined, name: null })

    await expect(installSigningKey(admin, newKey())).rejects.toThrow(/is unset/)
  })

  it('says which file to change, because this one cannot be fixed from here', async () => {
    // `[chttpd] authentication_handlers` is read only when CouchDB starts. Telling somebody to
    // restart it, and where to make the change, is the whole value of failing here.
    const { admin } = fakeAdmin({ handlers: WITHOUT_JWT, name: null })

    await expect(installSigningKey(admin, newKey())).rejects.toThrow(/00-base\.ini/)
    await expect(installSigningKey(admin, newKey())).rejects.toThrow(/restart CouchDB/)
  })

  it('checks the handler before writing anything', async () => {
    // Order matters for the diagnosis, not for correctness: a key written into a CouchDB that
    // will never read it is a confusing thing to find later.
    const { admin, config } = fakeAdmin({ handlers: WITHOUT_JWT, name: null })

    await expect(installSigningKey(admin, newKey())).rejects.toThrow(KeyInstallationError)
    expect(config).toHaveLength(0)
  })

  it('refuses when CouchDB answers happily as nobody', async () => {
    // The silent failure a status check cannot see. 200 with no `userCtx.name` means the token
    // was ignored rather than understood, and every token this service mints is about to be
    // ignored the same way.
    const { admin } = fakeAdmin({ status: 200, name: null })

    await expect(installSigningKey(admin, newKey())).rejects.toThrow(
      /identified the caller as nobody/,
    )
  })

  it('refuses when CouchDB names somebody other than the probe', async () => {
    // A token read as a different subject is not this service's token being believed.
    const { admin } = fakeAdmin({ name: 'someone-else' })

    await expect(installSigningKey(admin, newKey())).rejects.toThrow(/"someone-else"/)
  })

  it('requires an expiry claim, so a token without one is not a forever credential', async () => {
    // `[jwt_auth]` is applied live, so it is set here rather than baked into the image — one
    // less setting that can differ between what CouchDB has and what this service assumes.
    const { admin, config } = fakeAdmin()
    await installSigningKey(admin, newKey())

    expect(config).toContainEqual({ section: 'jwt_auth', name: 'required_claims', value: 'exp' })
  })

  it('mints a probe token that expires shortly', async () => {
    // A long-lived token for a user with no rights is still a token, and this one is minted on
    // every startup. A minute is enough to make one request.
    const key = newKey()
    const { admin, probes } = fakeAdmin()
    await installSigningKey(admin, key)

    const claims = verifyToken(probes[0]?.token ?? '', key.publicKey, 'access')
    expect(claims.exp - Math.floor(Date.now() / 1000)).toBeLessThanOrEqual(60)
  })
})

describe('talking to CouchDB’s configuration', () => {
  /** Records requests and answers a scripted status and body. */
  function recordingFetch(status = 200, body = '') {
    const calls: Array<{
      url: string
      method: string
      headers: Record<string, string>
      body: string | undefined
    }> = []
    const impl = (async (url: string | URL, init?: RequestInit) => {
      calls.push({
        url: String(url),
        method: init?.method ?? 'GET',
        headers: (init?.headers ?? {}) as Record<string, string>,
        body: typeof init?.body === 'string' ? init.body : undefined,
      })
      return { ok: status < 400, status, text: async () => body } as unknown as Response
    }) as unknown as typeof fetch
    return { impl, calls }
  }

  it('writes to the node handling the request', async () => {
    // `_local` is CouchDB's alias for whichever node is answering. Using it means this works on
    // a single node without anyone having to configure what that node is called.
    const { impl, calls } = recordingFetch()
    await couchAdmin('http://couch.test:5984', 'admin', 'devonly', impl).putConfig(
      'jwt_keys',
      'ec:a',
      'KEY',
    )

    expect(calls[0]?.url).toBe('http://couch.test:5984/_node/_local/_config/jwt_keys/ec%3Aa')
    expect(calls[0]?.method).toBe('PUT')
  })

  it('sends the value as a JSON string', async () => {
    // A config value is a JSON *string*, quotes and all. Sending it bare is a 400 that reads
    // like a bad key rather than a bad body.
    const { impl, calls } = recordingFetch()
    await couchAdmin('http://couch.test:5984', 'admin', 'devonly', impl).putConfig('s', 'n', 'KEY')

    expect(calls[0]?.body).toBe('"KEY"')
  })

  it('reports a refused write rather than continuing', async () => {
    const { impl } = recordingFetch(403)

    await expect(
      couchAdmin('http://couch.test:5984', 'admin', 'devonly', impl).putConfig('s', 'n', 'v'),
    ).rejects.toThrow(KeyInstallationError)
  })

  it('reads a configured value back as the string it is', async () => {
    // Values come back as JSON strings, the same shape `putConfig` sends. Returning the raw
    // body would compare a quoted value against an unquoted one and never match.
    const { impl } = recordingFetch(200, '"{chttpd_auth, jwt_authentication_handler}"')
    const value = await couchAdmin('http://couch.test:5984', 'admin', 'devonly', impl).getConfig(
      'chttpd',
      'authentication_handlers',
    )

    expect(value).toBe('{chttpd_auth, jwt_authentication_handler}')
  })

  it('reports a setting that was never written as absent, not as an error', async () => {
    // CouchDB answers 404 for a key it does not have, and "never set" is the answer that
    // matters most here — it is the default configuration, which has no JWT handler in it.
    const { impl } = recordingFetch(404)

    await expect(
      couchAdmin('http://couch.test:5984', 'admin', 'devonly', impl).getConfig('chttpd', 'x'),
    ).resolves.toBeUndefined()
  })

  it('reports who CouchDB said was asking', async () => {
    const { impl } = recordingFetch(
      200,
      JSON.stringify({
        ok: true,
        userCtx: { name: 'google|1234' },
        info: { authenticated: 'jwt' },
      }),
    )
    const session = await couchAdmin(
      'http://couch.test:5984',
      'admin',
      'devonly',
      impl,
    ).sessionAsBearer('the.token.here', '/_session')

    expect(session).toEqual({ status: 200, name: 'google|1234', authenticated: 'jwt' })
  })

  it('reads a null name as nobody', async () => {
    // How CouchDB reports an unauthenticated request: the field is present and null, which is
    // not the same as absent and must not survive as the string "null".
    const { impl } = recordingFetch(
      200,
      JSON.stringify({ ok: true, userCtx: { name: null }, info: { authenticated: 'default' } }),
    )
    const session = await couchAdmin(
      'http://couch.test:5984',
      'admin',
      'devonly',
      impl,
    ).sessionAsBearer('t', '/_session')

    expect(session.name).toBeUndefined()
  })

  it('survives a refusal that carries no usable body', async () => {
    // A rejection need not be JSON. Failing to parse it is not itself the failure: an absent
    // name reads as "not authenticated", which is the right conclusion.
    const { impl } = recordingFetch(401, '<html>Unauthorized</html>')
    const session = await couchAdmin(
      'http://couch.test:5984',
      'admin',
      'devonly',
      impl,
    ).sessionAsBearer('t', '/_session')

    expect(session).toEqual({ status: 401 })
  })

  it('probes as a bearer, not as the admin', async () => {
    // The probe has to ask the question a *user's* replication will ask. Asking it with admin
    // credentials would prove only that the admin password is correct.
    const { impl, calls } = recordingFetch()
    await couchAdmin('http://couch.test:5984', 'admin', 'devonly', impl).sessionAsBearer(
      'the.token.here',
      '/_session',
    )

    expect(calls[0]?.headers.authorization).toBe('Bearer the.token.here')
    expect(calls[0]?.headers.authorization).not.toContain('Basic')
  })
})

describe('checking CouchDB will serve our browsers', () => {
  /** A CouchDB whose [cors] origins is whatever the test says. */
  function withOrigins(origins: string | undefined): CouchAdmin {
    return {
      async putConfig() {},
      async getConfig(section, name) {
        return section === 'cors' && name === 'origins' ? origins : undefined
      },
      async sessionAsBearer() {
        return { status: 200 }
      },
    }
  }

  it('accepts a list that names every origin the application is served from', async () => {
    const admin = withOrigins('http://localhost:5173, http://localhost:4173')

    await expect(
      verifyCorsOrigins(admin, ['http://localhost:5173', 'http://localhost:4173']),
    ).resolves.toBeUndefined()
  })

  it('ignores whitespace, because the ini format is written by hand', async () => {
    const admin = withOrigins('  https://matter.example ,   https://other.example  ')

    await expect(verifyCorsOrigins(admin, ['https://matter.example'])).resolves.toBeUndefined()
  })

  it('refuses a placeholder that was never replaced at deploy time', async () => {
    // The failure the production overlay warns about in a comment and nothing enforced.
    // Replication fails from the real origin with an opaque browser CORS error that reads as a
    // network fault, so it is invisible until a user tries to sync.
    const admin = withOrigins('https://matter-manager.example')

    await expect(verifyCorsOrigins(admin, ['https://matter.example'])).rejects.toThrow(
      CorsOriginError,
    )
  })

  it('names the origins CouchDB would turn away', async () => {
    const admin = withOrigins('https://matter-manager.example')

    await expect(verifyCorsOrigins(admin, ['https://matter.example'])).rejects.toThrow(
      /https:\/\/matter\.example/,
    )
  })

  it('refuses when the list was never set', async () => {
    const admin = withOrigins(undefined)

    await expect(verifyCorsOrigins(admin, ['https://matter.example'])).rejects.toThrow(/unset/)
  })

  it('says which file to set it in', async () => {
    const admin = withOrigins(undefined)

    await expect(verifyCorsOrigins(admin, ['https://matter.example'])).rejects.toThrow(
      /10-production\.ini/,
    )
  })

  it('checks nothing when the deployment names no origin', async () => {
    // Consistent with the rest of composition: a deployment that has not been told where its
    // application lives is part-way through being set up, not misconfigured.
    const admin = withOrigins(undefined)

    await expect(verifyCorsOrigins(admin, [])).resolves.toBeUndefined()
  })
})
