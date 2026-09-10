/**
 * Turning a payload into PNG bytes a PDF can embed.
 *
 * The route is roundabout, and it is the only one available. `<wa-qr-code>` renders to a
 * canvas and keeps its encoder **inside the component** — there is no importable function that
 * returns a QR matrix. So a component is rendered off-screen, and its canvas is read back.
 *
 * The consequence is stated plainly because it drives everything here: **the printed code is
 * raster, not vector.** Render resolution is therefore a correctness concern rather than a
 * cosmetic one. A code rendered at its printed size and scaled up by the PDF is a code with
 * soft module edges, and a phone camera at arm's length in a fuse box is not a forgiving
 * reader.
 *
 * @module
 */

/**
 * How many pixels are rendered per PostScript point.
 *
 * Four, which puts a 96pt code on the page at 384 pixels — roughly 288 dpi against the 72 dpi
 * the point grid implies. That is comfortably past the 200-ish dpi where a printed QR starts
 * to lose module edges, and it costs a few hundred kilobytes in a document that exists to be
 * printed once and filed.
 *
 * A number rather than a "quality" setting, because there is nothing here a user could
 * usefully choose between.
 */
export const PIXELS_PER_POINT = 4

/**
 * `<wa-qr-code>`'s surface, as used here.
 *
 * Declared structurally rather than imported: the component is registered by a side-effecting
 * import, and its class is not part of the package's public types.
 */
interface QrElement extends HTMLElement {
  value: string
  size: number
  updateComplete?: Promise<unknown>
  shadowRoot: ShadowRoot | null
}

/** Where the off-screen codes are rendered. One host for all of them. */
function stage(): HTMLElement {
  const existing = document.querySelector('[data-qr-stage]')
  if (existing !== null) return existing as HTMLElement

  const host = document.createElement('div')
  host.setAttribute('data-qr-stage', '')
  host.setAttribute('aria-hidden', 'true')
  // Off-screen rather than `display: none`. A component in a `none` subtree may never lay out
  // or paint, and a canvas that never painted reads back as transparent — a QR code that is
  // present, correctly sized, and blank.
  host.style.position = 'fixed'
  host.style.left = '-10000px'
  host.style.top = '0'
  host.style.pointerEvents = 'none'
  document.body.append(host)
  return host
}

/**
 * Renders one payload and returns PNG bytes.
 *
 * @param payload the `MT:` string. **A secret** — it encodes the setup passcode, so it is
 *   never logged here or anywhere the bytes are handled.
 * @param sizeInPoints how large the code will be on the page
 * @returns the PNG, ready for `pdf-lib`'s `embedPng`
 * @throws if the component never paints, rather than returning a blank code. A blank QR in a
 *   printed inventory is the one failure this whole feature cannot tolerate: it looks like a
 *   code, files like a code, and is discovered years later by someone holding a phone up to it.
 */
export async function renderQrPng(payload: string, sizeInPoints: number): Promise<Uint8Array> {
  const element = document.createElement('wa-qr-code') as QrElement
  element.value = payload
  element.size = Math.round(sizeInPoints * PIXELS_PER_POINT)
  // The same reasoning as the on-screen code in `views/device.ts`: pinned black on white,
  // because `currentColor` in a dark scheme produces an inverted code many scanners refuse,
  // and maximum contrast is what makes this scan off paper.
  element.setAttribute('fill', 'black')
  element.setAttribute('background', 'white')
  element.setAttribute('error-correction', 'H')

  stage().append(element)
  try {
    await element.updateComplete
    const canvas = element.shadowRoot?.querySelector('canvas') as HTMLCanvasElement | null
    if (canvas === null || canvas.width === 0) {
      throw new Error('The QR component produced no canvas to read.')
    }

    const url = canvas.toDataURL('image/png')
    return decodeDataUrl(url)
  } finally {
    element.remove()
  }
}

/** The bytes out of a `data:` URL, without a network round trip through `fetch`. */
function decodeDataUrl(url: string): Uint8Array {
  const comma = url.indexOf(',')
  if (comma === -1) throw new Error('The QR canvas returned something that is not a data URL.')
  const binary = atob(url.slice(comma + 1))
  const bytes = new Uint8Array(binary.length)
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index)
  return bytes
}
