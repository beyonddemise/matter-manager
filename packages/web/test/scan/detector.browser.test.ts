import '@awesome.me/webawesome-pro/dist/components/qr-code/qr-code.js'
import { fixture, html, waitUntil } from '@open-wc/testing-helpers'
import { beforeEach, describe, expect, it } from 'vitest'
import {
  chooseDetector,
  type Detector,
  forgetDetector,
  nativeDetector,
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

/** A detector that always reports the same codes. */
const stubDetector = (codes: readonly string[]): Detector => ({ read: async () => codes })

describe('the platform detector', () => {
  /**
   * Installs a fake `BarcodeDetector` for one test.
   *
   * @param formats what `getSupportedFormats()` resolves to
   * @param detect what `detect()` does; by default it finds nothing
   */
  function withBarcodeDetector(
    formats: readonly string[],
    detect: () => Promise<Array<{ rawValue: string }>> = async () => [],
  ): () => void {
    const original = Object.getOwnPropertyDescriptor(globalThis, 'BarcodeDetector')
    class Fake {
      static getSupportedFormats = async () => formats
      detect = detect
    }
    Object.defineProperty(globalThis, 'BarcodeDetector', { value: Fake, configurable: true })

    return () => {
      if (original === undefined) {
        Reflect.deleteProperty(globalThis, 'BarcodeDetector')
      } else {
        Object.defineProperty(globalThis, 'BarcodeDetector', original)
      }
    }
  }

  it('is used when the platform can read QR codes', async () => {
    const restore = withBarcodeDetector(['qr_code', 'ean_13'], async () => [{ rawValue: 'found' }])
    try {
      const detector = await nativeDetector()
      expect(await detector?.read(blankCanvas())).toEqual(['found'])
    } finally {
      restore()
    }
  })

  it('is absent when the platform has no barcode service behind the constructor', async () => {
    // **Android without Play Services** — Huawei, de-Googled builds, Fire OS, or Play Services
    // older than 19.7.42 (crbug.com/1020746). Blink exposes `BarcodeDetector` unconditionally
    // on Android and its constructor validates nothing: it drops unknown format strings and
    // passes the rest along as a *hint*. So the object exists, construction succeeds, and
    // `detect()` rejects with NotSupportedError on every frame forever.
    //
    // Without this check the scan button renders, the camera opens, and nothing is ever read —
    // silently, on the one platform where people are most likely to be scanning.
    const restore = withBarcodeDetector([])
    try {
      expect(await nativeDetector()).toBeUndefined()
    } finally {
      restore()
    }
  })

  it('is absent when the platform reads barcodes but not QR codes', async () => {
    // No shipping browser is in this state — every backend hardcodes or maps `qr_code`. It is
    // the same check as above rather than a second one: "can this platform read the only
    // format this application cares about" has one answer, and an empty list is one way to
    // say no.
    const restore = withBarcodeDetector(['ean_13', 'code_128'])
    try {
      expect(await nativeDetector()).toBeUndefined()
    } finally {
      restore()
    }
  })

  it('is absent when asking which formats are supported fails', async () => {
    // A rejection here is not an answer, and treating it as one either way is a guess. "No
    // native detector" is the conservative guess: it costs a fallback download and works.
    const original = Object.getOwnPropertyDescriptor(globalThis, 'BarcodeDetector')
    class Broken {
      static getSupportedFormats = async () => {
        throw new DOMException('Barcode detection service unavailable.', 'NotSupportedError')
      }
      detect = async () => []
    }
    Object.defineProperty(globalThis, 'BarcodeDetector', { value: Broken, configurable: true })

    try {
      expect(await nativeDetector()).toBeUndefined()
    } finally {
      if (original === undefined) Reflect.deleteProperty(globalThis, 'BarcodeDetector')
      else Object.defineProperty(globalThis, 'BarcodeDetector', original)
    }
  })

  it('is absent where there is no BarcodeDetector at all', async () => {
    // Firefox everywhere, and Chromium on Linux — which is CI. The property is *removed* here
    // rather than assumed absent: this suite runs on Chromium, and Chromium on macOS ships
    // `BarcodeDetector` while Chromium on Linux does not. An assertion about the ambient
    // platform would pass on CI and fail on a developer's machine, or the reverse, which is
    // worse than either.
    const original = Object.getOwnPropertyDescriptor(globalThis, 'BarcodeDetector')
    Reflect.deleteProperty(globalThis, 'BarcodeDetector')

    try {
      expect(await nativeDetector()).toBeUndefined()
    } finally {
      if (original !== undefined) {
        Object.defineProperty(globalThis, 'BarcodeDetector', original)
      }
    }
  })

  it('falls through to ZXing on a platform with no service', async () => {
    // The whole point of noticing. This browser genuinely cannot detect natively, and a JS
    // decoder can — so the user sees a working scanner rather than a broken one.
    forgetDetector()
    const restore = withBarcodeDetector([])
    try {
      const chosen = await chooseDetector(nativeDetector, async () => stubDetector(['zxing']))
      expect(await chosen?.read(blankCanvas())).toEqual(['zxing'])
    } finally {
      restore()
    }
  })
})

describe('choosing a detector', () => {
  // The choice is memoised, which is the point of the last test here and a trap for every
  // other one: without this, each case would be answered by whatever the first case decided.
  beforeEach(forgetDetector)

  const stub = stubDetector

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
