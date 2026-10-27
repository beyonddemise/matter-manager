import PouchDB from 'pouchdb-browser'
import { afterEach, describe, expect, it } from 'vitest'
import { encryptField, generateDek, wrapDek } from '../../../src/domain/crypto/envelope.js'
import { projectKeyDocumentId } from '../../../src/domain/documents/keys.js'
import { documentId } from '../../../src/domain/index.js'
import { ensureDeviceKey } from '../../../src/ui/db/device-key.js'
import {
  forgetProject,
  openProject,
  rawDatabase,
  refreshKeyStateOnInboundKeys,
} from '../../../src/ui/db/project-database.js'
import { type ManagerDependencies, syncManager } from '../../../src/ui/sync/manager.js'

/**
 * The stale-memo gap the #302 review found: a project database opened (and read) before
 * replication delivers its `key:*` documents memoises the keyless, plaintext state — and would
 * then hand ciphertext to every consumer, and write plaintext into an encrypted project. The
 * inbound paths must drop the memo when wrap documents arrive, through the same production
 * wiring `composition.ts` uses (`onInboundDocs: refreshKeyStateOnInboundKeys`), against a real
 * live replication between two real databases.
 */

const NOW = '2026-10-27T09:00:00.000Z'
const DEVICE_ID = documentId('device', '6ba7b810-9dad-11d1-80b4-00c04fd430c8')

const names: string[] = []
function uniqueName(prefix: string): string {
  const name = `${prefix}-keyrefresh-${crypto.randomUUID().slice(0, 8)}`
  names.push(name)
  return name
}

afterEach(async () => {
  for (const name of names.splice(0)) {
    forgetProject(name)
    await new PouchDB(name).destroy().catch(() => undefined)
  }
})

/** Reads until `ready` says the inbound documents are visible, bounded so a stall fails loudly. */
async function until<T>(read: () => Promise<T>, ready: (value: T) => boolean): Promise<T> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const value = await read()
    if (ready(value)) return value
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
  throw new Error('replication did not deliver the documents in time')
}

describe('the key state after inbound replication', () => {
  it('re-resolves when the wrap documents arrive, so the next read decrypts', async () => {
    const dbName = uniqueName('project_local')
    const repositories = openProject(dbName)
    // The first read, before anything replicated in: resolves and memoises the keyless state.
    expect(await repositories.devices.list()).toEqual([])

    // The server's copy: this device's own wrap, and a device encrypted under the wrapped DEK.
    const device = await ensureDeviceKey()
    const dek = await generateDek()
    const server = new PouchDB(uniqueName('server'))
    await server.put({
      _id: projectKeyDocumentId(device.kid),
      type: 'projectKey',
      kid: device.kid,
      alg: 'RSA-OAEP-256',
      wrapped: await wrapDek(dek, device.publicKeySpki),
      createdAt: NOW,
    })
    await server.put({
      _id: DEVICE_ID,
      type: 'device',
      name: 'Kitchen ceiling light',
      room: 'Ground Floor/Kitchen',
      manualCode: await encryptField(dek, DEVICE_ID, 'manualCode', '34970112332'),
      payload: await encryptField(dek, DEVICE_ID, 'payload', 'MT:Y.K9042C00KA0648G00'),
      installedAt: '2026-08-19',
      addedAt: NOW,
      disabled: false,
      remarks: [],
      updatedAt: NOW,
    })

    // The production wiring, down to the same callback `composition.ts` hands the manager.
    const deps: ManagerDependencies = {
      local: (name) => rawDatabase(name) as never,
      remote: () => server as never,
      onInboundDocs: refreshKeyStateOnInboundKeys,
    }
    const manager = syncManager(deps)
    manager.set([{ projectId: 'p-keyrefresh', dbName }])
    try {
      const devices = await until(
        () => repositories.devices.list(),
        (listed) => listed.length === 1,
      )
      // The memo was dropped before the read: plaintext, not the ciphertext the stale
      // plaintext state would have passed through untouched.
      expect(devices[0]?.manualCode).toBe('34970112332')
      expect(devices[0]?.payload).toBe('MT:Y.K9042C00KA0648G00')
    } finally {
      manager.stopAll()
    }
  })
})
