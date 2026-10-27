/**
 * The project keyring (#302): minting, wrapping, unwrapping and finding the per-project DEK.
 *
 * This is where the `FieldCipher` that `data/repository.ts` takes is actually built — `data/`
 * imports neither WebCrypto nor PouchDB, `domain/crypto` does the cryptography and knows no
 * database, and this module joins the two: it reads and writes the `key:*` wrap documents
 * (`domain/documents/keys.ts`) in a project database and turns an unwrapped DEK into the cipher
 * the repositories encrypt and decrypt with.
 *
 * Every function takes the open database rather than opening one, like the rest of the data
 * path, so the tests run over an in-memory PouchDB in Node. The one browser-only dependency,
 * the device key in `mm-keys`, is injected with `ensureDeviceKey` as its default.
 *
 * @module
 */

import {
  type FieldCipher,
  isConflict,
  type KeyState,
  projectRepositories,
} from '../../data/index.js'
// `domain/crypto` types keys structurally (its tsconfig has no DOM lib); the DOM's `CryptoKey`
// and that shape are mutually assignable, which the signatures below rely on in both
// directions — a DEK unwrapped there is answered here as a DOM `CryptoKey`, and a DOM key
// handed to `fieldCipher` flows back in.
import {
  decryptField,
  encryptField,
  generateDek,
  isEncryptedField,
  unwrapDek,
  wrapDek,
} from '../../domain/crypto/envelope.js'
import {
  ESCROW_KEY_DOCUMENT_ID,
  isProjectKeyDocument,
  type ProjectKeyDocument,
  projectKeyDocumentId,
  projectKeyRange,
} from '../../domain/documents/keys.js'
import { idRange } from '../../domain/index.js'
import type { EscrowKeyInfo } from '../escrow-client.js'
import { type DeviceKey, ensureDeviceKey } from './device-key.js'

/** What the keyring reaches outside the database it is handed. Injected, so tests own it. */
export interface KeyringDependencies {
  /** This browser's device key — `ensureDeviceKey` in the application, a made pair in tests. */
  readonly deviceKey: () => Promise<DeviceKey>
  /** Stamps `createdAt` on the wrap documents; this module holds no clock. */
  readonly now: () => string
}

const defaults: KeyringDependencies = {
  deviceKey: ensureDeviceKey,
  now: () => new Date().toISOString(),
}

/** The wrap document under an id, or `undefined` when it is missing *or not one*: a document
 * in a replicated database is whatever some client wrote, and a malformed wrap must read as "no
 * usable wrap" — the locked state, which escrow recovery can repair — not as a crash. */
async function readWrap(
  database: PouchDB.Database,
  id: string,
): Promise<ProjectKeyDocument | undefined> {
  let stored: unknown
  try {
    stored = await database.get(id)
  } catch (error) {
    if ((error as { status?: unknown }).status === 404) return undefined
    throw error
  }
  return isProjectKeyDocument(stored) ? stored : undefined
}

/** Writes one wrap document, in exactly the spec's shape. */
async function writeWrap(
  database: PouchDB.Database,
  id: string,
  kid: string,
  wrapped: string,
  createdAt: string,
): Promise<void> {
  const document: ProjectKeyDocument = {
    _id: id,
    type: 'projectKey',
    kid,
    alg: 'RSA-OAEP-256',
    wrapped,
    createdAt,
  }
  await database.put(document as unknown as PouchDB.Core.PutDocument<object>)
}

/**
 * The repositories' cipher over one unlocked DEK: `domain/crypto`'s field envelope, with the
 * key bound in. This is the only constructor of the `FieldCipher` the seam takes.
 */
export function fieldCipher(dek: CryptoKey): FieldCipher {
  return {
    encrypt: (docId, field, value) => encryptField(dek, docId, field, value),
    decrypt: (docId, field, value) => decryptField(dek, docId, field, value),
  }
}

/**
 * Opens a project's DEK with this device's key: reads `key:<own kid>` and unwraps it.
 *
 * `null` is the locked state — no wrap for this device (yet), including a wrap so malformed it
 * cannot be one. Both resolve the same way: escrow re-wraps (F7). A well-formed wrap that fails
 * to unwrap still **throws**, because that is not a missing key but a broken one, and reporting
 * it as "locked" would send recovery chasing a wrap that already exists.
 */
