import { msg, updateWhenLocaleChanges } from '@lit/localize'
import { type DeviceDocument, documentId, type RoomDocument } from '@matter-manager/core'
import type { ProjectRepositories } from '@matter-manager/data'
import { html, LitElement, type TemplateResult } from 'lit'
import { projectDatabase } from '../db/project-database.js'

/**
 * The size of the inline QR, in CSS pixels.
 *
 * Big enough to scan off a laptop screen from arm's length; the dialog exists for the times it
 * is not. A number rather than a token because `<wa-qr-code>` takes a pixel count, not CSS.
 */
const QR_SIZE = 220
/** The enlarged QR at its biggest. Scannable across a room, from a phone held by someone else. */
const QR_SIZE_LARGE = 420

/**
 * Room to leave around the enlarged QR: the dialog's own margins and padding, plus the plate's.
 *
 * Needed because `<wa-qr-code>` writes `min-width: <size>px` onto its canvas inline, so a code
 * too big for its container is **clipped rather than scaled** — and a QR missing its right-hand
 * columns does not scan. No CSS on our side can override that from outside the shadow root, so
 * the size has to be right when it is set.
 *
 * Measured at 360px and at desktop width rather than derived: the dialog's chrome comes from
 * the theme, and a formula pretending to know it exactly would be a guess wearing arithmetic.
 */
const DIALOG_ALLOWANCE = 128

/** Below this the code is too dense to scan off a screen at all; better to overflow than lie. */
const QR_SIZE_MIN = 180

/**
 * The enlarged QR's size for this viewport.
 *
 * Read at the moment the dialog opens. It does not follow a resize while open, which is the
 * one case this leaves: rotating a phone with the dialog up gives a code smaller than it could
 * be, never one that is clipped, so the failure is cosmetic rather than unscannable.
 */
function enlargedSize(): number {
  const available = window.innerWidth - DIALOG_ALLOWANCE
  return Math.max(QR_SIZE_MIN, Math.min(QR_SIZE_LARGE, available))
}

/**
 * One device: everything recorded about it, and the code that puts it back into service.
 *
 * The QR is the reason this page exists. Everything else here is convenience; if the
 * reproduced code does not scan, the product has no reason to exist. So the colours are pinned
 * rather than themed (see {@link renderQr}) and a browser test decodes the rendered canvas back
 * to the fields it came from, rather than trusting that a string went in one end.
 */
export class DeviceView extends LitElement {
  /** Light DOM, so Web Awesome's global utility classes reach this markup. */
  protected override createRenderRoot(): HTMLElement {
    return this
  }

  static override properties = {
    uuid: { attribute: 'uuid' },
    repositories: { attribute: false },
    device: { state: true },
    room: { state: true },
    loaded: { state: true },
    enlarged: { state: true },
  }

  /**
   * The uuid from the route — `#/devices/<uuid>`, not `#/devices/device:<uuid>`.
   *
   * The document id carries its type prefix so that `_all_docs` can range over it (M2-4); a
   * URL does not need to, and `#/devices/device:3fa85f64-…` reads like a mistake. `core` owns
   * both halves of the translation, so the two spellings cannot drift.
   */
  declare uuid: string
  /** Bound by a test to a database of its own; resolved to the real one otherwise. */
  declare repositories?: ProjectRepositories
  declare device: DeviceDocument | undefined
  declare room: RoomDocument | undefined
  declare loaded: boolean
  declare enlarged: boolean

  constructor() {
    super()
    updateWhenLocaleChanges(this)
    this.uuid = ''
    this.loaded = false
    this.enlarged = false
  }

  protected override firstUpdated(): void {
    void this.load()
  }

  private resolved: ProjectRepositories | undefined
  private repos(): ProjectRepositories {
    this.resolved ??= this.repositories ?? projectDatabase()
    return this.resolved
  }

  /**
   * The document id for the uuid in the route, or `undefined` when the route cannot name one.
   *
   * `documentId` refuses an empty uuid or one containing the separator, which is a hand-edited
   * or truncated URL rather than a fault. "No such device" is the honest answer to that, and
   * an exception here would take the whole page down instead of showing it.
   */
  private documentId(): string | undefined {
    try {
      return documentId('device', this.uuid)
    } catch {
      return undefined
    }
  }

  private async load(): Promise<void> {
    const id = this.documentId()
    const device = id === undefined ? undefined : await this.repos().devices.get(id)
    // Only when there is a device, and only its own room: reading every room to show one
    // path would grow with the project for no gain.
    this.room = device === undefined ? undefined : await this.repos().rooms.get(device.roomId)
    this.device = device
    this.loaded = true
  }

