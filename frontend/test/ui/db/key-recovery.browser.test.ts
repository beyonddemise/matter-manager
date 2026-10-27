import PouchDB from 'pouchdb-browser'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { isLockedDocument } from '../../../src/data/index.js'
import { encryptField, generateDek, wrapDek } from '../../../src/domain/crypto/envelope.js'
import { projectKeyDocumentId } from '../../../src/domain/documents/keys.js'
import { PROJECT_DOCUMENT_ID } from '../../../src/domain/documents/project.js'
import { documentId } from '../../../src/domain/index.js'
import { PROJECT_CHANGED } from '../../../src/ui/current-project.js'
import { ensureDeviceKey } from '../../../src/ui/db/device-key.js'
import {
  forgetProject,
  openProject,
  PROJECT_DATABASE_NAME,
  rawDatabase,
  useKeyRecovery,
  useProjectDatabase,
} from '../../../src/ui/db/project-database.js'
import { escrowApi, recoverProjectKey } from '../../../src/ui/escrow-client.js'
import { pullOnce } from '../../../src/ui/sync/replication.js'

/**
 * The open path of #304: a project that opens locked while online and signed in recovers its
 * key through escrow once, without anybody asking, and the views are told to re-read — through
 * the production seam (`useKeyRecovery` + the memoised key state in `project-database.ts`), over
 * real IndexedDB databases, the real device key, and the real recovery protocol. Only
 * `POST /escrow` is stubbed: it plays the server, writing the re-wrap into the "server" copy.
 */

const NOW = '2026-10-28T09:00:00.000Z'
const DEVICE_ID = documentId('device', '6ba7b810-9dad-11d1-80b4-00c04fd430c8')
const FOREIGN_KID = 'f'.repeat(64)

const names: string[] = []
function uniqueName(prefix: string): string {
  const name = `${prefix}_${crypto.randomUUID().replaceAll('-', '').slice(0, 12)}`
  names.push(name)
  return name
}

afterEach(async () => {
  useKeyRecovery(undefined)
  useProjectDatabase(PROJECT_DATABASE_NAME)
  vi.restoreAllMocks()
  for (const name of names.splice(0)) {
    forgetProject(name)
    await new PouchDB(name).destroy().catch(() => undefined)
  }
})

/**
 * A server project encrypted under a DEK this device holds no wrap for, already pulled into
 * this browser's copy — the "new device" state. Answers the server copy and a way to play the
 * server's re-wrap.
 */
async function lockedServerProject(dbName: string) {
  const device = await ensureDeviceKey()
  const dek = await generateDek()
  const server = new PouchDB(uniqueName('server'))
  await server.bulkDocs([
    { _id: PROJECT_DOCUMENT_ID, type: 'project', name: 'Villa Rosa', serverDb: dbName },
    {
      _id: projectKeyDocumentId(FOREIGN_KID),
      type: 'projectKey',
      kid: FOREIGN_KID,
      alg: 'RSA-OAEP-256',
      wrapped: 'AAAA',
      createdAt: NOW,
    },
    {
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
    },
  ])
  await pullOnce(rawDatabase(dbName) as never, server)

  /** What `POST /escrow` does on the server: wrap the DEK for the asking device, answer 204. */
  const rewrapOnServer = async (): Promise<void> => {
    await server.put({
      _id: projectKeyDocumentId(device.kid),
      type: 'projectKey',
      kid: device.kid,
      alg: 'RSA-OAEP-256',
      wrapped: await wrapDek(dek, device.publicKeySpki),
      createdAt: NOW,
    })
  }
  return { server, rewrapOnServer }
}

/** The recovery the application registers, over a stubbed `POST /escrow`, counting its runs. */
function registerRecovery(
  server: PouchDB.Database,
  answer: () => Promise<Response>,
  pull: (database: PouchDB.Database) => Promise<unknown> = (database) =>
    pullOnce(database as never, server),
) {
  const runs: string[] = []
  const posts: string[] = []
  const fetchImpl = (async (input: RequestInfo | URL) => {
    posts.push(String(input))
    return answer()
  }) as typeof fetch
  useKeyRecovery((dbName, database) => {
    runs.push(dbName)
    return recoverProjectKey(database, {
      api: escrowApi('/api', () => 'token-1', fetchImpl),
      pull: () => pull(database),
      reachable: () => true,
      keyring: { deviceKey: ensureDeviceKey, now: () => NOW },
      ensureRegistered: async () => {},
    })
  })
  return { runs, posts }
}

/**
 * A one-shot pull, through the real `pullOnce`, whose first batch lands `documents` in the
 * local copy and whose next batch fails: the connection dropping half way through.
 */
