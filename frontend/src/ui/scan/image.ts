/**
 * Reading codes out of a picture someone chose, rather than out of a camera.
 *
 * The decode itself is not new work: {@link Detector} already accepts a canvas as well as a
 * video, precisely so it can be handed a still. All this module adds is the step between a
 * file and those pixels.
 *
 * @module
 */

import { chooseDetector, type Detector } from './detector.js'

/**
 * Why a chosen image produced no setup code.
 *
 * Three outcomes rather than one, because the sentence each deserves is different and so is
 * what the reader should do next. "That is not an image" and "there is no code in that image"
 * are the same failure only to a program.
 *
 * A code that *was* read but is not a Matter credential is deliberately absent: `readCredential`
 * already decides that and already says what is wrong, in `PayloadProblem`. Answering it a
 * second time here would be two sources for one question, and they would drift.
 */
export type ImageProblem =
  /** The file could not be decoded as an image at all. */
  | 'unreadable'
  /** A perfectly good picture, carrying no code. */
  | 'no-code'
  /** Nothing in this browser can read codes, and the fallback would not load. */
  | 'no-decoder'

/** Raised by {@link codesFromImage}, carrying the reason as a code rather than a sentence. */
export class ImageScanError extends Error {
  readonly problem: ImageProblem

  constructor(problem: ImageProblem) {
    // The message is for a developer reading a stack trace. What the *user* is shown is chosen
    // from `problem` at render time, so that switching language re-renders it rather than
    // freezing whichever language was active when the file was chosen (#75).
    super(`image scan failed: ${problem}`)
    this.name = 'ImageScanError'
    this.problem = problem
  }
}

/**
 * Every code in the image, in the order the decoder found them.
 *
 * Drawn at the image's natural size, with no downscaling, and that is a decision rather than
 * an omission. The picture this is given is usually a phone photograph of a label on a device
 * in a cupboard, where the code occupies a small part of the frame — shrinking the image is
 * exactly what destroys it. The cost is one decode of a large canvas, paid once per file
 * rather than several times a second as the camera loop pays it.
 *
 * @param file the image, as chosen from a file input
 * @param detector injected by tests; the memoised platform-or-ZXing choice otherwise
 */
export async function codesFromImage(
  file: Blob,
  detector: () => Promise<Detector | undefined> = chooseDetector,
): Promise<readonly string[]> {
  let bitmap: ImageBitmap
  try {
    bitmap = await createImageBitmap(file)
  } catch {
    // Anything the browser will not decode: a PDF, a HEIC where HEIC is unsupported, a file
    // renamed to .png, or a truncated download. `accept="image/*"` filters the picker; it
    // enforces nothing, so this path is reachable however the control is labelled.
    throw new ImageScanError('unreadable')
  }

  const canvas = document.createElement('canvas')
  canvas.width = bitmap.width
  canvas.height = bitmap.height
  canvas.getContext('2d')?.drawImage(bitmap, 0, 0)
  // Released as soon as it has been copied: a decoded phone photograph is tens of megabytes of
  // bitmap, and letting the garbage collector decide when to let go of it is how choosing three
  // files in a row runs a tab out of memory.
  bitmap.close()

  // Asked here, at the moment a file is chosen, and not when the control is rendered. On a
  // browser without `BarcodeDetector` this is what downloads the ZXing chunk, and the upload
  // button is offered to everyone - including the machines with no camera that never fetch it
  // today. Asking early would put that download on every page load to buy an answer almost
  // nobody needs.
  const chosen = await detector()
  if (chosen === undefined) throw new ImageScanError('no-decoder')

  const codes = await chosen.read(canvas)
  if (codes.length === 0) throw new ImageScanError('no-code')
  return codes
}
