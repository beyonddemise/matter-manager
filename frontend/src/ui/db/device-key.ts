/**
 * The per-browser device key (#300): one non-extractable RSA-OAEP-3072/SHA-256 pair, held in a
 * small raw-IndexedDB database of its own.
 *
 * Raw IndexedDB rather than PouchDB because PouchDB cannot hold a `CryptoKey` — it JSON-encodes
 * documents, and the whole point of a non-extractable key is that no byte representation exists
 * to encode. IndexedDB's structured clone stores the key object itself, usable but never
 * readable.
 *
 * Its own database, `mm-keys`, rather than a store inside `mm-local`, because the two have
 * opposite lifetimes: `mm-local` is account state and is destroyed on sign-out, while this key
 * is a property of the **browser profile** — it survives sign-out on purpose (losing it is
 * always recoverable via escrow, but keeping it spares an escrow round trip and a fresh
 * registration on every sign-in). `removeLocalDatabases` keeps not touching it, and
 * `device-key.browser.test.ts` pins that.
 *
 * @module
 */

import { deriveKid } from '../../domain/crypto/kid.js'

/** The raw-IndexedDB database holding the device key. Exported so tests can name what they pin. */
export const DEVICE_KEY_DATABASE_NAME = 'mm-keys'

/** The one object store, and the one record in it. */
const STORE_NAME = 'keys'
const RECORD_ID = 'device'

/** This browser's key pair, as everything above this module consumes it. */
export type DeviceKey = {
  /** SHA-256 of the SPKI, 64 lowercase hex chars — the name the server files wraps under. */
  kid: string
  /** The SubjectPublicKeyInfo DER, standard base64, ready for `PUT /profile/devicekeys`. */
  publicKeySpki: string
  /** Non-extractable. Decrypts `key:<kid>` wrap documents; it never leaves this browser. */
  privateKey: CryptoKey
}

/** What actually sits in the store: the key plus the record id IndexedDB files it under. */
interface StoredDeviceKey extends DeviceKey {
  id: typeof RECORD_ID
}

/** An IDBRequest, awaited. For reads only — a write settled this way is not yet durable. */
function settled<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error ?? new Error('The key store request failed.'))
  })
}

/**
 * A write transaction, awaited to its **commit**.
 *
 * A request's success event fires before the transaction commits, and the commit can still
 * abort afterwards (quota, most plausibly). A write awaited on the request would therefore
 * answer a key that was never persisted — the next launch would mint a different pair, and any
 * registration made under the first kid would be orphaned on the server. So the settlement here
 * is the transaction's: `complete` means durable, `abort`/`error` mean the write did not happen.
 * A failed request (the `add` losing the race below) surfaces as the abort's `error`, so the
 * caller still sees the `ConstraintError` it arbitrates on.
 */
function committed(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve()
    transaction.onabort = () =>
      reject(transaction.error ?? new Error('The key store transaction was aborted.'))
    transaction.onerror = () =>
      reject(transaction.error ?? new Error('The key store transaction failed.'))
  })
}

/** Opens `mm-keys`, creating the `keys` store on first use. */
function openKeyDatabase(): Promise<IDBDatabase> {
  const request = indexedDB.open(DEVICE_KEY_DATABASE_NAME, 1)
  request.onupgradeneeded = () => {
    request.result.createObjectStore(STORE_NAME, { keyPath: 'id' })
  }
  return settled(request)
}

/** The stored record, or `undefined` on a browser that has never had a key. */
async function readStored(database: IDBDatabase): Promise<StoredDeviceKey | undefined> {
  const store = database.transaction(STORE_NAME, 'readonly').objectStore(STORE_NAME)
  return (await settled(store.get(RECORD_ID))) as StoredDeviceKey | undefined
}

/** Bytes → standard base64, for the SPKI the API carries. */
function toBase64(buffer: ArrayBuffer): string {
  let binary = ''
  for (const byte of new Uint8Array(buffer)) binary += String.fromCharCode(byte)
  return btoa(binary)
}

/**
 * Mints a fresh pair and derives its identity.
 *
 * `extractable: false` applies to the private key (a public key is extractable by nature), and
 * is the property the design leans on: a compromised page can use the key while it is open, but
 * cannot exfiltrate it for later. The usages cover both ways F2's envelope may consume it —
 * `unwrapKey` directly, or `decrypt` + import.
 */
async function generateDeviceKey(): Promise<StoredDeviceKey> {
  const pair = await crypto.subtle.generateKey(
    {
      name: 'RSA-OAEP',
      modulusLength: 3072,
      publicExponent: new Uint8Array([0x01, 0x00, 0x01]),
      hash: 'SHA-256',
    },
    false,
    ['encrypt', 'decrypt', 'wrapKey', 'unwrapKey'],
  )
  const publicKeySpki = toBase64(await crypto.subtle.exportKey('spki', pair.publicKey))
  return {
    id: RECORD_ID,
    kid: await deriveKid(publicKeySpki),
    publicKeySpki,
    privateKey: pair.privateKey,
  }
}

/** The record without its storage-only id, which callers have no business seeing. */
function asDeviceKey({ kid, publicKeySpki, privateKey }: StoredDeviceKey): DeviceKey {
  return { kid, publicKeySpki, privateKey }
}

/**
 * This browser's device key, minting it on the first call and answering with the same identity
 * on every later one.
 *
 * Idempotence lives in the storage, not in a module-level memo: generation awaits between the
 * read and the write, so two concurrent callers can both find the store empty and both mint.
 * `add` (never `put`) makes the store the arbiter — the second write fails on the key constraint
 * instead of replacing a pair the first caller may already have registered with the server, and
 * the loser re-reads and answers with the winner's key.
 */
export async function ensureDeviceKey(): Promise<DeviceKey> {
  const database = await openKeyDatabase()
  try {
    const existing = await readStored(database)
    if (existing !== undefined) return asDeviceKey(existing)

    const fresh = await generateDeviceKey()
    try {
      const transaction = database.transaction(STORE_NAME, 'readwrite')
      const durable = committed(transaction)
      transaction.objectStore(STORE_NAME).add(fresh)
      await durable
    } catch (error) {
      // Two ways here, told apart by what the re-read finds. Lost the race above: somebody
      // else's pair is in the store, and *that* is the device key now — this one is discarded
      // unused, which is why losing is harmless. Or the commit aborted (quota): the store is
      // still empty, and the honest answer is the failure — a key handed out unpersisted would
      // be a different kid on the next launch, orphaning whatever registered the first one.
      const winner = await readStored(database)
      if (winner !== undefined) return asDeviceKey(winner)
      throw error
    }
    return asDeviceKey(fresh)
  } finally {
    // Held handles block `deleteDatabase` (and the tests that use it) indefinitely; this is
    // called a handful of times per session, so reopening is cheaper than a lifetime handle.
    database.close()
  }
}
