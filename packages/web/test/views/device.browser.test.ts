import '@awesome.me/webawesome-pro/dist/components/button/button.js'
import '@awesome.me/webawesome-pro/dist/components/callout/callout.js'
import '@awesome.me/webawesome-pro/dist/components/copy-button/copy-button.js'
import '@awesome.me/webawesome-pro/dist/components/dialog/dialog.js'
import '@awesome.me/webawesome-pro/dist/components/icon/icon.js'
import '@awesome.me/webawesome-pro/dist/components/qr-code/qr-code.js'
import '@awesome.me/webawesome-pro/dist/components/tag/tag.js'
import '@awesome.me/webawesome-pro/dist/components/textarea/textarea.js'
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

/** Presses a control the way a user does, through the element the view rendered. */
function click(element: DeviceView, selector: string): void {
  const control = element.querySelector(selector) as HTMLElement | null
  if (control === null) throw new Error(`no control matching ${selector}`)
  control.click()
}

/** A second device, for the tests that navigate between two. */
const SECOND_UUID = '3fa85f64-5717-4562-b3fc-2c963f66afa6'

/**
 * The real repositories, with one device's writes held back.
 *
 * The mirror image of {@link slowFor}: a write that outlives the route it was issued from is
 * the same wrong-device failure as a stale read, arriving through the other door.
 */
function slowWrites(id: string, ms: number): ProjectRepositories {
  const real = database.repositories
  const wait = async (wanted: string) => {
    if (wanted === id) await new Promise((resolve) => setTimeout(resolve, ms))
  }
  return {
    ...real,
    devices: {
      ...real.devices,
      save: async (document) => {
        await wait(document._id)
        return real.devices.save(document)
      },
      remove: async (document) => {
        await wait(document._id)
        return real.devices.remove(document)
      },
    },
  }
}

/** The real repositories, with every device write refused — a full disk, a locked database. */
function refusingWrites(): ProjectRepositories {
  const real = database.repositories
  const refuse = async () => {
    throw new Error('storage refused the write')
  }
  return { ...real, devices: { ...real.devices, save: refuse, remove: refuse } }
}

