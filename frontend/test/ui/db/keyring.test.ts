import { afterEach, beforeAll, describe, expect, it } from 'vitest'
import { encodeBase64 } from '../../../src/domain/crypto/base64.js'
import {
  decryptField,
  deriveKid,
  encryptField,
  unwrapDek,
} from '../../../src/domain/crypto/envelope.js'
import { ESCROW_KEY_DOCUMENT_ID, projectKeyDocumentId } from '../../../src/domain/documents/keys.js'
import type { KeyringDependencies } from '../../../src/ui/db/keyring.js'
import {
  createProjectKeys,
  ensureEscrowWrap,
  resolveKeyState,
  unlockProject,
} from '../../../src/ui/db/keyring.js'
import type { EscrowKeyInfo } from '../../../src/ui/escrow-client.js'
import { memoryDatabase } from '../../data/support/memory-database.js'

/**
 * The keyring over an in-memory PouchDB, with a real WebCrypto key pair standing in for the
 * device key: `mm-keys` is raw IndexedDB and has its own browser test, while everything the
 * keyring itself does — generate, wrap, write, read, unwrap — is runtime-independent.
 */

/** A real RSA-OAEP-3072 pair in the device key's shape, minted once for the whole file. */
async function rsaRecipient(): Promise<{ kid: string; spki: string; privateKey: CryptoKey }> {
  const pair = await crypto.subtle.generateKey(
    {
      name: 'RSA-OAEP',
      modulusLength: 3072,
      publicExponent: new Uint8Array([0x01, 0x00, 0x01]),
      hash: 'SHA-256',
    },
    false,
    ['wrapKey', 'unwrapKey'],
  )
  const spki = encodeBase64(new Uint8Array(await crypto.subtle.exportKey('spki', pair.publicKey)))
  return { kid: await deriveKid(spki), spki, privateKey: pair.privateKey }
}

const NOW = '2026-10-27T09:00:00.000Z'
/** A kid that is valid in shape but belongs to nobody in this test. */
const FOREIGN_KID = '0'.repeat(64)

let device: Awaited<ReturnType<typeof rsaRecipient>>
let escrowPair: Awaited<ReturnType<typeof rsaRecipient>>
let escrow: EscrowKeyInfo
let deps: KeyringDependencies

const databases: PouchDB.Database[] = []
function freshDatabase(): PouchDB.Database {
  const database = memoryDatabase()
  databases.push(database)
  return database
}

/** A wrap document for somebody else's device, so "keys exist, none for me" is expressible. */
const foreignWrap = () => ({
  _id: projectKeyDocumentId(FOREIGN_KID),
  type: 'projectKey',
  kid: FOREIGN_KID,
  alg: 'RSA-OAEP-256',
  wrapped: 'AAAA',
  createdAt: NOW,
})

beforeAll(async () => {
  ;[device, escrowPair] = await Promise.all([rsaRecipient(), rsaRecipient()])
  escrow = { kid: escrowPair.kid, alg: 'RSA-OAEP-256', publicKey: escrowPair.spki }
  deps = {
    deviceKey: async () => ({
      kid: device.kid,
      publicKeySpki: device.spki,
      privateKey: device.privateKey,
    }),
    now: () => NOW,
  }
})

afterEach(async () => {
  await Promise.all(databases.splice(0).map((database) => database.destroy()))
})

