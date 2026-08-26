import '@awesome.me/webawesome-pro/dist/components/qr-code/qr-code.js'
import { fixture, html, waitUntil } from '@open-wc/testing-helpers'
import { beforeEach, describe, expect, it } from 'vitest'
import {
  chooseDetector,
  type Detector,
  forgetDetector,
  zxingDetector,
} from '../../src/scan/detector.js'

/** The verified reference payload; see `packages/core/test/matter/payload.test.ts`. */
const PAYLOAD = 'MT:Y.K9042C00KA0648G00'

/**
 * A canvas carrying a genuinely rendered QR code.
 *
 * Rendered by `<wa-qr-code>` and copied pixel for pixel, rather than assembled from a fixture
 * string. The point of a decoder test is that it decodes an *image*; handing it bytes that
 * were never drawn would test the plumbing and not the reading.
 */
async function canvasShowing(payload: string): Promise<HTMLCanvasElement> {
  await customElements.whenDefined('wa-qr-code')
  const code = (await fixture(
    html`<wa-qr-code value=${payload} size="240" error-correction="H" fill="black" background="white"></wa-qr-code>`,
  )) as HTMLElement & { updateComplete?: Promise<unknown> }
  await code.updateComplete

  const drawn = code.shadowRoot?.querySelector('canvas') as HTMLCanvasElement | null
  await waitUntil(() => (drawn?.width ?? 0) > 0, 'the QR canvas never got dimensions')

  const canvas = document.createElement('canvas')
  canvas.width = (drawn as HTMLCanvasElement).width
  canvas.height = (drawn as HTMLCanvasElement).height
  canvas.getContext('2d')?.drawImage(drawn as HTMLCanvasElement, 0, 0)
  return canvas
}

/** A blank canvas: white, and carrying nothing. */
function blankCanvas(): HTMLCanvasElement {
  const canvas = document.createElement('canvas')
  canvas.width = 120
  canvas.height = 120
  const context = canvas.getContext('2d')
  if (context !== null) {
    context.fillStyle = 'white'
    context.fillRect(0, 0, canvas.width, canvas.height)
  }
  return canvas
}

describe('the ZXing detector', () => {
  it('reads a rendered QR code back to the payload it was drawn from', async () => {
    // This test runs on Linux CI, where `BarcodeDetector` does not exist. That is the point:
    // the fallback is the path most users are on, so it is the path that has to be proved.
    const detector = await zxingDetector()

    expect(await detector.read(await canvasShowing(PAYLOAD))).toEqual([PAYLOAD])
  })

  it('reads nothing from a frame with no code in it, rather than failing', async () => {
    // Most frames from a camera are this. If "no code here" arrived as an error, the scan
    // loop would spend its life handling exceptions for the normal case.
    const detector = await zxingDetector()

    expect(await detector.read(blankCanvas())).toEqual([])
  })
})

describe('choosing a detector', () => {
  // The choice is memoised, which is the point of the last test here and a trap for every
  // other one: without this, each case would be answered by whatever the first case decided.
  beforeEach(forgetDetector)

  const stub = (codes: readonly string[]): Detector => ({ read: async () => codes })

  it('does not so much as ask for the fallback when the platform has its own', async () => {
    // The scenario that keeps this honest. A static import would satisfy "iOS Safari scans"
    // while quietly shipping a WASM-sized bundle to everyone else, and nothing would be red.
    let asked = 0
    const chosen = await chooseDetector(
      () => stub(['native']),
      async () => {
        asked += 1
        return stub(['zxing'])
      },
    )

    expect(asked).toBe(0)
    expect(await chosen?.read(blankCanvas())).toEqual(['native'])
  })

  it('falls back when the platform has none', async () => {
    let asked = 0
    const chosen = await chooseDetector(
      () => undefined,
      async () => {
        asked += 1
        return stub(['zxing'])
      },
    )

    expect(asked).toBe(1)
    expect(await chosen?.read(blankCanvas())).toEqual(['zxing'])
  })

  it('has no detector at all when even the fallback will not load', async () => {
    // A blocked or failed chunk fetch. Answering "no detector" puts this back on the path
    // M2b-1 already handles - no scan control at all - rather than a button that throws.
    const chosen = await chooseDetector(
      () => undefined,
      async () => {
        throw new Error('the chunk never arrived')
      },
    )

    expect(chosen).toBeUndefined()
  })

  it('loads the fallback once, however often it is asked for', async () => {
    // Every frame goes through the chosen detector; re-importing per frame would be a
    // module-cache hit rather than a download, but re-*constructing* the reader is not free
    // and ZXing's own advice is to reuse one.
    let asked = 0
    const zxing = async () => {
      asked += 1
      return stub(['zxing'])
    }

    await chooseDetector(() => undefined, zxing)
    await chooseDetector(() => undefined, zxing)

    expect(asked).toBe(1)
  })
})
