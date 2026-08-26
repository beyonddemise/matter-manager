/**
 * Where scanned codes come from.
 *
 * One interface with three implementations in mind: the camera below, the fakes the browser
 * tests drive, and — at M2b-2 — the ZXing fallback for browsers with no `BarcodeDetector`,
 * which becomes a second implementation rather than a branch inside the view.
 *
 * That last one is the reason this is an interface at all. `BarcodeDetector` is **not
 * available in Chromium on Linux**: it delegates to platform-native detection that Linux does
 * not provide, so it exists on Android, ChromeOS and macOS and nowhere else in Chrome. CI runs
 * Linux Chromium. A view that reached for `new BarcodeDetector()` directly would therefore be
 * a view no test in this repository could ever drive — and the failure paths, which are most
 * of the work here, are exactly what needs driving.
 *
 * @module
 */

/** A source of scanned text, and the camera preview that goes with it. */
export interface ScanSource {
  /**
   * Whether this browser can scan at all.
   *
   * Asked before the button is rendered, so that "no camera" is a control the user never sees
   * rather than one that fails when pressed.
   */
  available(): Promise<boolean>

  /**
   * Opens the camera.
   *
   * Rejects with the platform's own error, unchanged, so that {@link cameraProblem} can read
   * it. Wrapping it in something friendlier here would throw away the one piece of information
   * that decides which of the four messages the user sees.
   */
  open(): Promise<MediaStream>

  /** Every code visible in the current frame; empty when there is none. */
  read(video: HTMLVideoElement): Promise<readonly string[]>

  /** Releases the camera. Called on every exit from the dialog, including a failed one. */
  close(stream: MediaStream): void
}

/**
 * Whether the platform offers everything scanning needs.
 *
 * `navigator.mediaDevices` is `[SecureContext]`, so on plain HTTP it is `undefined` rather
 * than a method that rejects — an optional chain, not a `try`.
 */
function platformCanScan(): boolean {
  return (
    typeof navigator !== 'undefined' &&
    navigator.mediaDevices?.getUserMedia !== undefined &&
    'BarcodeDetector' in globalThis
  )
}

/** The `BarcodeDetector` surface this uses. Declared because TypeScript's DOM lib omits it. */
interface BarcodeDetectorLike {
  detect(source: HTMLVideoElement): Promise<ReadonlyArray<{ readonly rawValue: string }>>
}

interface BarcodeDetectorConstructor {
  new (options?: { formats?: readonly string[] }): BarcodeDetectorLike
  getSupportedFormats(): Promise<readonly string[]>
}

/**
 * The camera, read by the platform's own barcode detector.
 *
 * The detector is built once and reused: the specification asks for it in as many words —
 * "detectors may potentially allocate and hold significant resources; where possible, reuse
 * the same `BarcodeDetector` for several detections" — and this one is asked for a frame
 * several times a second.
 */
export function cameraSource(): ScanSource {
  let detector: BarcodeDetectorLike | undefined

  const construct = (): BarcodeDetectorLike => {
    const Detector = (globalThis as unknown as { BarcodeDetector: BarcodeDetectorConstructor })
      .BarcodeDetector
    // Narrowed to QR: the specification says limiting the formats "is likely to provide better
    // performance", and every other format here would be a code this application cannot read
    // anyway. A one-dimensional barcode on a device's label is a serial number, not a setup
    // code, and offering to scan it would promise something that cannot work.
    detector ??= new Detector({ formats: ['qr_code'] })
    return detector
  }

  return {
    async available(): Promise<boolean> {
      if (!platformCanScan()) return false

      try {
        const Detector = (globalThis as unknown as { BarcodeDetector: BarcodeDetectorConstructor })
          .BarcodeDetector
        // Present is not the same as able. Chrome on macOS shipped this interface for two
        // years in a state where it silently failed on Ventura and later, and asking which
        // formats it supports is the cheapest way to find out that it supports none.
        if (!(await Detector.getSupportedFormats()).includes('qr_code')) return false
      } catch {
        return false
      }

      try {
        const devices = await navigator.mediaDevices.enumerateDevices()
        // Before permission is granted this list is truncated to a single unlabelled camera,
        // so it can answer "is there one" and nothing more — which is all that is asked. The
        // authority on whether a camera actually opens is `open()` rejecting with
        // NotFoundError, and the dialog handles that too.
        return devices.some((device) => device.kind === 'videoinput')
      } catch {
        return false
      }
    },

    open(): Promise<MediaStream> {
      return navigator.mediaDevices.getUserMedia({
        // The camera on the back of the phone, because the user is standing in front of a
        // device holding the phone up to it. `facingMode` as a plain value rather than
        // `{ exact: 'environment' }`: exact makes this a required constraint, which a laptop
        // with only a front camera cannot satisfy, and it would reject with
        // OverconstrainedError on a machine that can perfectly well scan.
        video: { facingMode: 'environment' },
        audio: false,
      })
    },

    async read(video: HTMLVideoElement): Promise<readonly string[]> {
      const found = await construct().detect(video)
      return found.map((barcode) => barcode.rawValue)
    },

    close(stream: MediaStream): void {
      // Every track, not the first. The hardware indicator light goes out when nothing is
      // using the source any more, so one forgotten track leaves a camera that looks live to
      // the person holding the phone — and there is no more alarming way for a catalogue of
      // their home to behave.
      for (const track of stream.getTracks()) track.stop()
    },
  }
}
