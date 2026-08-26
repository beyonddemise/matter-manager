import '@awesome.me/webawesome-pro/dist/components/button/button.js'
import '@awesome.me/webawesome-pro/dist/components/callout/callout.js'
import '@awesome.me/webawesome-pro/dist/components/copy-button/copy-button.js'
import '@awesome.me/webawesome-pro/dist/components/dialog/dialog.js'
import '@awesome.me/webawesome-pro/dist/components/icon/icon.js'
import '@awesome.me/webawesome-pro/dist/components/qr-code/qr-code.js'
import '@awesome.me/webawesome-pro/dist/components/tag/tag.js'
import { type DeviceDocument, decodePayload, type Unsaved } from '@matter-manager/core'
import type { ProjectRepositories } from '@matter-manager/data'
import { fixture, html, waitUntil } from '@open-wc/testing-helpers'
import { BrowserQRCodeReader } from '@zxing/browser'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { DeviceView } from '../../src/views/device.js'
import '../../src/views/device.js'
import { browserDatabase, type TestDatabase } from '../support/browser-database.js'

/** The verified reference device; see `packages/core/test/matter/payload.test.ts`. */
const PAYLOAD = 'MT:Y.K9042C00KA0648G00'
const LONG_CODE = '749701123365521327687'
const UUID = '6ba7b810-9dad-11d1-80b4-00c04fd430c8'
const DEVICE_ID = `device:${UUID}`

let database: TestDatabase

beforeEach(() => {
  database = browserDatabase()
})

afterEach(async () => {
  await database.destroy()
})

const lamp = (extra: Partial<DeviceDocument> = {}): Unsaved<DeviceDocument> => ({
  _id: DEVICE_ID,
  type: 'device',
  name: 'Kitchen ceiling light',
  roomId: 'room:kitchen',
  payload: PAYLOAD,
  manualCode: LONG_CODE,
  vendorId: 0xfff1,
  productId: 0x8000,
  discriminator: 3840,
  spot: 'ceiling, north end',
  serial: 'SN-000123',
  installedAt: '2026-08-19',
  addedAt: '2026-08-19T08:00:00.000Z',
  disabled: false,
  remarks: [],
  ...extra,
})

async function seed(device: Unsaved<DeviceDocument> = lamp()): Promise<void> {
  await database.repositories.rooms.save({
    _id: 'room:kitchen',
    type: 'room',
    path: 'Ground Floor/Kitchen',
  })
  await database.repositories.devices.save(device)
}

/**
 * The real repositories, with `devices.get` held back for one id.
 *
 * Injected at the seam the view already has for tests. Forcing the order two reads finish in
 * is the only way to exercise the stale-result guard: left to a real IndexedDB they resolve in
 * the order they were issued, and a test that cannot reverse them proves nothing.
 */
function slowFor(id: string, ms: number): ProjectRepositories {
  const real = database.repositories
  return {
    ...real,
    devices: {
      ...real.devices,
      get: async (wanted: string) => {
        if (wanted === id) await new Promise((resolve) => setTimeout(resolve, ms))
        return real.devices.get(wanted)
      },
    },
  }
}

async function page(uuid = UUID, repositories = database.repositories): Promise<DeviceView> {
  await Promise.all([
    customElements.whenDefined('wa-qr-code'),
    customElements.whenDefined('wa-dialog'),
  ])
  const element = (await fixture(
    html`<device-view uuid=${uuid} .repositories=${repositories}></device-view>`,
  )) as DeviceView
  await waitUntil(() => element.loaded, 'the device page never finished its read')
  await element.updateComplete
  return element
}

/**
 * Reads the text back out of a rendered `<wa-qr-code>`, through its canvas.
 *
 * `@zxing/browser` rather than the platform's `BarcodeDetector`, and that is a deliberate
 * choice rather than an oversight: `BarcodeDetector` exists in Chromium on macOS and not on
 * Linux, so a test built on it would pass on a laptop and vanish or fail on CI. This project
 * has already been bitten once by a check that meant different things in the two places.
 */
async function decodeRendered(qr: Element): Promise<string> {
  const element = qr as HTMLElement & { updateComplete?: Promise<unknown> }
  await element.updateComplete
  const canvas = element.shadowRoot?.querySelector('canvas') as HTMLCanvasElement | null
  await waitUntil(() => (canvas?.width ?? 0) > 0, 'the QR canvas never got dimensions')
  return new BrowserQRCodeReader().decodeFromCanvas(canvas as HTMLCanvasElement).getText()
}

