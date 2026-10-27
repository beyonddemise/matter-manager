import { beforeEach, describe, expect, it } from 'vitest'
import { deriveKid } from '../../../src/domain/crypto/kid.js'
import { DEVICE_KEY_DATABASE_NAME, ensureDeviceKey } from '../../../src/ui/db/device-key.js'
import { removeLocalDatabases } from '../../../src/ui/db/project-database.js'

/** Deletes `mm-keys` outright, so each test starts from a browser that has never had a key. */
function deleteKeyDatabase(): Promise<void> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.deleteDatabase(DEVICE_KEY_DATABASE_NAME)
    request.onsuccess = () => resolve()
    request.onerror = () => reject(request.error ?? new Error('deleteDatabase failed'))
  })
}

beforeEach(async () => {
  await deleteKeyDatabase()
})

describe('ensureDeviceKey', () => {
  it('creates once, then stays stable', async () => {
    // The whole contract in one scenario: the first call mints the pair, every later call
    // answers with the same identity. A kid that drifted between calls would re-register the
    // browser on every startup and orphan every `key:<kid>` wrap doc already written for it.
    const first = await ensureDeviceKey()
    const second = await ensureDeviceKey()

    expect(second.kid).toBe(first.kid)
    expect(second.publicKeySpki).toBe(first.publicKeySpki)
  })

  it('answers one identity to concurrent first calls', async () => {
    // Generation awaits between the read and the write, so two racing callers can both find
    // the store empty and both mint. The store arbitrates (`add`, never `put`): whoever loses
    // must answer with the winner's key, or the two halves of the application would hold
    // different identities for the same browser.
    const [first, second] = await Promise.all([ensureDeviceKey(), ensureDeviceKey()])

    expect(second.kid).toBe(first.kid)
    expect(second.publicKeySpki).toBe(first.publicKeySpki)
  })

  it('derives the kid as SHA-256 of the SPKI, full 64 lowercase hex', async () => {
    const key = await ensureDeviceKey()

    expect(key.kid).toMatch(/^[0-9a-f]{64}$/)
    // The stored kid and the derivation must be the same fact, or the server (which derives
    // the kid itself from the registered public key) would file wraps under a different name.
    expect(key.kid).toBe(await deriveKid(key.publicKeySpki))
  })

  it('holds a non-extractable RSA-OAEP-3072/SHA-256 private key', async () => {
    const { privateKey } = await ensureDeviceKey()

    // Non-extractable is the security property the design leans on: a compromised page can
    // use the key while open, but cannot exfiltrate it for later.
    expect(privateKey.extractable).toBe(false)
    expect(privateKey.type).toBe('private')

    const algorithm = privateKey.algorithm as RsaHashedKeyAlgorithm
    expect(algorithm.name).toBe('RSA-OAEP')
    expect(algorithm.modulusLength).toBe(3072)
    expect(algorithm.hash.name).toBe('SHA-256')
  })

  it('survives sign-out', async () => {
    // The key is a property of the browser profile, not the account: losing it on sign-out
    // would force an escrow round trip and a fresh registration on every sign-in.
    const before = await ensureDeviceKey()

    await removeLocalDatabases({ includeLocalCatalogue: true })

    const after = await ensureDeviceKey()
    expect(after.kid).toBe(before.kid)
  })

  it('is never on the sign-out destroy list', async () => {
    // The behavioural test above proves today's destroy leaves the key standing; this one
    // pins the reason — `removeLocalDatabases` never even names `mm-keys` — so a future
    // database that *is* named cannot drift onto the list without a test saying so.
    await ensureDeviceKey()

    const destroyed: string[] = []
    await removeLocalDatabases({ includeLocalCatalogue: true }, async (name) => {
      destroyed.push(name)
    })

    expect(destroyed.length).toBeGreaterThan(0)
    expect(destroyed).not.toContain(DEVICE_KEY_DATABASE_NAME)
  })
})
