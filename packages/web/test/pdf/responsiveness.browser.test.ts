import '@awesome.me/webawesome-pro/dist/components/qr-code/qr-code.js'
import { browseDevices, type DeviceDocument, type RoomDocument } from '@matter-manager/core'
import { describe, expect, it } from 'vitest'
import {
  buildInventoryPdf,
  ExportCancelled,
  type InventoryLabels,
} from '../../src/pdf/inventory.js'
import { yieldToBrowser } from '../../src/pdf/yield.js'

/**
 * Does a large export freeze the interface?
 *
 * M3-5 says to **measure before reaching for a web worker**, and this is the measurement. It is
 * kept as a test rather than run once and written down, because "it was fine when I checked" is
 * not a property anybody can rely on six months later — a change to how codes are rasterised
 * could reintroduce a freeze with nothing else looking different.
 *
 * What is measured is the thing the criterion actually names. Not total time — a long export is
 * allowed to be long — but the **longest single stretch during which the main thread never came
 * back**. That is what "the interface remains responsive" means: a user who taps Cancel gets an
 * answer, the progress bar moves, the page scrolls.
 */

const PAYLOAD = 'MT:Y.K9042C00KA0648G00'

const LABELS: InventoryLabels = {
  title: 'Inventory',
  pageNumber: (page, total) => `Page ${page} of ${total}`,
  continued: (path) => `${path} (continued)`,
  installed: 'Installed',
  pairingCode: 'Pairing code',
  noQrCode: 'No QR code',
  withoutRoom: 'Without a room',
  nothingToExport: 'Nothing to export.',
}

const ROOMS: readonly RoomDocument[] = [
  {
    _id: 'room:kitchen',
    _rev: '1-a',
    updatedAt: '2026-08-19T08:00:00.000Z',
    type: 'room',
    path: 'Ground Floor/Kitchen',
  },
]

const devices = (count: number): DeviceDocument[] =>
  Array.from({ length: count }, (_, index) => ({
    _id: `device:${index}`,
    _rev: '1-a',
    updatedAt: '2026-08-19T08:00:00.000Z',
    type: 'device' as const,
    name: `Device ${index}`,
    roomId: 'room:kitchen',
    payload: PAYLOAD,
    manualCode: '34970112332',
    installedAt: '2026-08-19',
    addedAt: '2026-08-19T08:00:00.000Z',
    disabled: false,
    remarks: [],
  }))

/**
 * The longest gap between successive animation frames while `work` runs.
 *
 * `requestAnimationFrame` is the right clock for this: it fires when the browser is ready to
 * paint, so a gap between frames is exactly a stretch in which nothing could be painted and no
 * input could be handled. A `setInterval` would measure the same thing less honestly, since a
 * late interval callback can be coalesced.
 */
async function longestFrameGap(work: () => Promise<unknown>): Promise<number> {
  let worst = 0
  let last = performance.now()
  let watching = true

  const tick = () => {
    const now = performance.now()
    worst = Math.max(worst, now - last)
    last = now
    if (watching) requestAnimationFrame(tick)
  }
  requestAnimationFrame(tick)

  // One frame before starting, so the measurement does not open with the gap between the
  // test's own setup and the first frame.
  await new Promise((resolve) => requestAnimationFrame(resolve))
  last = performance.now()
  worst = 0

  try {
    await work()
  } finally {
    watching = false
  }
  return worst
}

/**
 * What counts as frozen, on an idle machine with nothing to do.
 *
 * Used only by the control below, where no work is happening and any gap this large means the
 * runner is not delivering frames at all.
 */
const FROZEN = 250

/**
 * How many devices the measurements use.
 *
 * Small, and the number is not the point. The failure being measured is *accumulation* — work
 * that piles into one block instead of being spread — and accumulation shows at twenty devices
 * exactly as it shows at five hundred, proportionally. What a large count buys is a slow test:
 * CI's runner takes roughly seventeen times as long per device as a developer machine, and the
 * first version of this file (200 devices) timed out there at two minutes while passing locally
 * in eight seconds.
 */
const DEVICES = 40

/**
 * The largest share of an export that may happen in one unbreakable stretch.
 *
 * **A fraction of the whole, not a millisecond budget and not a multiple of the per-device
 * cost.** Both of those were tried and both measure the wrong thing:
 *
 * - An absolute budget measures the *machine*. One device costs about 40ms on a developer
 *   laptop and about 675ms on CI, so a 250ms ceiling asserts "this runner is fast" rather than
 *   "this loop yields" — and it timed CI out while passing locally.
 * - A multiple of the per-device average measures the *device count*. The export has fixed
 *   costs that do not scale — embedding fonts at the start, saving the document at the end — so
 *   the ratio worsens as the count shrinks, and the threshold has to be retuned whenever the
 *   test is made cheaper.
 *
 * A share of the total is independent of both. It asks exactly the question the criterion asks:
 * is the work spread across the export, or does it pile into one block? Measured before the
 * fix, one block was **98%** of an eight-second export; measured after, the worst is around
 * **12%**.
 */
