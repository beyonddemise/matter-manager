import { msg, updateWhenLocaleChanges } from '@lit/localize'
import { PayloadError, readCredential } from '@matter-manager/core'
import { html, LitElement, type PropertyValues, type TemplateResult } from 'lit'
import type { CameraProblem } from '../scan/problem.js'
import { cameraProblem } from '../scan/problem.js'
import { cameraSource, type ScanSource } from '../scan/source.js'

/**
 * How long to wait between frames, in milliseconds.
 *
 * Not `requestAnimationFrame`. Sixty reads a second is thirty times more than anyone needs to
 * catch a code held up to a phone, and it heats the phone doing it — which matters here more
 * than usual, because the phone is being held at arm's length in front of a device, often in a
 * cupboard, by someone who would like this to take a moment.
 */
const FRAME_INTERVAL = 120

/** Resolves after `ms`. */
const pause = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * The camera, pointed at a setup code.
 *
 * Everything difficult here is a failure path, which is what the issue said it would be. The
 * decode itself is `core`'s: `readCredential` already knows what a Matter code is and already
 * says what is wrong with one that is not, in a message that never echoes the input — the
 * input being a setup passcode.
 *
 * The scanned code leaves through a `scan` event and **never through the URL**. A payload in a
 * hash fragment is a setup passcode written into browser history, which is a place nobody
 * thinks to clear.
 */
export class ScanDialog extends LitElement {
  /** Light DOM, so Web Awesome's global utility classes reach this markup. */
  protected override createRenderRoot(): HTMLElement {
    return this
  }

  static override properties = {
    open: { type: Boolean, reflect: true },
    source: { attribute: false },
    scanning: { state: true },
    cameraFailure: { state: true },
    codeFailure: { state: true },
  }

  declare open: boolean
  /** Bound by a test to a camera that is not one; the real camera otherwise. */
  declare source?: ScanSource
  /** Whether a camera is open and frames are being read. */
  declare scanning: boolean
  /** Why the camera would not open, if it would not. */
  declare cameraFailure: CameraProblem | undefined
  /**
   * What was wrong with the last code read, if it was not a setup code.
   *
   * The message from `core`, kept whole. Rewriting it here would be a second answer to a
   * question `readCredential` already answers, and the two would drift.
   */
  declare codeFailure: string | undefined

  constructor() {
    super()
    updateWhenLocaleChanges(this)
    this.open = false
    this.scanning = false
    this.cameraFailure = undefined
    this.codeFailure = undefined
  }

  private stream: MediaStream | undefined
  private resolved: ScanSource | undefined

  private scanner(): ScanSource {
    this.resolved ??= this.source ?? cameraSource()
    return this.resolved
  }

  protected override updated(changed: PropertyValues<this>): void {
    if (!changed.has('open')) return
    if (this.open) void this.start()
    else this.stop()
  }

  /** Releases the camera when the element goes away with the dialog still open. */
  override disconnectedCallback(): void {
    super.disconnectedCallback()
    this.stop()
  }

  private async start(): Promise<void> {
    if (this.scanning) return
    this.cameraFailure = undefined
    this.codeFailure = undefined

    let stream: MediaStream
    try {
      stream = await this.scanner().open()
    } catch (error) {
      this.cameraFailure = cameraProblem(error)
      return
    }

    // The dialog can be closed while `open()` is still in flight — it is a permission prompt,
    // so "still in flight" can mean several seconds of someone reading a dialog and pressing
    // Cancel. Without this the camera is opened *after* the user has left, and stays open.
    if (!this.open) {
      this.scanner().close(stream)
      return
    }

    this.stream = stream
    this.scanning = true
    await this.updateComplete

    const video = this.querySelector('video')
    if (video !== null) {
      video.srcObject = stream
      // `muted` and `playsinline` are set as properties as well as attributes: iOS refuses to
      // play an unmuted video inline and takes it fullscreen instead, which turns a preview
      // into a video player over the top of the form.
      video.muted = true
      // Started, not awaited. `play()` settles when the stream produces its first frame, and
      // a camera that has been opened but is not yet delivering frames would hold this line —
      // and with it the read loop below, which is what would actually notice. A rejection is
      // not worth a message either: it means the dialog closed between these two lines, and
      // the teardown covers that.
      void video.play().catch(() => {})
    }

    void this.loop()
  }

  /**
   * Reads frames until there is a code, or until the dialog closes.
   *
   * A loop rather than `setInterval`, and that is not a style preference. An interval needs a
   * handle to cancel, and a handle is a thing that can be leaked — while the loop still
   * *appears* to stop, because two other conditions (`scanning`, and the `<video>` being
   * unmounted) each independently prevent a read. Three mechanisms means none of them is
   * load-bearing and none of them can be tested: a mutation removing the `clearInterval`
   * survived the whole suite, which is exactly what an untested mechanism looks like.
   *
   * `scanning` is now the only thing that stops this, so a test that watches reads stop is a
   * test of the thing that actually stops them. It is also serial by construction, so a slow
   * decode delays the next frame instead of queueing up behind itself.
   */
  private async loop(): Promise<void> {
    while (this.scanning) {
      await this.readFrame()
      await pause(FRAME_INTERVAL)
    }
  }