describe('the reproduced code', () => {
  it('decodes back to identical field values', async () => {
    // The scenario this whole milestone exists for. Everything else on this page is
    // convenience; if the code that comes off the screen is not the code that went in, the
    // product has no reason to exist.
    //
    // Decoded from the pixels actually rendered, not from the property that was set - a test
    // asserting `qr.value === device.payload` would pass against a component that drew
    // nothing at all.
    await seed()
    const element = await page()

    const text = await decodeRendered(element.querySelector('wa-qr-code') as Element)

    expect(text).toBe(PAYLOAD)
    expect(decodePayload(text)).toEqual(decodePayload(PAYLOAD))

    // Field by field as well as whole-object, so a failure names which field moved.
    const scanned = decodePayload(text)
    expect(scanned.vendorId).toBe(0xfff1)
    expect(scanned.productId).toBe(0x8000)
    expect(scanned.discriminator).toBe(3840)
    expect(scanned.passcode).toBe(20202021)
  })

  it('survives the enlargement, which is a second render at a different size', async () => {
    await seed()
    const element = await page()

    ;(element.querySelector('[data-enlarge]') as HTMLElement).click()
    await element.updateComplete
    await waitUntil(
      () => element.querySelectorAll('wa-qr-code').length === 2,
      'the dialog never rendered its own QR',
    )

    const enlarged = [...element.querySelectorAll('wa-qr-code')].at(-1) as Element
    expect(await decodeRendered(enlarged)).toBe(PAYLOAD)
  })

  it('is rendered dark-on-light whatever the colour scheme is', async () => {
    // An inverted QR - light modules on a dark ground - is one many scanners will not read.
    // `<wa-qr-code>` takes its fill from `currentColor` and leaves the canvas transparent, so
    // without pinning these the code would invert in dark mode and fail silently.
    await seed()
    const element = await page()
    const qr = element.querySelector('wa-qr-code') as HTMLElement

    expect(qr.getAttribute('fill')).toBe('black')
    expect(qr.getAttribute('background')).toBe('white')
  })

  it('asks for the strongest error correction, in writing', async () => {
    // Currently the component's default too. Set explicitly so that a change to that default
    // cannot quietly downgrade codes destined for labels inside fuse boxes.
    await seed()
    const element = await page()

    expect(element.querySelector('wa-qr-code')?.getAttribute('error-correction')).toBe('H')
  })
})

describe('the page', () => {
  it('shows the pairing code beside the QR, exactly as stored', async () => {
    await seed()
    const element = await page()

    expect(element.querySelector('[data-manual-code]')?.textContent?.trim()).toBe(LONG_CODE)
    expect(element.querySelector('wa-copy-button')?.getAttribute('value')).toBe(LONG_CODE)
  })

  it('shows what the device is and where it is', async () => {
    await seed()
    const element = await page()

    expect(element.textContent).toContain('Kitchen ceiling light')
    expect(element.textContent).toContain('Ground Floor/Kitchen')
    expect(element.textContent).toContain('ceiling, north end')
    expect(element.textContent).toContain('SN-000123')
    // Ids as hex, the way every Matter document writes them.
    expect(element.textContent).toContain('0xFFF1')
  })

  it('offers a way back', async () => {
    await seed()
    const element = await page()
    expect(element.querySelector('a[href="#/"]')).not.toBeNull()
  })
})

describe('a device filed from a pairing code', () => {
  const codeOnly = (): Unsaved<DeviceDocument> => {
    const { payload: _payload, vendorId: _v, productId: _p, discriminator: _d, ...rest } = lamp()
    return { ...rest, manualCode: '34970112332' }
  }

  it('shows no QR, and says why rather than leaving a gap', async () => {
    // No payload can be invented from a pairing code: it carries only the top four bits of the
    // discriminator, so a reconstructed payload would encode cleanly and produce a QR that
    // silently fails to commission. An empty space would read as a bug; the sentence does not.
    await seed(codeOnly())
    const element = await page()

    expect(element.querySelector('wa-qr-code')).toBeNull()
    expect(element.querySelector('[data-no-payload]')).not.toBeNull()
  })

  it('still shows the pairing code, which commissions the device on its own', async () => {
    await seed(codeOnly())
    const element = await page()

    expect(element.querySelector('[data-manual-code]')?.textContent?.trim()).toBe('34970112332')
  })
})