/** Seeds a second device so a test can navigate away from the first one. */
async function seedSecond(): Promise<void> {
  await database.repositories.rooms.save({ _id: 'room:hall', type: 'room', path: 'Hall' })
  await database.repositories.devices.save(
    lamp({ _id: `device:${SECOND_UUID}`, name: 'Hall sensor', roomId: 'room:hall' }),
  )
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

describe('taking a device out of service', () => {
  it('disables it, keeps it, and stamps when', async () => {
    await seed()
    const element = await page()

    click(element, '[data-toggle-disabled]')
    await waitUntil(() => element.device?.disabled === true, 'the device was never disabled')

    const stored = await database.repositories.devices.get(DEVICE_ID)
    expect(stored?.disabled).toBe(true)
    expect(stored?.disabledAt).toMatch(/^\d{4}-\d{2}-\d{2}T/)
  })

  it('keeps the QR reproducible, which is the whole reason this is not a delete', async () => {
    await seed()
    const element = await page()

    click(element, '[data-toggle-disabled]')
    await waitUntil(() => element.device?.disabled === true, 'the device was never disabled')
    await element.updateComplete

    // The code has to survive on screen, not merely in storage: a device that comes off a wall
    // is exactly the one someone will need to re-commission somewhere else.
    expect((await database.repositories.devices.get(DEVICE_ID))?.payload).toBe(PAYLOAD)
    expect(element.querySelector('wa-qr-code')).not.toBeNull()
  })

  it('puts it back into service, dropping the timestamp', async () => {
    await seed(lamp({ disabled: true, disabledAt: '2026-08-20T09:00:00.000Z' }))
    const element = await page()

    click(element, '[data-toggle-disabled]')
    await waitUntil(() => element.device?.disabled === false, 'the device was never re-enabled')

    const stored = await database.repositories.devices.get(DEVICE_ID)
    expect(stored?.disabled).toBe(false)
    expect(stored).not.toHaveProperty('disabledAt')
  })

  it('leaves a revision the next action can use', async () => {
    // The write returns the stored document; keeping the stale one in hand would make the
    // *second* action fail as a conflict, for no reason the user did anything to cause.
    await seed()
    const element = await page()

    click(element, '[data-toggle-disabled]')
    await waitUntil(() => element.device?.disabled === true, 'the device was never disabled')
    await element.updateComplete
    click(element, '[data-toggle-disabled]')
    await waitUntil(() => element.device?.disabled === false, 'the second action never landed')

    expect((await database.repositories.devices.get(DEVICE_ID))?.disabled).toBe(false)
  })
})

describe('deleting a device', () => {
  it('asks first, and does not delete while it is asking', async () => {
    await seed()
    const element = await page()

    click(element, '[data-delete]')
    await element.updateComplete

    expect(element.confirmingDelete).toBe(true)
    expect(await database.repositories.devices.get(DEVICE_ID)).toBeDefined()
  })

  it('warns that the commissioning code goes with it', async () => {
    // "Are you sure?" is a question people learn to click past. The one fact that makes
    // someone stop is that the code cannot be recovered, so the dialog has to say it.
    await seed()
    const element = await page()

    click(element, '[data-delete]')
    await element.updateComplete

    const dialog = element.querySelector('[data-delete-dialog]')
    expect(dialog?.textContent).toContain('cannot be recovered')
    expect(dialog?.textContent).toContain('disable it instead')
  })

  it('deletes it once confirmed', async () => {
    await seed()
    const element = await page()

    click(element, '[data-delete]')
    await element.updateComplete
    click(element, '[data-confirm-delete]')

    await waitUntil(
      async () => (await database.repositories.devices.get(DEVICE_ID)) === undefined,
      'the device was never deleted',
      { timeout: 3000 },
    )
  })

  it('closes an open confirmation when the route moves to another device', async () => {
    await seed()
    await database.repositories.devices.save(
      lamp({ _id: `device:${SECOND_UUID}`, name: 'Hall sensor', roomId: 'room:hall' }),
    )
    const element = await page()

    click(element, '[data-delete]')
    await element.updateComplete
    element.uuid = SECOND_UUID
    await waitUntil(() => element.device?.name === 'Hall sensor')

    // A dialog left open over a different device is a confirmation aimed at the wrong record.
    expect(element.confirmingDelete).toBe(false)
  })
})

describe('a write that outlives the route it came from', () => {
  it('does not put the previous device back on screen when a disable lands late', async () => {
    // `load()` has a request token; the writes did not. Press Disable on A, navigate to B
    // before the write settles, and the resolved save assigns A's document to the view - so
    // the URL names B while the name, the QR and the pairing code are A's. That is the
    // wrong-device rendering this class exists to prevent, and it puts one device's setup
    // code on another device's page.
    await seed()
    await seedSecond()
    const element = await page(UUID, slowWrites(DEVICE_ID, 150))

    click(element, '[data-toggle-disabled]')
    element.uuid = SECOND_UUID
    await waitUntil(() => element.device?.name === 'Hall sensor', 'never reached the second device')

    await new Promise((resolve) => setTimeout(resolve, 300))
    await element.updateComplete

    expect(element.device?.name).toBe('Hall sensor')
    expect(element.querySelector('[data-manual-code]')?.textContent?.trim()).toBe(LONG_CODE)
    // The write itself still had to happen: dropping the result is not dropping the action.
    expect((await database.repositories.devices.get(DEVICE_ID))?.disabled).toBe(true)
  })

  it('does not navigate away when a delete lands after the route moved on', async () => {
    await seed()
    await seedSecond()
    const element = await page(UUID, slowWrites(DEVICE_ID, 150))

    click(element, '[data-delete]')
    await element.updateComplete
    click(element, '[data-confirm-delete]')
    element.uuid = SECOND_UUID
    await waitUntil(() => element.device?.name === 'Hall sensor', 'never reached the second device')

    window.location.hash = '#/sentinel'
    await new Promise((resolve) => setTimeout(resolve, 300))

    // Leaving is right for the page that was deleted, and wrong for the one the user is on now.
    expect(window.location.hash).toBe('#/sentinel')
    expect(await database.repositories.devices.get(DEVICE_ID)).toBeUndefined()
  })
})

describe('a write storage refuses', () => {
  it('says the disable did not happen instead of doing nothing visible', async () => {
    // Left to propagate, a rejected write is an unhandled rejection: the button un-busies and
    // the screen is unchanged, which looks exactly like a button that does nothing.
    await seed()
    const element = await page(UUID, refusingWrites())

    click(element, '[data-toggle-disabled]')
    await waitUntil(
      () => element.querySelector('[data-action-failed]') !== null,
      'the refused write was never reported',
    )

    expect(element.device?.disabled).toBe(false)
    expect(element.querySelector('[data-action-failed]')?.textContent).toContain('unchanged')
  })

  it('keeps the confirmation open and says why when a delete is refused', async () => {
    // Closing the dialog would look like the delete had happened, which for the one
    // irreversible action on this page is the wrong way to be wrong.
    await seed()
    const element = await page(UUID, refusingWrites())

    click(element, '[data-delete]')
    await element.updateComplete
    click(element, '[data-confirm-delete]')
    await waitUntil(
      () => element.querySelector('[data-delete-failed]') !== null,
      'the refused delete was never reported',
    )

    expect(element.confirmingDelete).toBe(true)
    expect(await database.repositories.devices.get(DEVICE_ID)).toBeDefined()
  })

  it('lets the action be retried once storage recovers', async () => {
    await seed()
    let refuse = true
    const real = database.repositories
    const flaky: ProjectRepositories = {
      ...real,
      devices: {
        ...real.devices,
        save: async (document) => {
          if (refuse) throw new Error('storage refused the write')
          return real.devices.save(document)
        },
      },
    }
    const element = await page(UUID, flaky)

    click(element, '[data-toggle-disabled]')
    await waitUntil(() => element.querySelector('[data-action-failed]') !== null)

    refuse = false
    click(element, '[data-toggle-disabled]')
    await waitUntil(() => element.device?.disabled === true, 'the retry never landed')
    await element.updateComplete

    expect(element.querySelector('[data-action-failed]')).toBeNull()
  })
})

describe('the busy guard belongs to the route that set it', () => {
  it('is not cleared by a write issued from the device the user has left', async () => {
    // Disable A (slow), navigate to B, disable B (slower). When A's write finally settles, an
    // unguarded `finally` clears `busy` — unlocking B's own guard while B's write is still in
    // flight, so a second press writes B again against the `_rev` the first press is still
    // using. The retry then fails as a conflict and reports an error for an action that worked.
    await seed()
    await seedSecond()

    const real = database.repositories
    const attempted: string[] = []
    const delays: Readonly<Record<string, number>> = {
      [DEVICE_ID]: 100,
      [`device:${SECOND_UUID}`]: 500,
    }
    const repositories: ProjectRepositories = {
      ...real,
      devices: {
        ...real.devices,
        save: async (document) => {
          attempted.push(document._id)
          await new Promise((resolve) => setTimeout(resolve, delays[document._id] ?? 0))
          return real.devices.save(document)
        },
      },
    }

    const element = await page(UUID, repositories)
    click(element, '[data-toggle-disabled]')

    element.uuid = SECOND_UUID
    await waitUntil(() => element.device?.name === 'Hall sensor', 'never reached the second device')
    await element.updateComplete
    click(element, '[data-toggle-disabled]')

    // Long enough for the first device's write to settle, and not for the second's.
    await new Promise((resolve) => setTimeout(resolve, 250))
    click(element, '[data-toggle-disabled]')
    await new Promise((resolve) => setTimeout(resolve, 600))

    expect(attempted.filter((id) => id === `device:${SECOND_UUID}`)).toHaveLength(1)
  })
})

describe('remarks', () => {
  /** A stored remark, of the shape the conflict merge already unions by id. */
  const note = (id: string, createdAt: string, text: string) => ({
    id,
    text,
    authorSub: 'auth0|someone',
    authorName: 'Someone',
    createdAt,
  })

  /** Types into the composer the way a user does, then presses the button. */
  async function write(element: DeviceView, text: string): Promise<void> {
    const box = element.querySelector('[data-remark-text]') as { value?: string } | null
    if (box === null) throw new Error('the remark composer is not on the page')
    box.value = text
    click(element, '[data-add-remark]')
    await element.updateComplete
  }

  /** The remarks as rendered, in the order they appear. */
  const shown = (element: DeviceView): string[] =>
    [...element.querySelectorAll('[data-remark]')].map((entry) =>
      (entry.querySelector('[data-remark-body]')?.textContent ?? '').trim(),
    )

  it('stores what was typed, with a timestamp and an author', async () => {
    await seed()
    const element = await page()

    await write(element, 'Replaced batteries')
    await waitUntil(
      () => (element.device?.remarks.length ?? 0) === 1,
      'the remark was never stored',
    )

    const stored = await database.repositories.devices.get(DEVICE_ID)
    expect(stored?.remarks).toHaveLength(1)
    expect(stored?.remarks[0]?.text).toBe('Replaced batteries')
    expect(stored?.remarks[0]?.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T/)
    expect(stored?.remarks[0]?.authorSub).not.toBe('')
    expect(stored?.remarks[0]?.id).not.toBe('')
  })

  it('shows the remark it just stored', async () => {
    await seed()
    const element = await page()

    await write(element, 'Replaced batteries')
    await waitUntil(() => shown(element).length === 1, 'the remark was never rendered')

    expect(shown(element)).toEqual(['Replaced batteries'])
  })

  it('leaves the remarks already there exactly as they were', async () => {
    // Append-only is the whole contract. A rewrite here would be invisible on screen and
    // would break the conflict merge, which unions by id and assumes an id means one text.
    const existing = note('aaa', '2026-08-01T10:00:00.000Z', 'Installed')
    await seed(lamp({ remarks: [existing] }))
    const element = await page()

    await write(element, 'Replaced batteries')
    await waitUntil(() => (element.device?.remarks.length ?? 0) === 2)

    const stored = await database.repositories.devices.get(DEVICE_ID)
    expect(stored?.remarks.find((entry) => entry.id === 'aaa')).toEqual(existing)
  })

  it('reads newest first', async () => {
    await seed(
      lamp({
        remarks: [
          note('aaa', '2026-08-01T10:00:00.000Z', 'Installed'),
          note('bbb', '2026-08-02T10:00:00.000Z', 'Moved to the north end'),
        ],
      }),
    )
    const element = await page()

    expect(shown(element)).toEqual(['Moved to the north end', 'Installed'])
  })

  it('puts a newly added remark above the ones before it', async () => {
    await seed(lamp({ remarks: [note('aaa', '2026-08-01T10:00:00.000Z', 'Installed')] }))
    const element = await page()

    await write(element, 'Replaced batteries')
    await waitUntil(() => shown(element).length === 2)

    expect(shown(element)[0]).toBe('Replaced batteries')
  })

  it('empties the composer once the remark is stored', async () => {
    await seed()
    const element = await page()

    await write(element, 'Replaced batteries')
    await waitUntil(() => shown(element).length === 1)

    const box = element.querySelector('[data-remark-text]') as { value?: string }
    expect(box.value).toBe('')
  })

  it('writes nothing when there is nothing to record', async () => {
    await seed()
    const element = await page()
    const before = (await database.repositories.devices.get(DEVICE_ID))?._rev

    await write(element, '   ')
    await element.updateComplete

    expect((await database.repositories.devices.get(DEVICE_ID))?._rev).toBe(before)
    expect(element.querySelector('[data-remark-failed]')).not.toBeNull()
  })

  it('keeps the typed text when storage refuses the write', async () => {
    // The one thing that must not happen to a remark: the user types a paragraph about what
    // they did to a device in a basement, the write fails, and the text is gone.
    await seed()
    const element = await page(UUID, refusingWrites())

    await write(element, 'Replaced batteries')
    await waitUntil(() => element.querySelector('[data-remark-failed]') !== null)

    const box = element.querySelector('[data-remark-text]') as { value?: string }
    expect(box.value).toBe('Replaced batteries')
  })

  it('does not carry a composer between devices', async () => {
    await seed()
    await seedSecond()
    const element = await page()
    const box = element.querySelector('[data-remark-text]') as { value?: string }
    box.value = 'half-written note about the kitchen light'

    element.uuid = SECOND_UUID
    await waitUntil(() => element.device?.name === 'Hall sensor')
    await element.updateComplete

    const moved = element.querySelector('[data-remark-text]') as { value?: string }
    expect(moved.value).toBe('')
  })

  it('says so rather than leaving a gap when there are no remarks yet', async () => {
    await seed()
    const element = await page()

    expect(shown(element)).toEqual([])
    expect(element.querySelector('[data-no-remarks]')).not.toBeNull()
  })
})