  private async readFrame(): Promise<void> {
    const video = this.querySelector('video')
    if (video === null) return

    try {
      const codes = await this.scanner().read(video)
      // After the await, not before: this guards a decode still in flight when the dialog
      // closed, which would otherwise report a code into a dialog the user has left — and on
      // this form, that field is the setup code.
      if (!this.scanning) return
      for (const code of codes) {
        // Every code in the frame, not the first: a device's box often carries two, and
        // giving up because the barcode nearest the middle was a URL would make scanning fail
        // in exactly the case it is most needed.
        if (this.accept(code)) return
      }
    } catch {
      // A frame that could not be decoded is not an error. It is what most frames are.
    }
  }

  /**
   * Reads one code, and reports it if it is a setup code.
   *
   * @returns whether this was the code we were waiting for
   */
  private accept(code: string): boolean {
    try {
      readCredential(code)
    } catch (error) {
      if (!(error instanceof PayloadError)) throw error
      // Kept, and scanning continues. Someone holding a phone up to a device has not asked to
      // stop, and the wrong code is usually the other sticker on the same box.
      this.codeFailure = error.message
      return false
    }

    this.codeFailure = undefined
    this.stop()
    this.open = false
    // The credential itself, unvalidated-by-anyone-else, straight to the field. `readCredential`
    // ran above only to decide whether this *is* one; the form runs it again for real when it
    // saves, so there is one place that turns text into a device rather than two.
    this.dispatchEvent(
      new CustomEvent('scan', { detail: { credential: code }, bubbles: true, composed: true }),
    )
    return true
  }

  /**
   * Stops reading and releases the camera. Safe to call when nothing is running.
   *
   * Clearing `scanning` is what ends {@link loop}; there is no timer to cancel.
   */
  private stop(): void {
    const video = this.querySelector('video')
    if (video !== null) video.srcObject = null
    if (this.stream !== undefined) {
      this.scanner().close(this.stream)
      this.stream = undefined
    }
    this.scanning = false
  }

  /** What each refusal means to the person holding the phone, and what they can do about it. */
  private cameraMessage(problem: CameraProblem): string {
    switch (problem) {
      case 'denied':
        // Deliberately does not assert that a camera exists. The specification downgrades
        // "no camera" to "permission denied" before permission has ever been granted, so this
        // sentence has to stay true for someone who has no camera at all.
        return msg(
          'This page has no permission to use a camera. Allow camera access for this site in your browser, or type the code instead.',
        )
      case 'no-camera':
        return msg('There is no camera this page can use. Type the code instead.')
      case 'in-use':
        return msg(
          'The camera is being used by another application. Close it and try again, or type the code instead.',
        )
      case 'unknown':
        return msg('The camera could not be started. Type the code instead.')
    }
  }

  private renderProblems(): TemplateResult | '' {
    if (this.cameraFailure !== undefined) {
      return html`
        <wa-callout variant="warning" data-camera-problem>
          <wa-icon slot="icon" name="camera-slash"></wa-icon>
          ${this.cameraMessage(this.cameraFailure)}
        </wa-callout>
      `
    }

    if (this.codeFailure !== undefined) {
      return html`
        <wa-callout variant="neutral" data-scan-problem>
          <wa-icon slot="icon" name="circle-info"></wa-icon>
          <!-- The sentence from core, whole. It knows what it was looking at; this does not. -->
          ${this.codeFailure}
          <div>${msg('Still looking — hold the QR code from the device in view.')}</div>
        </wa-callout>
      `
    }

    return ''
  }

  override render() {
    return html`
      <wa-dialog
        data-scan-dialog
        label=${msg('Scan the code on the device')}
        ?open=${this.open}
        @wa-after-hide=${() => {
          this.open = false
        }}
      >
        <div class="wa-stack wa-gap-m">
          <!-- Always in the tree, hidden when there is nothing to show. Rendering it only
               while scanning would make its absence a *second* thing that stops the read
               loop, and two mechanisms for stopping means neither is load-bearing: a loop
               that never terminated would then pass every test. Keeping it mounted also
               removes a race between start() and the render that gives it its element.
               No backticks in here: this is inside a template literal, where one ends it. -->
          <video
            class="app-scan-preview"
            ?hidden=${!this.scanning}
            playsinline
            muted
            autoplay
          ></video>
          ${this.renderProblems()}
        </div>

        <wa-button
          slot="footer"
          data-type-instead
          appearance="plain"
          @click=${() => {
            this.open = false
          }}
        >
          ${msg('Type the code instead')}
        </wa-button>
      </wa-dialog>
    `
  }
}

customElements.define('scan-dialog', ScanDialog)