  /**
   * The QR, with its colours pinned rather than themed.
   *
   * `<wa-qr-code>` takes the fill from `currentColor` and leaves the canvas transparent, so in
   * dark mode it would render light modules over a dark page. Many scanners will not read an
   * inverted code at all, and the ones that do are the exception rather than the rule — so a
   * themed QR is a QR that works in one colour scheme and silently fails in the other.
   *
   * `black` and `white` rather than tokens, deliberately, and this is the one place in the
   * application where a colour does not come from `--wa-*`. The component takes a CSS colour
   * string and cannot resolve a custom property, and more importantly this is not decoration:
   * maximum contrast is what makes the thing scan. The white plate around it is the quiet zone
   * every QR needs to be found at all.
   *
   * `error-correction="H"` is set explicitly even though it is currently the component's
   * default. These codes end up on labels inside fuse boxes and behind panels; H recovers from
   * roughly 30% damage against about 7% at L, and a 19-character payload stays small even so.
   * Written down means a change to the component's default cannot quietly downgrade it.
   */
  private renderQr(size: number, payload: string): TemplateResult {
    return html`
      <div class="app-qr-plate">
        <wa-qr-code
          value=${payload}
          size=${size}
          error-correction="H"
          fill="black"
          background="white"
          label=${msg('QR code for commissioning this device')}
        ></wa-qr-code>
      </div>
    `
  }

  /**
   * The setup code, in whichever forms were captured.
   *
   * A device filed from a typed manual code has no payload, and none can be invented: a manual
   * code carries only the top four bits of the discriminator, so a reconstructed payload would
   * encode cleanly and produce a QR that silently fails to commission. Saying so is the honest
   * rendering, and it is also actionable — the manual code below it still commissions the
   * device, which is what a manual code is for.
   */
  private renderCode(device: DeviceDocument): TemplateResult {
    return html`
      <div class="wa-flank wa-gap-l app-code">
        ${
          device.payload === undefined
            ? html`
                <wa-callout variant="neutral" data-no-payload>
                  <wa-icon slot="icon" name="circle-info"></wa-icon>
                  ${msg(
                    'This device was filed from a pairing code, so there is no QR code to show. The pairing code below commissions it just the same.',
                  )}
                </wa-callout>
              `
            : html`
                <div class="wa-stack wa-gap-s wa-align-items-center">
                  ${this.renderQr(QR_SIZE, device.payload)}
                  <wa-button
                    data-enlarge
                    appearance="outlined"
                    @click=${() => {
                      this.enlarged = true
                    }}
                  >
                    <wa-icon slot="start" name="expand"></wa-icon>
                    ${msg('Enlarge')}
                  </wa-button>
                </div>
              `
        }

        <div class="wa-stack wa-gap-2xs">
          <strong>${msg('Pairing code')}</strong>
          <div class="wa-cluster wa-gap-s">
            <!-- Digits exactly as stored, ungrouped. Printed labels group them differently
                 depending on the manufacturer, and inventing a grouping here would teach a
                 reader a format that does not match the sticker in their hand. -->
            <code class="app-pairing-code" data-manual-code>${device.manualCode}</code>
            <wa-copy-button
              value=${device.manualCode}
              copy-label=${msg('Copy the pairing code')}
            ></wa-copy-button>
          </div>
        </div>
      </div>
    `
  }

  /** One labelled fact, or nothing when there is no fact to state. */
  private field(label: string, value: string | undefined): TemplateResult | '' {
    if (value === undefined || value === '') return ''
    return html`
      <div class="wa-stack wa-gap-3xs">
        <small class="app-empty">${label}</small>
        <span>${value}</span>
      </div>
    `
  }

  /** A vendor or product id, as the four hex digits every Matter document writes them in. */
  private hex(value: number | undefined): string | undefined {
    return value === undefined
      ? undefined
      : `0x${value.toString(16).toUpperCase().padStart(4, '0')}`
  }

  private renderDetails(device: DeviceDocument): TemplateResult {
    return html`
      <div class="wa-grid app-details">
        ${this.field(msg('Room'), this.room?.path ?? msg('Without a room'))}
        ${this.field(msg('Spot'), device.spot)}
        ${this.field(msg('Vendor'), device.vendorName ?? this.hex(device.vendorId))}
        ${this.field(msg('Product'), device.productName ?? this.hex(device.productId))}
        ${this.field(msg('Serial number'), device.serial)}
        ${this.field(msg('Installed'), device.installedAt)}
      </div>
    `
  }

  override render() {
    if (!this.loaded) return html`<div class="wa-stack wa-gap-l"></div>`

    const device = this.device
    if (device === undefined) {
      return html`
        <div class="wa-stack wa-gap-l">
          <h1>${msg('Device not found')}</h1>
          <p class="app-empty">
            ${msg('There is no device with that address in this catalogue.')}
          </p>
          <a class="app-back" href="#/">${msg('Back to devices')}</a>
        </div>
      `
    }

    return html`
      <div class="wa-stack wa-gap-l">
        <div class="wa-cluster wa-gap-s">
          <h1>${device.name}</h1>
          ${device.disabled ? html`<wa-tag variant="neutral">${msg('Disabled')}</wa-tag>` : ''}
        </div>

        ${this.renderCode(device)} ${this.renderDetails(device)}

        <a class="app-back" href="#/">${msg('Back to devices')}</a>

        <wa-dialog
          data-enlarged
          label=${device.name}
          ?open=${this.enlarged}
          @wa-after-hide=${() => {
            this.enlarged = false
          }}
        >
          ${
            this.enlarged && device.payload !== undefined
              ? this.renderQr(enlargedSize(), device.payload)
              : ''
          }
        </wa-dialog>
      </div>
    `
  }
}

customElements.define('device-view', DeviceView)