function pullFailingAfter(database: PouchDB.Database, documents: () => Promise<object[]>) {
  type Handler = (value: never) => void
  const handlers = new Map<string, Handler>()
  const oneShot = {
    on(event: string, handler: Handler) {
      handlers.set(event, handler)
      return oneShot
    },
    cancel() {},
  }
  const local = {
    replicate: {
      from: () => {
        setTimeout(async () => {
          const landed = await documents()
          await database.bulkDocs(landed, { new_edits: false } as never)
          handlers.get('change')?.({ docs: landed } as never)
          handlers.get('error')?.(new Error('the connection dropped') as never)
        }, 0)
        return oneShot
      },
      to: () => oneShot,
    },
  }
  return pullOnce(local as never, {})
}

/** Resolves on the next {@link PROJECT_CHANGED}, bounded so a recovery that never lands fails. */
function nextProjectChange(): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('the views were never told')), 5000)
    window.addEventListener(
      PROJECT_CHANGED,
      () => {
        clearTimeout(timer)
        resolve()
      },
      { once: true },
    )
  })
}

describe('a locked project on open', () => {
  it('recovers once through escrow and tells the open views to re-read unlocked', async () => {
    const dbName = uniqueName('project')
    const { server, rewrapOnServer } = await lockedServerProject(dbName)
    const { runs, posts } = registerRecovery(server, async () => {
      await rewrapOnServer()
      return new Response(null, { status: 204 })
    })
    useProjectDatabase(dbName)
    const changed = nextProjectChange()

    // The first read resolves the key state: locked, so the read answers without the secrets —
    // and recovery starts behind it, without anybody asking.
    const repositories = openProject(dbName)
    const [before] = await repositories.devices.list()
    expect(before !== undefined && isLockedDocument(before)).toBe(true)
    expect(before?.manualCode).toBeUndefined()

    await changed

    // The same repositories every view already holds now decrypt.
    const [after] = await repositories.devices.list()
    expect(after?.manualCode).toBe('34970112332')
    expect(after?.payload).toBe('MT:Y.K9042C00KA0648G00')
    expect(runs).toEqual([dbName])
    expect(posts).toEqual(['/api/escrow'])
  })

  it('stays locked on a refusal, tries once per open, and again on the next open', async () => {
    const warned = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const dbName = uniqueName('project')
    const { server } = await lockedServerProject(dbName)
    const { runs, posts } = registerRecovery(
      server,
      async () =>
        new Response(JSON.stringify({ title: 'Forbidden', status: 403 }), { status: 403 }),
    )
    const told = vi.fn()
    window.addEventListener(PROJECT_CHANGED, told)
    try {
      useProjectDatabase(dbName)
      told.mockClear()
      const repositories = openProject(dbName)

      await repositories.devices.list()
      await vi.waitFor(() => expect(posts).toHaveLength(1))
      // Further reads on the same open do not ask again: no retry loop.
      await repositories.devices.list()
      await repositories.devices.list()
      await new Promise((resolve) => setTimeout(resolve, 50))
      expect(runs).toHaveLength(1)
      expect(told).not.toHaveBeenCalled()
      const [still] = await repositories.devices.list()
      expect(still !== undefined && isLockedDocument(still)).toBe(true)

      // The next open of the project is the next attempt.
      useProjectDatabase(PROJECT_DATABASE_NAME)
      useProjectDatabase(dbName)
      await vi.waitFor(() => expect(posts).toHaveLength(2))
      expect(runs).toEqual([dbName, dbName])
      expect(warned).not.toHaveBeenCalled()
    } finally {
      window.removeEventListener(PROJECT_CHANGED, told)
    }
  })

  it('unlocksTheViewWhenAFailedPullAlreadyDeliveredTheWrap', async () => {
    const warned = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const dbName = uniqueName('project')
    const { server, rewrapOnServer } = await lockedServerProject(dbName)
    // The wrap is on the server already; the pull's first batch brings it, the second fails.
    await rewrapOnServer()
    const device = await ensureDeviceKey()
    const { posts } = registerRecovery(
      server,
      async () => new Response(null, { status: 204 }),
      (database) =>
        pullFailingAfter(database, async () => [
          await server.get(projectKeyDocumentId(device.kid)),
        ]),
    )
    useProjectDatabase(dbName)
    const changed = nextProjectChange()

    const repositories = openProject(dbName)
    const [before] = await repositories.devices.list()
    expect(before !== undefined && isLockedDocument(before)).toBe(true)

    // The recovery itself failed — but the wrap is local now, so the views are still told.
    await changed
    const [after] = await repositories.devices.list()
    expect(after?.manualCode).toBe('34970112332')
    expect(posts).toHaveLength(0)
    expect(warned).toHaveBeenCalled()
  })
})