describe('navigating from one device to another', () => {
  // The shell reuses a single `<device-view>` and updates its `uuid`, rather than building a
  // new element per route. Setting `uuid` on a mounted view is exactly what that navigation
  // does, so this reproduces it without the shell.
  const OTHER_UUID = '3fa85f64-5717-4562-b3fc-2c963f66afa6'
  const OTHER_PAYLOAD = 'MT:Y.K9042C00KA0648G00'

  async function seedTwo(): Promise<void> {
    await seed()
    await database.repositories.devices.save({
      _id: `device:${OTHER_UUID}`,
      type: 'device',
      name: 'Hall sensor',
      roomId: 'room:kitchen',
      payload: OTHER_PAYLOAD,
      manualCode: '34970112332',
      installedAt: '2026-08-19',
      addedAt: '2026-08-19T08:00:00.000Z',
      disabled: false,
      remarks: [],
    })
  }

  it('shows the device it navigated to, not the one it came from', async () => {
    await seedTwo()
    const element = await page()
    expect(element.textContent).toContain('Kitchen ceiling light')

    element.uuid = OTHER_UUID
    await waitUntil(
      () => element.textContent?.includes('Hall sensor') === true,
      'the view kept showing the device it came from',
    )

    expect(element.textContent).not.toContain('Kitchen ceiling light')
    expect(element.querySelector('[data-manual-code]')?.textContent?.trim()).toBe('34970112332')
  })

  it('does not let a slower earlier read overwrite the current device', async () => {
    // Navigating twice in quick succession issues two reads, and the network or disk decides
    // which finishes first. If the earlier one lands last, the page settles on the device the
    // user has already navigated away from - and nothing on screen looks wrong.
    //
    // The delay is on the FIRST navigation's read, so it resolves after the second's. Without
    // it the two reads would finish in order and the test would pass against a view with no
    // guard at all, proving nothing.
    await seedTwo()
    // Bound at construction, because the view resolves its repositories once and caches them:
    // assigning afterwards is ignored, which is how an earlier version of this test managed to
    // pass against a view with no guard at all.
    const element = await page(UUID, slowFor(`device:${OTHER_UUID}`, 120))

    element.uuid = OTHER_UUID
    // Awaited, and this is the point: two assignments in one turn collapse into a single Lit
    // update and a single read, which is no race at all. Letting the first update run is what
    // puts two reads in flight at once.
    await element.updateComplete
    element.uuid = UUID

    await waitUntil(
      () => element.loaded && element.device?._id === DEVICE_ID,
      'the view never settled on the device it was last asked for',
    )
    // Long enough for the delayed read to have landed if nothing were discarding it.
    await new Promise((resolve) => setTimeout(resolve, 250))

    expect(element.device?._id).toBe(DEVICE_ID)
    expect(element.textContent).toContain('Kitchen ceiling light')
    expect(element.textContent).not.toContain('Hall sensor')
  })

  it('closes an open enlargement when the device changes underneath it', async () => {
    await seedTwo()
    const element = await page()
    ;(element.querySelector('[data-enlarge]') as HTMLElement).click()
    await element.updateComplete
    expect(element.enlarged).toBe(true)

    element.uuid = OTHER_UUID
    await waitUntil(() => element.device?.name === 'Hall sensor')

    expect(element.enlarged).toBe(false)
  })
})

describe('an address that names no device', () => {
  it('says so and offers a way back, rather than rendering an empty page', async () => {
    const element = await page('00000000-0000-0000-0000-000000000000')

    expect(element.querySelector('wa-qr-code')).toBeNull()
    expect(element.textContent).toContain('not found')
    expect(element.querySelector('a[href="#/"]')).not.toBeNull()
  })

  it('treats a hand-mangled uuid as "no such device" rather than failing to render', async () => {
    // `documentId` refuses a uuid containing the separator. Letting that throw would take the
    // page down; a truncated or edited URL is a fact about the input, not a fault.
    const element = await page('device:not-a-uuid')

    expect(element.textContent).toContain('not found')
  })
})
