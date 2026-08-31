import { msg, str, updateWhenLocaleChanges } from '@lit/localize'
import {
  addRemark,
  type DeviceDocument,
  DraftError,
  documentId,
  type Remark,
  type RoomDocument,
  remarksNewestFirst,
  setDeviceDisabled,
  uuidOf,
} from '@matter-manager/core'
import type { ProjectRepositories } from '@matter-manager/data'
import { html, LitElement, type PropertyValues, type TemplateResult } from 'lit'
import { PROJECT_CHANGED } from '../current-project.js'
import { projectDatabase, projectIsEditable } from '../db/project-database.js'
import { currentAuthor } from '../identity.js'
import { fieldValue } from './device-form.js'

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

/**
 * The enlarged QR's size for this viewport: as big as it can be without exceeding the space.
 *
 * There is deliberately **no lower bound**. An earlier version had one, on the reasoning that
 * below some size the code is too dense to scan and overflowing was the lesser evil. That was
 * simply wrong, and it inverted the trade-off it was trying to make: a floor above `available`
 * is a code wider than its container, which `<wa-qr-code>` clips rather than scales, and a
 * clipped QR does not scan at all — whereas a small complete one usually still does. The floor
 * only ever fired in the case where it did the most damage.
 *
 * `Math.max(1, …)` is not a floor in that sense; it keeps the size attribute a positive number
 * on a viewport narrower than the dialog chrome itself, where no code can be shown either way.
 *
 * Read at the moment the dialog opens. It does not follow a resize while open, which leaves one
 * case: rotating a phone with the dialog up gives a code smaller than it could be, never one
 * that is clipped, so the failure there is cosmetic rather than unscannable.
 */
