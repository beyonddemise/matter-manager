import '@awesome.me/webawesome-pro/dist/components/button/button.js'
import '@awesome.me/webawesome-pro/dist/components/callout/callout.js'
import '@awesome.me/webawesome-pro/dist/components/copy-button/copy-button.js'
import '@awesome.me/webawesome-pro/dist/components/details/details.js'
import '@awesome.me/webawesome-pro/dist/components/dialog/dialog.js'
import '@awesome.me/webawesome-pro/dist/components/icon/icon.js'
import '@awesome.me/webawesome-pro/dist/components/tag/tag.js'
import '@awesome.me/webawesome-pro/dist/components/textarea/textarea.js'
import { fixture, html, waitUntil } from '@open-wc/testing-helpers'
import PouchDB from 'pouchdb-browser'
import { afterEach, beforeAll, describe, expect, it } from 'vitest'
import { encryptField, generateDek, wrapDek } from '../../../src/domain/crypto/envelope.js'
import { projectKeyDocumentId } from '../../../src/domain/documents/keys.js'
import { documentId } from '../../../src/domain/index.js'
import { PROJECT_DATA_CHANGED } from '../../../src/ui/current-project.js'
import { ensureDeviceKey } from '../../../src/ui/db/device-key.js'
import {
  forgetProject,
  openProject,
  rawDatabase,
  refreshKeyStateOnInboundKeys,
} from '../../../src/ui/db/project-database.js'
import { type ManagerDependencies, syncManager } from '../../../src/ui/sync/manager.js'
import type { DeviceView } from '../../../src/ui/views/device.js'
import '../../../src/ui/views/device.js'
import '../../../src/ui/styles/app.css'

/**
 * #333, end to end: a pull that delivers a project's devices **before** its `key:*` documents.
 *
 * Nothing orders a pull that way round — a multi-shard `_changes` feed keeps no global order —
 * so the window is real, and during it the database is keyless. This drives the whole chain
 * through the production wiring: live replication into a database opened with `openProject`,
 * `onInboundDocs: refreshKeyStateOnInboundKeys` as `composition.ts` passes it, and the
 * `PROJECT_DATA_CHANGED` announcement `projects-controller.ts` makes on `onIncoming`. The page
 * must show the codes as pending (never the ciphertext), and then show them once the wraps land.
 */

const NOW = '2026-10-28T09:00:00.000Z'
const UUID = '6ba7b810-9dad-11d1-80b4-00c04fd430c8'
const DEVICE_ID = documentId('device', UUID)
const MANUAL_CODE = '34970112332'
const PAYLOAD = 'MT:Y.K9042C00KA0648G00'

const names: string[] = []
function uniqueName(prefix: string): string {
  const name = `${prefix}-keysafter-${crypto.randomUUID().slice(0, 8)}`
  names.push(name)
  return name
}

// Why: the device key is a cold RSA-3072 keygen on first use, and the unlock that follows the
// wraps' arrival needs it. Minted up front so that cost never lands inside a `waitUntil` below.
beforeAll(async () => {
  await ensureDeviceKey()
})

afterEach(async () => {
  for (const name of names.splice(0)) {
    forgetProject(name)
    await new PouchDB(name).destroy().catch(() => undefined)
  }
})

describe('a project whose devices replicate in before its key documents', () => {
  it('shows the codes as pending, then decrypts them once the wraps arrive', async () => {
    const device = await ensureDeviceKey()
    const dek = await generateDek()
    const server = new PouchDB(uniqueName('server'))
    // The server's copy holds, for now, only the encrypted device: its wrap is still to come.
    await server.put({
      _id: DEVICE_ID,
      type: 'device',
      name: 'Kitchen ceiling light',
      room: 'Ground Floor/Kitchen',
      manualCode: await encryptField(dek, DEVICE_ID, 'manualCode', MANUAL_CODE),
      payload: await encryptField(dek, DEVICE_ID, 'payload', PAYLOAD),
      installedAt: '2026-08-19',
      addedAt: NOW,
      disabled: false,
      remarks: [],
      updatedAt: NOW,
    })

    const dbName = uniqueName('project_local')
    const repositories = openProject(dbName)
    const deps: ManagerDependencies = {
      local: (name) => rawDatabase(name) as never,
      remote: () => server as never,
      onInboundDocs: refreshKeyStateOnInboundKeys,
      onIncoming: () => window.dispatchEvent(new CustomEvent(PROJECT_DATA_CHANGED)),
    }
    const manager = syncManager(deps)
    try {
      await customElements.whenDefined('wa-dialog')
      const element = (await fixture(
        html`<device-view uuid=${UUID} .repositories=${repositories}></device-view>`,
      )) as DeviceView
      manager.set([{ projectId: 'p-keysafter', dbName }])

      // The device has arrived and its key has not: pending, and no ciphertext anywhere.
      await waitUntil(
        () => element.querySelector('[data-code-pending]') !== null,
        'the device never showed as pending while its key was missing',
      )
      expect(element.querySelector('h1')?.textContent).toContain('Kitchen ceiling light')
      expect(element.querySelector('svg.app-qr')).toBeNull()
      expect(element.querySelector('wa-copy-button')).toBeNull()
      expect(element.innerHTML).not.toContain('enc:')

      // The wrap arrives on the next pull.
      await server.put({
        _id: projectKeyDocumentId(device.kid),
        type: 'projectKey',
        kid: device.kid,
        alg: 'RSA-OAEP-256',
        wrapped: await wrapDek(dek, device.publicKeySpki),
        createdAt: NOW,
      })

      await waitUntil(
        () => element.querySelector('[data-manual-code]') !== null,
        'the codes never appeared after the key documents arrived',
        { timeout: 5000 },
      )
      expect(element.querySelector('[data-manual-code]')?.textContent?.replace(/\D/g, '')).toBe(
        MANUAL_CODE,
      )
      expect(element.querySelector('svg.app-qr')).not.toBeNull()
      expect(element.querySelector('[data-code-pending]')).toBeNull()
      expect(element.innerHTML).not.toContain('enc:')
      // And the repository itself now answers the decrypted device.
      const read = await repositories.devices.get(DEVICE_ID)
      expect(read?.payload).toBe(PAYLOAD)
    } finally {
      manager.stopAll()
    }
  })
})