export async function unlockProject(
  database: PouchDB.Database,
  deps: KeyringDependencies = defaults,
): Promise<CryptoKey | null> {
  const device = await deps.deviceKey()
  const wrap = await readWrap(database, projectKeyDocumentId(device.kid))
  if (wrap === undefined) return null
  return unwrapDek(wrap.wrapped, device.privateKey)
}

/**
 * Mints a project's keys at creation (spec decision 4: DEKs are generated on the device, never
 * on the server): a fresh DEK, wrapped for this device, and for escrow when the escrow public
 * key is known. Called by `local-projects.ts` **before the first device write**, so no document
 * can be stored under a key that does not exist yet.
 *
 * @param escrow the cached escrow key, or `null` when none has been heard — a project born
 *   offline carries no escrow wrap until promote (`ensureEscrowWrap`) adds one
 * @returns the unlocked DEK, so creation can hand the repositories their cipher without a
 *   read-back and unwrap of what was just written
 */
export async function createProjectKeys(
  database: PouchDB.Database,
  escrow: EscrowKeyInfo | null,
  deps: KeyringDependencies = defaults,
): Promise<CryptoKey> {
  const device = await deps.deviceKey()
  const dek = await generateDek()
  await writeWrap(
    database,
    projectKeyDocumentId(device.kid),
    device.kid,
    await wrapDek(dek, device.publicKeySpki),
    deps.now(),
  )
  if (escrow !== null) {
    await writeWrap(
      database,
      ESCROW_KEY_DOCUMENT_ID,
      escrow.kid,
      await wrapDek(dek, escrow.publicKey),
      deps.now(),
    )
  }
  return dek
}

/**
 * The escrow wrap, creating it when the project was born offline without one.
 *
 * Going to the server is where the wrap becomes a hard requirement (spec, "Project keys"):
 * provisioning (F8) sends it for validation, so this answers the stored wrap when there is one
 * and otherwise unwraps the project's DEK — which requires the project to be unlocked on this
 * device — wraps it for escrow, and stores the document before answering it.
 *
 * @throws {Error} when the project is locked on this device: there is no DEK to wrap, and only
 *   escrow recovery (F7) can change that
 */
export async function ensureEscrowWrap(
  database: PouchDB.Database,
  escrow: EscrowKeyInfo,
  deps: KeyringDependencies = defaults,
): Promise<{ kid: string; wrapped: string }> {
  const existing = await readWrap(database, ESCROW_KEY_DOCUMENT_ID)
  if (existing !== undefined) return { kid: existing.kid, wrapped: existing.wrapped }

  const dek = await unlockProject(database, deps)
  if (dek === null) {
    throw new Error(
      'This project is locked on this device, so no escrow wrap can be created from it.',
    )
  }
  const wrapped = await wrapDek(dek, escrow.publicKey)
  await writeWrap(database, ESCROW_KEY_DOCUMENT_ID, escrow.kid, wrapped, deps.now())
  return { kid: escrow.kid, wrapped }
}

/** A memoised key state: the provider the repositories consult, and the way to drop the memo. */
export interface MemoisedKeyState {
  /** Resolves the key state, once, and answers the same promise until {@link refresh}. */
  readonly provider: () => Promise<KeyState | undefined>
  /** Drops the memo, so the next consultation resolves afresh (the F7 recovery seam). */
  readonly refresh: () => void
}

/**
 * Memoises one database's key-state resolution for the lifetime of its handle.
 *
 * Success is remembered; **a rejection is not**. Resolution touches IndexedDB twice (`mm-keys`
 * and the database itself), either of which is allowed a transient failure — and a memoised
 * rejection would fail every later read and write on the handle for the lifetime of the page.
 * So the operation that triggered the failed resolution still sees the error, honestly, and the
 * next one resolves again.
 */
export function memoiseKeyState(resolve: () => Promise<KeyState | undefined>): MemoisedKeyState {
  let memo: Promise<KeyState | undefined> | undefined
  return {
    provider: () => {
      memo ??= resolve().catch((error: unknown) => {
        memo = undefined
        throw error
      })
      return memo
    },
    refresh: () => {
      memo = undefined
    },
  }
}

