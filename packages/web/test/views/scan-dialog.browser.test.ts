import '@awesome.me/webawesome-pro/dist/components/button/button.js'
import '@awesome.me/webawesome-pro/dist/components/callout/callout.js'
import '@awesome.me/webawesome-pro/dist/components/dialog/dialog.js'
import '@awesome.me/webawesome-pro/dist/components/icon/icon.js'
import { fixture, html, waitUntil } from '@open-wc/testing-helpers'
import { describe, expect, it } from 'vitest'
import type { ScanSource } from '../../src/scan/source.js'
import type { ScanDialog } from '../../src/views/scan-dialog.js'
import '../../src/views/scan-dialog.js'

/** The verified reference payload; see `packages/core/test/matter/payload.test.ts`. */
const PAYLOAD = 'MT:Y.K9042C00KA0648G00'

/**
 * A camera that is not a camera.
 *
 * Every browser test here drives one of these, and that is not a convenience — it is the only
 * option. `BarcodeDetector` delegates to platform-native detection that Linux does not
 * provide, so it does not exist in Chromium on Linux, which is what CI runs. A test built on
 * the real API would pass on a developer's Mac and vanish on CI, and this repository has
 * already been bitten once by a check that meant different things in the two places.
 */
function fakeSource(
  overrides: Partial<ScanSource> & { readonly codes?: readonly string[] } = {},
): ScanSource & { released(): boolean; reads(): number } {
  let reads = 0

  // A **real** MediaStream, from a canvas rather than a camera. A hand-rolled
  // `{ getTracks() }` will not do: assigning something that is not a MediaStream to
  // `video.srcObject` throws in Chromium, which killed the view's start-up before the read
  // loop began and made every test here time out for a reason that had nothing to do with
  // scanning. A canvas capture is a genuine stream with a genuine track, so `stop()` means
  // what it means in production and the release can be asserted through `readyState` rather
  // than through a spy that only proves a function was called.
  const canvas = document.createElement('canvas')
  canvas.width = 2
  canvas.height = 2
  const stream = canvas.captureStream(0)

  return {
    released: () => stream.getTracks().every((track) => track.readyState === 'ended'),
    reads: () => reads,
    available: overrides.available ?? (async () => true),
    open: overrides.open ?? (async () => stream),
    read:
      overrides.read ??
      (async () => {
        reads += 1
        return overrides.codes ?? []
      }),
    close:
      overrides.close ??
      ((open: MediaStream) => {
        for (const track of open.getTracks()) track.stop()
      }),
  }
}

/**
 * Builds an open dialog, with the scan listener attached from the start.
 *
 * Attached in the template rather than with `addEventListener` afterwards, and that is not
 * tidiness: the read loop issues its first read immediately, so a listener added after the
 * fixture resolves can miss the event entirely. An earlier version of these tests only passed
 * because the loop happened to wait one frame interval first — a test that depends on the
 * implementation being slow is a test that breaks when it stops being.
 */
async function dialog(
  source: ScanSource,
  onScan: (credential: string) => void = () => {},
): Promise<ScanDialog> {
  await customElements.whenDefined('wa-dialog')
  const element = (await fixture(
    html`<scan-dialog
      .source=${source}
      open
      @scan=${(event: Event) =>
        onScan((event as CustomEvent<{ credential: string }>).detail.credential)}
    ></scan-dialog>`,
  )) as ScanDialog
  await element.updateComplete
  return element
}

/** A promise, and the handle that settles it. */
function deferred<T>(): { promise: Promise<T>; settle: (value: T) => void } {
  let settle: (value: T) => void = () => {}
  const promise = new Promise<T>((resolve) => {
    settle = resolve
  })
  return { promise, settle }
}

/** What the dialog is telling the user, as text. */
const said = (element: ScanDialog): string => element.textContent ?? ''

describe('scanning a code', () => {
  it('reports the code it read and stops asking for more', async () => {
    const seen = deferred<string>()
    await dialog(fakeSource({ codes: [PAYLOAD] }), seen.settle)

    expect(await seen.promise).toBe(PAYLOAD)
  })

  it('releases the camera once it has what it came for', async () => {
    // The failure this guards is a camera light left on over a catalogue of someone's home.
    const source = fakeSource({ codes: [PAYLOAD] })
    const element = await dialog(source)

    await waitUntil(() => source.released(), 'the camera was never released')
    expect(element.scanning).toBe(false)
  })
})

