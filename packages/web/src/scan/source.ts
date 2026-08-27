/**
 * Where scanned codes come from: the camera, and whichever detector this browser has.
 *
 * The camera half is the same whatever reads the frames — opening it, releasing it, and
 * reporting why it would not open do not vary — so it lives here once and the reading is
 * delegated to a {@link Detector}. Keeping the split that narrow is what makes the native path
 * and the ZXing fallback "indistinguishable" in the sense M2b-2 asks for: there is only one
 * implementation of everything except the decode itself.
 *
 * This is also an interface because a test cannot use the real one. `BarcodeDetector` is **not
 * available in Chromium on Linux** — it delegates to platform-native detection Linux does not
 * provide — and CI runs Linux Chromium. A view that reached for `new BarcodeDetector()`
 * directly would be a view no test in this repository could ever drive, and the failure paths
 * are most of the work.
 *
 * @module
 */

import { chooseDetector, type Detector } from './detector.js'

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
 * Whether this page is allowed to ask for a camera at all.
 *
 * `navigator.mediaDevices` is `[SecureContext]`, so on plain HTTP it is `undefined` rather
 * than a method that rejects — an optional chain, not a `try`.
 */
function canAskForCamera(): boolean {
  return typeof navigator !== 'undefined' && navigator.mediaDevices?.getUserMedia !== undefined
}

/**
 * The camera, read by whichever detector this browser has.
 *
 * @param detector how frames are read, injectable for tests. By default the platform's own,
 *   or the ZXing fallback loaded on demand — see `detector.ts`.
 */
export function cameraSource(
  detector: () => Promise<Detector | undefined> = chooseDetector,
): ScanSource {
  return {
    async available(): Promise<boolean> {
      if (!canAskForCamera()) return false
      // Asked here rather than at the first frame, because the answer decides whether the scan
      // control is rendered at all — and on the fallback path, asking is what downloads the
      // decoder. Doing it later would mean a control that exists and then cannot work.
      if ((await detector()) === undefined) return false

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
      // `chooseDetector` is memoised, so this is a resolved promise after the first frame
      // rather than a fresh decision several times a second.
      return (await detector())?.read(video) ?? []
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