function enlargedSize(): number {
  const available = window.innerWidth - DIALOG_ALLOWANCE
  return Math.max(1, Math.min(QR_SIZE_LARGE, available))
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
    failed: { state: true },
    enlarged: { state: true },
    confirmingDelete: { state: true },
    busy: { state: true },
    failure: { state: true },
    remarkError: { state: true },
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
  /**
   * The device could not be read.
   *
   * Distinct from `loaded === true, device === undefined`, which is *there is no device with
   * that address* — and saying that when the read failed would tell somebody their device is
   * gone. It is not gone; this browser could not open its own database.
   */
  declare failed: boolean
  declare enlarged: boolean
  declare confirmingDelete: boolean
  /** A write is in flight. Guards the actions against a second click landing on a stale `_rev`. */
  declare busy: boolean
  /**
   * Which action storage refused, if any.
   *
   * Two values rather than a boolean, because the two failures need different sentences in
   * different places: a refused disable belongs beside the buttons, a refused delete belongs
   * inside the dialog that is still open asking for it.
   */
  declare failure: 'toggle' | 'delete' | undefined
  /**
   * Why the last remark was not recorded, if it was not.
   *
   * Separate from {@link failure} because the remedies are different and so is the place the
   * sentence belongs: a blank remark is fixed by typing something, a refused write by trying
   * again, and both belong beside the composer rather than beside the disable button.
   */
  declare remarkError: 'blank' | 'storage' | undefined

  constructor() {
    super()
    updateWhenLocaleChanges(this)
    this.uuid = ''
    this.loaded = false
    this.failed = false
    this.enlarged = false
    this.confirmingDelete = false
    this.busy = false
    this.failure = undefined
    this.remarkError = undefined
  }

  /**
   * Reloads whenever the route changes, not only on the first render.
   *
   * The shell renders one `<device-view>` and updates its `uuid`; Lit reuses the element rather
   * than building a new one, so `firstUpdated` alone would leave the page showing the device
   * the user navigated *away* from — with a QR that belongs to a different device and nothing
   * on screen looking wrong. `willUpdate` rather than `updated` so the stale device is cleared
   * before it is rendered again.
   */
  protected override willUpdate(changed: PropertyValues<this>): void {
    if (!changed.has('uuid')) return
    this.device = undefined
    this.room = undefined
    this.loaded = false
    this.failed = false
    // An enlargement of the previous device's code has no business staying open over the new
    // one, and closing it is what makes the dialog's contents and its title agree. The same
    // goes for a delete confirmation: an open one would now be pointing at a different device.
    this.enlarged = false
    this.confirmingDelete = false
    this.busy = false
    this.failure = undefined
    this.remarkError = undefined
    // The composer is deliberately *not* cleared here, and that is worth stating because the
    // obvious defensive call belongs nowhere else either: `willUpdate` runs before the render,
    // so it would clear the control that is about to be discarded. Clearing `loaded` unmounts
    // the composer along with the rest of the page, and the device navigated to renders a new
    // one — empty. A browser test holds that end of it, so a future render that keeps the
    // composer mounted across a route change fails rather than silently carrying half a
    // sentence about the kitchen light onto the hall sensor.
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

  /**
   * Which read is the current one.
   *
   * Two navigations in quick succession issue two reads, and the disk decides which finishes
   * first. Without this, an earlier read landing last would settle the page on the device the
   * user has already left - the same wrong-device bug as above, arriving by a different route
   * and just as invisible.
   */
  private request = 0

  /**
   * Re-reads everything when the reader moves to another project (#55).
   *
   * The repositories are resolved once and held, because re-resolving on every render would
   * open a second handle on the same database and fire every change feed twice. So a switch has
   * to say so, and this is where that is heard.
   */
  private onProjectChanged = (): void => {
    this.resolved = undefined
    // **Everything the old project put here goes first.** The route's uuid does not change on a
    // switch, so nothing else clears `device` — and a delete confirmation opened under project
    // A would still be holding project A's document when it fired against project B's
    // repository. Two projects can hold the same `_id` and `_rev`, which is how that becomes a
    // deletion in the wrong building rather than a harmless 404. Found by review.
    this.device = undefined
    this.confirmingDelete = false
    this.remarkError = undefined
    void this.load()
  }

  override connectedCallback(): void {
    super.connectedCallback()
    window.addEventListener(PROJECT_CHANGED, this.onProjectChanged)
  }

  override disconnectedCallback(): void {
    window.removeEventListener(PROJECT_CHANGED, this.onProjectChanged)
    super.disconnectedCallback()
  }

  private async load(): Promise<void> {
    const token = ++this.request
    const id = this.documentId()

    try {
      const device = id === undefined ? undefined : await this.repos().devices.get(id)
      // Only when there is a device, and only its own room: reading every room to show one
      // path would grow with the project for no gain.
      const room = device === undefined ? undefined : await this.repos().rooms.get(device.roomId)

      if (token !== this.request) return

      this.room = room
      this.device = device
      this.loaded = true
    } catch {
      // Guarded by the same token as the success path: a failed read for a device the user has
      // already navigated away from must not put an error on the page they are looking at now.
      if (token !== this.request) return
      // Not logged: a device document carries a setup code.
      this.failed = true
    }
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

  /**
   * Takes the device out of service, or puts it back.
   *
   * The write returns the stored document, `_rev` included, and that is what replaces the one
   * in hand: keeping the stale copy would make the *next* action a conflict, which shows up as
   * a save that fails for no reason the user did anything to cause.
   *
   * Guarded by the same {@link request} token as {@link load}, because a write outliving its
   * route is the same wrong-device failure as a stale read arriving through the other door.
   * Press Disable on one device, navigate to another before the write settles, and an
   * unguarded assignment puts the first device's name, QR and pairing code on the second
   * device's page — which is one device's setup code shown under another device's title.
   *
   * The action itself is never abandoned. Only its *result* is dropped; the device is still
   * disabled, and the page the user has moved to is left alone.
   */
  private async onToggleDisabled(): Promise<void> {
    const device = this.device
    if (device === undefined || this.busy) return
    this.busy = true
    const token = this.request
    try {
      const saved = await this.repos().devices.save(
        setDeviceDisabled(device, !device.disabled, () => new Date().toISOString()),
      )
      if (token !== this.request) return
      this.device = saved
      this.failure = undefined
    } catch {
      // Reported rather than rethrown: an unhandled rejection out of a click handler leaves
      // the button un-busied and the screen unchanged, which is indistinguishable from a
      // button that does nothing. Not logged - the document carries the setup passcode.
      if (token === this.request) this.failure = 'toggle'
    } finally {
      // `busy` belongs to whichever route owns the page now. `willUpdate` already cleared it
      // on navigation, and a later device may have set it again for a write of its own -
      // clearing it unconditionally here would unlock that one's guard from under it.
      if (token === this.request) this.busy = false
    }
  }

  /**
   * Deletes the device, and then leaves — the page it was showing no longer exists.
   *
   * Reached only from the confirmation dialog. The warning there names the irreversible part
   * rather than asking "are you sure": a device can be bought again, and its setup code cannot.
   */
  private async onDelete(): Promise<void> {
    const device = this.device
    if (device === undefined || this.busy) return
    this.busy = true
    const token = this.request
    try {
      await this.repos().devices.remove(device)
    } catch {
      // The dialog stays open, now saying why. Closing it would look like the delete had
      // happened, which for the one irreversible action here is the wrong way to be wrong.
      if (token === this.request) this.failure = 'delete'
      return
    } finally {
      if (token === this.request) this.busy = false
    }

    // Leaving is right for the page that was deleted and wrong for the one the user is on
    // now. A delete that finishes after the route moved on has nothing left to navigate away
    // from, so it navigates nowhere; see {@link onToggleDisabled}.
    if (token !== this.request) return
    this.confirmingDelete = false
    this.failure = undefined
    window.location.hash = '#/'
  }

  /**
   * Edit, disable and delete, where the user already is when they decide.
   *
   * Deliberately not on the device list: a destructive control on every row is a control that
   * gets hit by accident on a phone, which is the device this application is used from.
   */
  private renderActions(device: DeviceDocument): TemplateResult {
    return html`
      <div class="wa-stack wa-gap-s">
        ${
          this.failure === 'toggle'
            ? html`
                <wa-callout variant="danger" data-action-failed>
                  <wa-icon slot="icon" name="triangle-exclamation"></wa-icon>
                  ${msg('Could not save that change. The device is unchanged; try again.')}
                </wa-callout>
              `
            : ''
        }
        <div class="wa-cluster wa-gap-s">
        ${
          // Absent, not disabled. A disabled control says "this is possible and you are doing
          // it wrong"; on a project somebody may only read, neither half is true (#55).
          !projectIsEditable()
            ? ''
            : html`
        <wa-button data-edit href="#/devices/${uuidOf(device._id) ?? ''}/edit" appearance="outlined">
          <wa-icon slot="start" name="pen"></wa-icon>
          ${msg('Edit')}
        </wa-button>

        <wa-button data-toggle-disabled appearance="outlined" ?disabled=${this.busy} @click=${this.onToggleDisabled}>
          <wa-icon slot="start" name=${device.disabled ? 'play' : 'pause'}></wa-icon>
          ${device.disabled ? msg('Put back into service') : msg('Disable')}
        </wa-button>

        <wa-button
          data-delete
          variant="danger"
          appearance="outlined"
          ?disabled=${this.busy}
          @click=${() => {
            this.confirmingDelete = true
          }}
        >
          <wa-icon slot="start" name="trash"></wa-icon>
          ${msg('Delete')}
        </wa-button>
        `
        }
        </div>
      </div>
    `
  }

  /**
   * The delete confirmation.
   *
   * It names what cannot be recovered instead of asking whether the user is sure. "Are you
   * sure?" is a question people learn to click past; "the setup code goes with it" is the one
   * fact that makes someone stop, and it is the reason this application exists.
   */
  private renderDeleteDialog(device: DeviceDocument): TemplateResult {
    return html`
      <wa-dialog
        data-delete-dialog
        label=${msg(str`Delete “${device.name}”?`)}
        ?open=${this.confirmingDelete}
        @wa-after-hide=${() => {
          this.confirmingDelete = false
        }}
      >
        <div class="wa-stack wa-gap-m">
          <wa-callout variant="danger">
            <wa-icon slot="icon" name="triangle-exclamation"></wa-icon>
            ${msg('Deleting a device deletes its commissioning code with it. That code cannot be recovered, and without it the device can only be re-commissioned after a factory reset.')}
          </wa-callout>
          <p>${msg('To take it out of service but keep the code, disable it instead.')}</p>
          ${
            this.failure === 'delete'
              ? html`
                  <wa-callout variant="warning" data-delete-failed>
                    <wa-icon slot="icon" name="circle-exclamation"></wa-icon>
                    ${msg('Could not delete this device. It is still in the catalogue; try again.')}
                  </wa-callout>
                `
              : ''
          }
        </div>

        <wa-button slot="footer" data-dialog="close" appearance="plain">${msg('Cancel')}</wa-button>
        <wa-button
          slot="footer"
          data-confirm-delete
          variant="danger"
          ?disabled=${this.busy}
          @click=${this.onDelete}
        >
          ${msg('Delete permanently')}
        </wa-button>
      </wa-dialog>
    `
  }

  /** Empties the composer. A no-op before the first render, when there is no control yet. */
  private clearComposer(): void {
    const box = this.querySelector('[data-remark-text]') as { value?: string } | null
    if (box !== null) box.value = ''
  }

  /**
   * Records a remark against the device.
   *
   * The text is **read from the control and never written back to it**, which is the same rule
   * the device forms follow (`device-form.ts`) and for the same reason: binding `.value` means
   * Lit rewrites the box on every re-render, so the render that displays "storage refused the
   * write" would also erase what the user typed. For a paragraph written in a basement about
   * what was just done to a device, that is the worst way for this to fail. It is cleared by
   * hand, once, after a write that actually landed.
   *
   * Guarded by the same {@link request} token as every other write here: a remark whose write
   * outlives its route must not be attributed to whatever device the user is now looking at.
   */
  private async onAddRemark(): Promise<void> {
    const device = this.device
    if (device === undefined || this.busy) return

    let updated: ReturnType<typeof addRemark>
    try {
      updated = addRemark(device, fieldValue(this, '[data-remark-text]'), currentAuthor(), {
        uuid: () => crypto.randomUUID(),
        now: () => new Date().toISOString(),
      })
    } catch (error) {
      // The only thing `addRemark` refuses is a remark with nothing in it. Rethrowing anything
      // else keeps a genuine fault visible rather than reporting it as an empty box.
      if (!(error instanceof DraftError)) throw error
      this.remarkError = 'blank'
      return
    }

    this.busy = true
    const token = this.request
    try {
      const saved = await this.repos().devices.save(updated)
      if (token !== this.request) return
      this.device = saved
      this.remarkError = undefined
      this.clearComposer()
    } catch {
      // Not logged: the document carries the setup passcode.
      if (token === this.request) this.remarkError = 'storage'
    } finally {
      if (token === this.request) this.busy = false
    }
  }

  /** One remark: what was said, when, and by whom. */
  private renderRemark(remark: Remark): TemplateResult {
    return html`
      <li class="wa-stack wa-gap-3xs" data-remark>
        <!-- Pre-wrapped rather than collapsed: a remark is often a short list of what was
             done, and running it into one line loses the structure the author put there. -->
        <span class="app-remark-body" data-remark-body>${remark.text}</span>
        <small class="app-empty">
          ${
            remark.authorName === ''
              ? // Written before this project had accounts, so there is no name to show. Said
                // in the reader's language rather than stored in the writer's; see
                // `identity.ts` for why the document holds an empty name instead of "You".
                msg('Recorded on this device')
              : remark.authorName
          }
          · ${remark.createdAt}
        </small>
      </li>
    `
  }

  /**
   * The remark log, and the box that adds to it.
   *
   * Append-only, by design rather than by omission: there is no control here that edits or
   * removes a remark, because the conflict merge unions remarks by id (ADR 0010) and is only
   * sound while an id means one fixed piece of text.
   */
  private renderRemarks(device: DeviceDocument): TemplateResult {
    const remarks = remarksNewestFirst(device.remarks)
    return html`
      <div class="wa-stack wa-gap-s">
        <h2>${msg('Remarks')}</h2>

        ${
          // The remarks themselves are still shown below - reading them is the point of a
          // read-only project. It is writing one that is not on offer.
          !projectIsEditable()
            ? ''
            : html`
        <div class="wa-stack wa-gap-2xs">
          <wa-textarea
            data-remark-text
            label=${msg('Add a remark')}
            hint=${msg('What was done, and anything the next person needs to know. Remarks cannot be edited or deleted afterwards.')}
            rows="3"
          ></wa-textarea>
          ${
            this.remarkError === undefined
              ? ''
              : html`
                  <wa-callout variant="danger" data-remark-failed>
                    <wa-icon slot="icon" name="circle-exclamation"></wa-icon>
                    ${
                      this.remarkError === 'blank'
                        ? msg('There is nothing to record yet. Write the remark first.')
                        : msg(
                            'Could not save that remark. What you wrote is still here; try again.',
                          )
                    }
                  </wa-callout>
                `
          }
          <div class="wa-cluster wa-gap-s">
            <wa-button data-add-remark ?disabled=${this.busy} @click=${this.onAddRemark}>
              <wa-icon slot="start" name="comment-medical"></wa-icon>
              ${msg('Add remark')}
            </wa-button>
          </div>
        </div>
        `
        }

        ${
          remarks.length === 0
            ? html`<p class="app-empty" data-no-remarks>
                ${msg('Nothing has been recorded about this device yet.')}
              </p>`
            : html`<ul class="wa-stack wa-gap-s app-remarks">
                ${remarks.map((remark) => this.renderRemark(remark))}
              </ul>`
        }
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
    if (this.failed) {
      return html`
        <div class="wa-stack wa-gap-l">
          <h1>${msg('This device could not be read')}</h1>
          <p class="app-empty" data-read-failed>
            ${msg('Your devices could not be read from this browser’s storage. Nothing has been lost — reload to try again.')}
          </p>
          <a class="app-back" href="#/">${msg('Back to devices')}</a>
        </div>
      `
    }

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

        ${this.renderCode(device)} ${this.renderActions(device)} ${this.renderDetails(device)}
        ${this.renderRemarks(device)}

        <a class="app-back" href="#/">${msg('Back to devices')}</a>

        ${this.renderDeleteDialog(device)}

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