/**
 * The key state a project database's repositories run under (`data/repository.ts`).
 *
 * Three answers, decided by the `key:*` documents alone:
 *
 * - **No key documents at all** → `undefined`, the plaintext state. That is a database from
 *   before encryption existed — decision 2 migrates nothing — or one whose key documents have
 *   not replicated in yet, and in either case there is no DEK anywhere that could ever open it,
 *   so "locked" would be a promise no recovery can keep. Re-resolution (the provider seam in
 *   `ui/db/project-database.ts`) revisits the answer once replication delivers the wraps. Until
 *   then the repository fails closed on any secret carrying the `enc:` prefix (#333): such a
 *   document reads locked, so this state never hands ciphertext on as a code.
 * - **A wrap this device opens** → unlocked, with the cipher bound to the DEK.
 * - **Wraps for others only** → locked: the data is ciphertext and the key has not reached this
 *   device yet. F7's escrow recovery resolves this without ceremony when online.
 */
export async function resolveKeyState(
  database: PouchDB.Database,
  deps: KeyringDependencies = defaults,
): Promise<KeyState | undefined> {
  const { rows } = await database.allDocs({ ...projectKeyRange(), limit: 1 })
  if (rows.length === 0) return undefined
  const dek = await unlockProject(database, deps)
  return dek === null ? { kind: 'locked' } : { kind: 'unlocked', cipher: fieldCipher(dek) }
}

/**
 * The key state of a database that must have keys: what it already resolves to, else what
 * `mint` makes of it — **only for a database this device is the source of** (the catalogue).
 *
 * Resolve before minting: an own wrap is reused, and wraps for other devices only answer locked
 * and mint nothing (a second DEK beside one this device cannot open would split the project).
 *
 * Two minters at once — two tabs, or adoption beside the catalogue's own provider — both find
 * nothing and both mint; the second `key:<own kid>` write then conflicts, before anything else is
 * written, because the id is the same in every tab of this browser. The loser re-resolves and
 * answers the **winner's** DEK, so no device is ever encrypted under a key that lost. Any other
 * failure (quota, a keygen that fails) is raised as itself: it is a storage failure, not a lock,
 * and saying "after the next sync" about it would promise a remedy that is not coming.
 */
export async function ensureProjectKeys(
  database: PouchDB.Database,
  mint: (database: PouchDB.Database) => Promise<KeyState>,
  deps: KeyringDependencies = defaults,
): Promise<KeyState> {
  const existing = await resolveKeyState(database, deps)
  if (existing !== undefined) return existing
  try {
    return await mint(database)
  } catch (error) {
    if (!isConflict(error)) throw error
    const winner = await resolveKeyState(database, deps)
    if (winner === undefined) throw error
    return winner
  }
}

/** Whether a stored document still holds a commissioning code in plaintext. */
function holdsPlaintextCode(document: unknown): boolean {
  const { payload, manualCode } = (document ?? {}) as { payload?: unknown; manualCode?: unknown }
  return [payload, manualCode].some(
    (value) => typeof value === 'string' && !isEncryptedField(value),
  )
}

/**
 * Re-saves, through the unlocked cipher, every device still holding a plaintext code (#331).
 *
 * Only those: a device already sealed — by an earlier, interrupted run — is not touched at all,
 * and a half-sealed one is read back through the repository (whose decrypt passes plaintext
 * through) so that each field reaches `encryptField` as plaintext, never as `enc:` input, which
 * it refuses. Saved keeping `updatedAt`: re-encrypting changes nothing the reader entered, and
 * a fresh stamp would outrank a real edit in the merge order (ADR 0010, ruling R26).
 *
 * **And every conflicted device**, whatever its winner holds (review of #335): a losing revision
 * may be the plaintext one, and newer, so the merge takes its codes. The read below resolves the
 * conflict — writing that merge below the seam, then deleting the losers — and the re-save
 * encrypts the merged result, so the only live leaf left is ciphertext. Left to a later read,
 * the plaintext merge would stay at rest as the winner.
 */
export async function encryptPlaintextDevices(
  database: PouchDB.Database,
  keyState: KeyState,
  now?: () => string,
): Promise<void> {
  const { rows } = await database.allDocs({
    ...idRange('device'),
    include_docs: true,
    conflicts: true,
  })
  const { devices } = projectRepositories(database, now, keyState)
  for (const row of rows) {
    const conflicted = ((row.doc as { _conflicts?: unknown[] } | undefined)?._conflicts ?? [])
      .length
    if (conflicted === 0 && !holdsPlaintextCode(row.doc)) continue
    const device = await devices.get(row.id)
    if (device !== undefined) await devices.saveKeepingUpdatedAt(device)
  }
}