describe('createProjectKeys and unlockProject', () => {
  it('createThenUnlockRoundTrips', async () => {
    const database = freshDatabase()

    const dek = await createProjectKeys(database, null, deps)

    const stored = await database.get(projectKeyDocumentId(device.kid))
    expect(stored).toMatchObject({
      type: 'projectKey',
      kid: device.kid,
      alg: 'RSA-OAEP-256',
      createdAt: NOW,
    })
    expect(typeof (stored as unknown as { wrapped: unknown }).wrapped).toBe('string')
    // Born offline with no escrow key cached: no `key:escrow` is written (decision 1).
    await expect(database.get(ESCROW_KEY_DOCUMENT_ID)).rejects.toMatchObject({ status: 404 })

    const unlocked = await unlockProject(database, deps)
    expect(unlocked).not.toBeNull()
    if (unlocked === null) throw new Error('unreachable')
    // The unwrapped key is the generated one: what either encrypts, the other decrypts.
    const sealed = await encryptField(dek, 'device:x', 'payload', 'MT:TEST')
    expect(await decryptField(unlocked, 'device:x', 'payload', sealed)).toBe('MT:TEST')
  })

  it('unlockWithoutWrapIsNull', async () => {
    // A database with no key documents at all.
    expect(await unlockProject(freshDatabase(), deps)).toBeNull()

    // The real locked state: keys exist, but none is wrapped for this device.
    const database = freshDatabase()
    await database.put(foreignWrap())
    expect(await unlockProject(database, deps)).toBeNull()
  })

  it('escrowWrapWrittenWhenAvailable', async () => {
    const database = freshDatabase()

    const dek = await createProjectKeys(database, escrow, deps)

    const stored = (await database.get(ESCROW_KEY_DOCUMENT_ID)) as unknown as {
      kid: string
      alg: string
      type: string
      wrapped: string
    }
    expect(stored).toMatchObject({ type: 'projectKey', kid: escrowPair.kid, alg: 'RSA-OAEP-256' })
    // The wrap is real: the escrow private key opens it to the same DEK the project got.
    const recovered = await unwrapDek(stored.wrapped, escrowPair.privateKey)
    const sealed = await encryptField(dek, 'device:x', 'manualCode', '34970112332')
    expect(await decryptField(recovered, 'device:x', 'manualCode', sealed)).toBe('34970112332')
  })
})

describe('ensureEscrowWrap', () => {
  it('creates the wrap for a project born without one', async () => {
    const database = freshDatabase()
    const dek = await createProjectKeys(database, null, deps)

    const wrap = await ensureEscrowWrap(database, escrow, deps)

    expect(wrap.kid).toBe(escrowPair.kid)
    const recovered = await unwrapDek(wrap.wrapped, escrowPair.privateKey)
    const sealed = await encryptField(dek, 'device:x', 'payload', 'MT:TEST')
    expect(await decryptField(recovered, 'device:x', 'payload', sealed)).toBe('MT:TEST')
  })

  it('ensureEscrowWrapIdempotent', async () => {
    const database = freshDatabase()
    await createProjectKeys(database, null, deps)

    const first = await ensureEscrowWrap(database, escrow, deps)
    const second = await ensureEscrowWrap(database, escrow, deps)

    expect(second).toEqual(first)
    // Returned from the stored document, not re-wrapped: the revision never moved.
    const stored = await database.get(ESCROW_KEY_DOCUMENT_ID)
    expect(stored._rev).toMatch(/^1-/)
    expect((stored as unknown as { wrapped: string }).wrapped).toBe(first.wrapped)
  })

  it('refuses on a locked project, where there is no DEK to wrap', async () => {
    const database = freshDatabase()
    await database.put(foreignWrap())

    await expect(ensureEscrowWrap(database, escrow, deps)).rejects.toThrow(/locked/i)
  })
})

describe('resolveKeyState', () => {
  it('answers plaintext for a database from before encryption', async () => {
    // No key documents at all: a pre-encryption database (decision 2 migrates nothing). The
    // repositories over it keep reading and writing plaintext, exactly as before the feature.
    expect(await resolveKeyState(freshDatabase(), deps)).toBeUndefined()
  })

  it('answers an unlocked cipher when the own wrap opens', async () => {
    const database = freshDatabase()
    await createProjectKeys(database, null, deps)

    const state = await resolveKeyState(database, deps)

    expect(state?.kind).toBe('unlocked')
    if (state?.kind !== 'unlocked') throw new Error('unreachable')
    const sealed = await state.cipher.encrypt('device:x', 'payload', 'MT:TEST')
    expect(sealed).toMatch(/^enc:v1:/)
    expect(await state.cipher.decrypt('device:x', 'payload', sealed)).toBe('MT:TEST')
    // Format-versioning headroom: a value without the prefix passes through untouched.
    expect(await state.cipher.decrypt('device:x', 'payload', 'MT:PLAIN')).toBe('MT:PLAIN')
  })

  it('answers locked when keys exist but none is for this device', async () => {
    const database = freshDatabase()
    await database.put(foreignWrap())

    expect(await resolveKeyState(database, deps)).toEqual({ kind: 'locked' })
  })
})