const WORST_SHARE = 0.35

describe('the measurement itself', () => {
  it('sees frames arriving when nothing is blocking', async () => {
    // The positive control, and it is not optional here. This measurement is "the longest gap
    // between animation frames", and a headless or backgrounded browser throttles
    // `requestAnimationFrame` to something far slower than 60Hz — which would make every
    // number below a measurement of the harness rather than of the export. If this case
    // reports seconds, nothing else in this file means anything (lesson L3).
    const idle = await longestFrameGap(async () => {
      for (let index = 0; index < 200; index += 1) await yieldToBrowser()
    })

    expect(idle).toBeLessThan(FROZEN)
  }, 30_000)
})

describe('a large export', () => {
  it('never spends most of the export in one unbreakable block', async () => {
    // The property, stated so that it survives being run on a slow machine: no single stretch
    // of unyielded work accounts for much of the export. Before this feature existed, one
    // block was 98% of it.
    const groups = browseDevices(devices(DEVICES), ROOMS)
    let seen = 0

    const started = performance.now()
    const worst = await longestFrameGap(() =>
      buildInventoryPdf(groups, { labels: LABELS, onProgress: () => (seen += 1) }),
    )
    const total = performance.now() - started

    expect(seen).toBe(DEVICES)
    expect(worst).toBeLessThan(total * WORST_SHARE)
  }, 300_000)

  it('does not save up its work for one block at the end', async () => {
    // The failure this feature actually had, and the one a frame-gap measurement alone would
    // report without locating. `embedPng` is lazy — it registers an embedder and decodes at
    // save time — so two hundred images used to be processed in a single synchronous call
    // *after* the last progress callback, while the loop above looked perfectly well-behaved.
    // Measured 5.6 seconds; measured 24ms once the work was flushed inside the loop.
    const groups = browseDevices(devices(DEVICES), ROOMS)
    let lastProgress = 0

    const started = performance.now()
    await buildInventoryPdf(groups, {
      labels: LABELS,
      onProgress: () => {
        lastProgress = performance.now()
      },
    })
    const total = performance.now() - started
    const afterLastDevice = performance.now() - lastProgress

    // Relative for the same reason as above. Measured before the fix, the tail was 5.6 seconds
    // against a total of 8 — about seventy per cent of the export in one unbreakable call.
    // A share of the whole, for the same reason as above. Measured before the fix, this tail
    // was 5.6 seconds against a total of 8 — sixty-nine per cent of the export in one
    // unbreakable call, after the last progress callback had already reported 100%.
    expect(afterLastDevice).toBeLessThan(total * WORST_SHARE)
    expect(lastProgress).toBeGreaterThan(started)
  }, 300_000)

  it('reports progress the whole way through, not in one burst at the end', async () => {
    // Progress that arrives as 200 callbacks in the final millisecond is a progress bar that
    // jumps from 0 to 100, which is what a frozen interface looks like from the outside.
    const groups = browseDevices(devices(DEVICES), ROOMS)
    const stamps: number[] = []

    await buildInventoryPdf(groups, {
      labels: LABELS,
      onProgress: () => stamps.push(performance.now()),
    })

    const total = (stamps.at(-1) ?? 0) - (stamps[0] ?? 0)
    const firstHalf = (stamps[DEVICES / 2 - 1] ?? 0) - (stamps[0] ?? 0)
    // The first half of the devices should take roughly half the time. Loose bounds: this is
    // asserting "spread out", not "uniform", and CI machines are noisy.
    expect(firstHalf).toBeGreaterThan(total * 0.2)
    expect(firstHalf).toBeLessThan(total * 0.8)
  }, 300_000)

  it('stops within a device or two of being told to', async () => {
    // "The export can be cancelled" is only true if it stops *soon*. A cancel that is honoured
    // after the remaining four hundred devices have been drawn is not a cancel.
    const groups = browseDevices(devices(DEVICES), ROOMS)
    let done = 0
    let stopAfter = 0

    await expect(
      buildInventoryPdf(groups, {
        labels: LABELS,
        onProgress: ({ done: count }) => {
          done = count
          if (count === 5) stopAfter = count
        },
        cancelled: () => stopAfter > 0,
      }),
    ).rejects.toThrow(ExportCancelled)

    expect(done).toBeLessThan(10)
  }, 300_000)
})
