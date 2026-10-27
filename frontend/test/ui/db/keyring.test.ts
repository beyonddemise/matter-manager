import { afterEach, beforeAll, describe, expect, it } from 'vitest'
import { type KeyState, projectRepositories } from '../../../src/data/index.js'
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
  ensureProjectKeys,
  fieldCipher,
  memoiseKeyState,
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

describe('memoiseKeyState', () => {
  it('memoises a successful resolution for the handle lifetime', async () => {
    let resolved = 0
    const memo = memoiseKeyState(async () => {
      resolved += 1
      return { kind: 'locked' }
    })

    expect(await memo.provider()).toEqual({ kind: 'locked' })
    expect(await memo.provider()).toEqual({ kind: 'locked' })
    expect(resolved).toBe(1)
  })

  it('does not memoise a rejection: the failing operation throws, the next one retries', async () => {
    // The browser-crashing version of this: `ensureDeviceKey` hiccups once (IndexedDB is
    // allowed to), the rejected promise is memoised, and every read and write on the handle
    // fails for the lifetime of the page. The error must surface once and then be forgotten.
    let calls = 0
    const memo = memoiseKeyState(async () => {
      calls += 1
      if (calls === 1) throw new Error('mm-keys was briefly unavailable')
      return undefined
    })

    await expect(memo.provider()).rejects.toThrow(/unavailable/)
    expect(await memo.provider()).toBeUndefined()
    expect(calls).toBe(2)
  })

  it('refresh() drops the memo so the next consultation re-resolves', async () => {
    const answers: (KeyState | undefined)[] = [undefined, { kind: 'locked' }]
    const memo = memoiseKeyState(async () => answers.shift())

    expect(await memo.provider()).toBeUndefined()
    memo.refresh()
    expect(await memo.provider()).toEqual({ kind: 'locked' })
  })

  it('a repository over a provider that failed once works on the next operation', async () => {
    // The coordinator's framing of the bug, end to end at the seam: the first operation on the
    // handle surfaces the resolution failure honestly, the second one succeeds.
    const database = freshDatabase()
    let calls = 0
    const memo = memoiseKeyState(async () => {
      calls += 1
      if (calls === 1) throw new Error('key state could not be resolved')
      return undefined
    })
    const { devices } = projectRepositories(database, undefined, memo.provider)

    await expect(devices.list()).rejects.toThrow(/could not be resolved/)
    expect(await devices.list()).toEqual([])
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

describe('ensureProjectKeys', () => {
  /** The real mint, counted: what the catalogue's provider and adoption both hand in. */
  function countedMint() {
    let calls = 0
    const mint = async (database: PouchDB.Database): Promise<KeyState> => {
      calls += 1
      return {
        kind: 'unlocked',
        cipher: fieldCipher(await createProjectKeys(database, null, deps)),
      }
    }
    return { mint, calls: () => calls }
  }

  it('mints a keyless database, then reuses its own wrap rather than minting again', async () => {
    const database = freshDatabase()
    const { mint, calls } = countedMint()

    const first = await ensureProjectKeys(database, mint, deps)
    const second = await ensureProjectKeys(database, mint, deps)

    expect(calls()).toBe(1)
    if (first?.kind !== 'unlocked' || second?.kind !== 'unlocked') throw new Error('not unlocked')
    const sealed = await first.cipher.encrypt('device:a', 'manualCode', '34970112332')
    expect(await second.cipher.decrypt('device:a', 'manualCode', sealed)).toBe('34970112332')
  })

  it('ends two concurrent callers on the winner’s DEK: the loser’s 409 re-reads it', async () => {
    // Two tabs keying one catalogue at once: both resolve keyless, both mint, and the second
    // `key:<own kid>` write conflicts. The loser must answer the winner's DEK — a DEK of its own
    // would encrypt devices nobody can open after this page.
    const database = freshDatabase()
    const { mint } = countedMint()

    const [a, b] = await Promise.all([
      ensureProjectKeys(database, mint, deps),
      ensureProjectKeys(database, mint, deps),
    ])

    const { rows } = await database.allDocs({ startkey: 'key:', endkey: 'key:￿' })
    expect(rows).toHaveLength(1)
    if (a?.kind !== 'unlocked' || b?.kind !== 'unlocked') throw new Error('not unlocked')
    const sealed = await a.cipher.encrypt('device:a', 'payload', 'MT:Y.K9042C00KA0648G00')
    expect(await b.cipher.decrypt('device:a', 'payload', sealed)).toBe('MT:Y.K9042C00KA0648G00')
  })

  it('raises a failed mint as itself, never as a lock', async () => {
    const database = freshDatabase()
    const quota = new Error('QuotaExceededError')

    await expect(ensureProjectKeys(database, async () => Promise.reject(quota), deps)).rejects.toBe(
      quota,
    )
  })

  it('leaves a database holding only other devices’ wraps locked, minting nothing', async () => {
    const database = freshDatabase()
    await database.put(foreignWrap())
    const { mint, calls } = countedMint()

    expect(await ensureProjectKeys(database, mint, deps)).toEqual({ kind: 'locked' })
    expect(calls()).toBe(0)
  })
})
