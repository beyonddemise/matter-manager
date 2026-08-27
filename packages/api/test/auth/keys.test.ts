import { generateKeyPairSync } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { signingKeyFromPem, verifyToken } from '../../src/auth/jwt.js'
import {
  type CouchAdmin,
  couchAdmin,
  installSigningKey,
  KeyInstallationError,
} from '../../src/auth/keys.js'

function newKey(kid = 'ec-test') {
  const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' })
  return signingKeyFromPem(kid, privateKey.export({ type: 'pkcs8', format: 'pem' }).toString())
}

/** A CouchDB that records what it was configured with and answers a scripted status. */
function fakeAdmin(status = 200) {
  const config: Array<{ section: string; name: string; value: string }> = []
  const probes: Array<{ token: string; path: string }> = []

  const admin: CouchAdmin = {
    async putConfig(section, name, value) {
      config.push({ section, name, value })
    },
    async statusAsBearer(token, path) {
      probes.push({ token, path })
      return status
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

    expect(config).toHaveLength(1)
    expect(config[0]?.section).toBe('jwt_keys')
    expect(config[0]?.name).toBe('ec:ec-2026-08')
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
    const { admin } = fakeAdmin(401)

    await expect(installSigningKey(admin, newKey('ec-a'))).rejects.toThrow(KeyInstallationError)
  })

  it('says what to check when it refuses', async () => {
    const { admin } = fakeAdmin(401)

    await expect(installSigningKey(admin, newKey('ec-a'))).rejects.toThrow(/PEM banner/)
  })

  it('treats a 403 as success, because that is authentication working', async () => {
    // The probe user has rights to nothing, which is expected. 403 means the token was
    // *accepted* and then found insufficient — authorisation, not authentication. Failing on it
    // would mean refusing to start for the very outcome that proves the key works.
    const { admin } = fakeAdmin(403)

    await expect(installSigningKey(admin, newKey())).resolves.toBeUndefined()
  })

  it('refuses when CouchDB is not well', async () => {
    const { admin } = fakeAdmin(503)

    await expect(installSigningKey(admin, newKey())).rejects.toThrow(/503/)
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
  /** Records requests and answers a scripted status. */
  function recordingFetch(status = 200) {
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
      return { ok: status < 400, status } as Response
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

  it('probes as a bearer, not as the admin', async () => {
    // The probe has to ask the question a *user's* replication will ask. Asking it with admin
    // credentials would prove only that the admin password is correct.
    const { impl, calls } = recordingFetch()
    await couchAdmin('http://couch.test:5984', 'admin', 'devonly', impl).statusAsBearer(
      'the.token.here',
      '/_session',
    )

    expect(calls[0]?.headers.authorization).toBe('Bearer the.token.here')
    expect(calls[0]?.headers.authorization).not.toContain('Basic')
  })
})
