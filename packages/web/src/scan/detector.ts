/**
 * Reading codes out of a frame, by whichever means this browser has.
 *
 * Two implementations, and the split between them is deliberately **narrow**: what differs
 * between the native path and the fallback is only how a frame is read. Opening the camera,
 * releasing it, and reporting why it would not open are identical, so they stay in
 * `source.ts` and are not duplicated here. Duplicating them is precisely how the two paths
 * would stop being "indistinguishable", which is what M2b-2 asks for.
 *
 * **The fallback is not the exception.** `BarcodeDetector` is absent from Firefox everywhere,
 * from Chrome and Edge on Windows and Linux, and from Safari on both platforms (behind a
 * disabled-by-default preference). Chrome ships it on Android, ChromeOS and macOS. So this
 * file's second half is the path most people are on, and the only path on an iPhone.
 *
 * @module
 */

/**
 * Reads whatever codes are in one frame.
 *
 * Accepts a canvas as well as a video, and that is not generality for its own sake: it is what
 * lets a test hand the ZXing path a genuinely rendered QR code and check that it reads it
 * back. A decoder tested only through a camera is a decoder tested nowhere, because CI has no
 * camera — and no `BarcodeDetector` either.
 */
export interface Detector {
  read(source: HTMLVideoElement | HTMLCanvasElement): Promise<readonly string[]>
}

/** The `BarcodeDetector` surface used here. Declared because TypeScript's DOM lib omits it. */
interface BarcodeDetectorLike {
  detect(
    source: HTMLVideoElement | HTMLCanvasElement,
  ): Promise<ReadonlyArray<{ readonly rawValue: string }>>
}

interface BarcodeDetectorConstructor {
  new (options?: { formats?: readonly string[] }): BarcodeDetectorLike
  getSupportedFormats(): Promise<readonly string[]>
}

const barcodeDetector = (): BarcodeDetectorConstructor | undefined =>
  'BarcodeDetector' in globalThis
    ? (globalThis as unknown as { BarcodeDetector: BarcodeDetectorConstructor }).BarcodeDetector
    : undefined

/**
 * The platform's own detector, or `undefined` where there is none.
 *
 * Built once and reused: the specification asks for it in as many words — "detectors may
 * potentially allocate and hold significant resources; where possible, reuse the same
 * `BarcodeDetector` for several detections" — and this one is asked for a frame several times
 * a second.
 *
 * Narrowed to QR: the specification says limiting the formats "is likely to provide better
 * performance", and a one-dimensional barcode on a device's label is a serial number rather
 * than a setup code, so offering to read it would promise something that cannot work.
 */
export function nativeDetector(): Detector | undefined {
  const Detector = barcodeDetector()
  if (Detector === undefined) return undefined

  const detector = new Detector({ formats: ['qr_code'] })
  return {
    async read(source) {
      const found = await detector.detect(source)
      return found.map((barcode) => barcode.rawValue)
    },
  }
}

/** What the fallback needs from `@zxing/browser`, so a test can supply it without the module. */
type ZxingModule = {
  readonly BrowserQRCodeReader: new () => {
    decodeFromCanvas(canvas: HTMLCanvasElement): { getText(): string }
  }
}

/**
 * The ZXing fallback, imported only when it is going to be used.
 *
 * A **dynamic** import, and that is the entire second acceptance criterion of this story. A
 * static one would satisfy "iOS Safari scans" while shipping the decoder to every browser that
 * has no need of it — and nothing anywhere would be red.
 *
 * The frame is drawn to a canvas because ZXing reads canvases, and the canvas is reused across
 * frames: allocating one per frame at eight frames a second is garbage a phone has to collect
 * while its camera is running.
 */
export async function zxingDetector(
  load: () => Promise<ZxingModule> = () => import('@zxing/browser') as Promise<ZxingModule>,
): Promise<Detector> {
  const { BrowserQRCodeReader } = await load()
  const reader = new BrowserQRCodeReader()
  let scratch: HTMLCanvasElement | undefined

  const asCanvas = (
    source: HTMLVideoElement | HTMLCanvasElement,
  ): HTMLCanvasElement | undefined => {
    if (source instanceof HTMLCanvasElement) return source

    scratch ??= document.createElement('canvas')
    // A video before its first frame has no dimensions, and drawing from it throws. That is
    // the normal state for the first moment after the camera opens, not an error.
    if (source.videoWidth === 0 || source.videoHeight === 0) return undefined
    scratch.width = source.videoWidth
    scratch.height = source.videoHeight
    scratch.getContext('2d')?.drawImage(source, 0, 0)
    return scratch
  }

  return {
    async read(source) {
      const canvas = asCanvas(source)
      if (canvas === undefined) return []
      try {
        return [reader.decodeFromCanvas(canvas).getText()]
      } catch {
        // ZXing signals "no code in this image" by throwing, and most frames from a camera
        // have no code in them. Letting that propagate would make the normal case an
        // exception, several times a second.
        return []
      }
    },
  }
}

/** The chosen detector, once chosen. See {@link chooseDetector}. */
let chosen: Promise<Detector | undefined> | undefined

/**
 * The best detector this browser has, loading the fallback only if it must.
 *
 * Memoised across calls, so the fallback is imported and its reader constructed once rather
 * than per frame. Re-importing would be a module-cache hit, but re-constructing the reader is
 * not free and ZXing's own guidance is to reuse one.
 *
 * @param native the platform's detector factory, injectable so a test can pretend to be a
 *   browser it is not — CI runs Linux Chromium, which has no `BarcodeDetector`, so the native
 *   path cannot otherwise be exercised at all
 * @param zxing the fallback loader, injectable so a test can prove it was **not** called
 */
export async function chooseDetector(
  native: () => Detector | undefined = nativeDetector,
  zxing: () => Promise<Detector> = () => zxingDetector(),
): Promise<Detector | undefined> {
  chosen ??= (async () => {
    const platform = native()
    // Returned before `zxing` is so much as mentioned. The test that counts calls to it is
    // the one thing standing between this and a bundle everyone downloads.
    if (platform !== undefined) return platform

    try {
      return await zxing()
    } catch {
      // A blocked or failed chunk. Answering "no detector" puts this back on the path M2b-1
      // already handles — no scan control at all — rather than a control that throws.
      return undefined
    }
  })()
  return chosen
}

/** Forgets the memoised choice. For tests, which need to ask the question more than once. */
export function forgetDetector(): void {
  chosen = undefined
}
