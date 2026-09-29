import '@awesome.me/webawesome-pro/dist/components/qr-code/qr-code.js'
import { fixture, html, waitUntil } from '@open-wc/testing-helpers'
import { describe, expect, it } from 'vitest'
import { codesFromImage, ImageScanError } from '../../../src/ui/scan/image.js'

/** The verified reference payload; see `test/domain/matter/payload.test.ts`. */
const PAYLOAD = 'MT:Y.K9042C00KA0648G00'

/**
 * A PNG file carrying a genuinely rendered QR code.
 *
 * Drawn by `<wa-qr-code>` and encoded to a real PNG, rather than assembled from a fixture
 * string, for the reason `detector.browser.test.ts` gives about its own canvas: the point of a
 * decoder test is that it decodes an *image*. Handing it bytes that were never drawn would
 * test the plumbing and not the reading. Going through `toBlob` adds the one step this module
 * owns and `detector.ts` does not — turning a file back into pixels.
 */
async function pngShowing(payload: string): Promise<Blob> {
  await customElements.whenDefined('wa-qr-code')
  const code = (await fixture(
    html`<wa-qr-code value=${payload} size="240" error-correction="H" fill="black" background="white"></wa-qr-code>`,
  )) as HTMLElement & { updateComplete?: Promise<unknown> }
  await code.updateComplete

  const drawn = code.shadowRoot?.querySelector('canvas') as HTMLCanvasElement | null
  await waitUntil(() => (drawn?.width ?? 0) > 0, 'the QR canvas never got dimensions')

  return await new Promise<Blob>((resolve, reject) => {
    ;(drawn as HTMLCanvasElement).toBlob((blob) => {
      if (blob === null) reject(new Error('the canvas produced no blob'))
      else resolve(blob)
    }, 'image/png')
  })
}

/** A PNG that is a real image and carries nothing. */
async function blankPng(): Promise<Blob> {
  const canvas = document.createElement('canvas')
  canvas.width = 120
  canvas.height = 120
  const context = canvas.getContext('2d')
  if (context !== null) {
    context.fillStyle = 'white'
    context.fillRect(0, 0, canvas.width, canvas.height)
  }
  return await new Promise<Blob>((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (blob === null) reject(new Error('the canvas produced no blob'))
      else resolve(blob)
    }, 'image/png')
  })
}

describe('reading a code out of an image file', () => {
  it('reads a rendered QR code back to the payload it was drawn from', async () => {
    expect(await codesFromImage(await pngShowing(PAYLOAD))).toEqual([PAYLOAD])
  })
  it('says there was no code when the image carries none', async () => {
    // Distinct from a file that could not be read at all: this one was a perfectly good
    // picture, it just was not a picture of a code. The two need different sentences, because
    // the answer to one is "try a clearer photograph" and to the other "that is not an image".
    await expect(codesFromImage(await blankPng())).rejects.toThrow(ImageScanError)
    await expect(codesFromImage(await blankPng())).rejects.toMatchObject({ problem: 'no-code' })
  })
  it('says the file was unreadable when it is not an image at all', async () => {
    // A PDF, a HEIC where HEIC is unsupported, or a file renamed to .png. `accept="image/*"`
    // filters the picker, it does not enforce anything - the file input will hand over
    // whatever a determined person selects.
    const notAnImage = new Blob(['MT:Y.K9042C00KA0648G00'], { type: 'text/plain' })
    await expect(codesFromImage(notAnImage)).rejects.toMatchObject({ problem: 'unreadable' })
  })

  it('says so when nothing in this browser can decode', async () => {
    // The upload control is offered without asking first, so this is the one failure that is
    // discovered at the moment of use rather than prevented before it.
    await expect(
      codesFromImage(await pngShowing(PAYLOAD), async () => undefined),
    ).rejects.toMatchObject({ problem: 'no-decoder' })
  })
})