describe('a code that is not a Matter code', () => {
  it('names what was wrong rather than saying it failed', async () => {
    const element = await dialog(fakeSource({ codes: ['https://example.com/not-a-device'] }))

    await waitUntil(() => element.querySelector('[data-scan-problem]') !== null, 'no message')

    // The reason comes from `readCredential` in core, which knows what it was looking at;
    // the sentence is the interface's, in the reader's language (#75). "Could not scan" would
    // be true and useless.
    expect(said(element)).toContain('manual pairing code of 11 or 21 digits')
  })

  it('keeps scanning, rather than dropping the user out of the flow', async () => {
    // Someone standing in front of a device with a phone up to it has not asked to stop. The
    // wrong code is usually the *other* sticker on the same box.
    const source = fakeSource({ codes: ['https://example.com/not-a-device'] })
    const element = await dialog(source)

    await waitUntil(() => element.querySelector('[data-scan-problem]') !== null)
    const readsWhenReported = source.reads()

    await waitUntil(() => source.reads() > readsWhenReported, 'the loop stopped after a bad code')
    expect(element.scanning).toBe(true)
  })

  it('clears the complaint once a good code arrives', async () => {
    let code = 'https://example.com/not-a-device'
    const seen = deferred<string>()
    const element = await dialog(fakeSource({ read: async () => [code] }), seen.settle)

    await waitUntil(() => element.querySelector('[data-scan-problem]') !== null)
    code = PAYLOAD

    expect(await seen.promise).toBe(PAYLOAD)
    await element.updateComplete
    expect(element.querySelector('[data-scan-problem]')).toBeNull()
  })
})

describe('when the camera will not open', () => {
  const refusing = (name: string) =>
    fakeSource({
      open: async () => {
        throw new DOMException('no', name)
      },
    })

  it('explains a refused permission and offers to type it instead', async () => {
    const element = await dialog(refusing('NotAllowedError'))

    await waitUntil(() => element.querySelector('[data-camera-problem]') !== null, 'said nothing')

    expect(said(element)).toContain('camera')
    // "The app does not appear broken": there is a way onward from here, and it is the way
    // that was always available.
    expect(element.querySelector('[data-type-instead]')).not.toBeNull()
  })

  it.each([
    ['NotAllowedError', 'permission'],
    ['NotFoundError', 'no camera'],
    ['NotReadableError', 'another application'],
  ])('says something different for %s', async (name, phrase) => {
    // Four situations, four messages. A single "camera unavailable" is what makes a
    // correctly-behaving application look broken.
    const element = await dialog(refusing(name))

    await waitUntil(() => element.querySelector('[data-camera-problem]') !== null)
    expect(said(element).toLowerCase()).toContain(phrase)
  })

  it('does not leave a half-open camera behind', async () => {
    const source = refusing('NotReadableError')
    const element = await dialog(source)

    await waitUntil(() => element.querySelector('[data-camera-problem]') !== null)
    expect(element.scanning).toBe(false)
  })
})

describe('closing the dialog', () => {
  it('releases the camera', async () => {
    const source = fakeSource()
    const element = await dialog(source)
    await waitUntil(() => element.scanning, 'the camera never opened')

    element.open = false
    await element.updateComplete

    await waitUntil(() => source.released(), 'the camera was left running')
    expect(element.scanning).toBe(false)
  })

  it('stops reading frames', async () => {
    const source = fakeSource()
    const element = await dialog(source)
    await waitUntil(() => source.reads() > 0, 'the loop never started')

    element.open = false
    await element.updateComplete
    const readsAtClose = source.reads()

    await new Promise((resolve) => setTimeout(resolve, 400))
    expect(source.reads()).toBe(readsAtClose)
  })

  it('does not report a code from a read that was still in flight', async () => {
    // The decode that started before the user closed the dialog and finished after. Reporting
    // it would fill the form from a scan the user cancelled — and on this form, that field is
    // the setup code.
    let release: (codes: readonly string[]) => void = () => {}
    const source = fakeSource({
      read: async () => new Promise<readonly string[]>((resolve) => (release = resolve)),
    })
    let reported = false
    const element = await dialog(source, () => {
      reported = true
    })
    await waitUntil(() => element.scanning, 'the camera never opened')

    element.open = false
    await element.updateComplete
    release([PAYLOAD])

    await new Promise((resolve) => setTimeout(resolve, 100))
    expect(reported).toBe(false)
  })

  it('releases a camera that finished opening after the dialog closed', async () => {
    // `open()` is a permission prompt, so "still in flight" can be several seconds of someone
    // reading a dialog and pressing Cancel. Without a check on the far side of that await, the
    // camera is opened after the user has left and stays open.
    let release: (stream: MediaStream) => void = () => {}
    const slow = fakeSource()
    const source = fakeSource({
      open: async () => {
        const stream = await slow.open()
        return new Promise<MediaStream>((resolve) => {
          release = () => resolve(stream)
        })
      },
    })
    const element = await dialog(source)

    await waitUntil(() => release !== undefined)
    element.open = false
    await element.updateComplete
    release(undefined as unknown as MediaStream)

    await waitUntil(() => slow.released(), 'the camera was left open behind a closed dialog')
    expect(element.scanning).toBe(false)
  })
})
