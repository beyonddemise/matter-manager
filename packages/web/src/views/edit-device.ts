import { msg } from '@lit/localize'
import {
  type DeviceDocument,
  DraftError,
  documentId,
  planDeviceEdit,
  type RoomDocument,
  uuidOf,
} from '@matter-manager/core'
import { html, type PropertyValues } from 'lit'
import { DeviceFormView } from './device-form.js'

/**
 * The edit form: everything about a device except the code that identifies it.
 *
 * The setup code is deliberately absent. `payload`, `vendorId`, `productId` and
 * `discriminator` are derived from it, so a form that changed one without re-deriving the rest
 * would produce a record whose parts disagree — and a QR built from a payload that no longer
 * matches its device encodes cleanly and silently fails to commission. A code captured from
 * the wrong label is fixed by deleting the record and adding it again.
 *
 * Changing the room here is what "move a device" means; there is no separate action, because
 * a device's room is one of its fields and moving it is editing that field.
 */
export class EditDeviceView extends DeviceFormView {
  static override properties = {
    uuid: { attribute: 'uuid' },
    device: { state: true },
    loaded: { state: true },
  }

  /** The uuid from the route — `#/devices/<uuid>/edit`. See `views/device.ts` on the spelling. */
  declare uuid: string
  declare device: DeviceDocument | undefined
  declare loaded: boolean

  constructor() {
    super()
    this.uuid = ''
    this.loaded = false
  }

  /**
   * Reloads whenever the route changes, not only on the first render.
   *
   * The shell reuses one element per view and updates its `uuid`, so loading in `firstUpdated`
   * alone would leave this form editing the device the user navigated *away* from — and here
   * that does not merely display the wrong thing, it **writes** it. Same guard as
   * `views/device.ts`, for a worse reason.
   */
  protected override willUpdate(changed: PropertyValues<this>): void {
    if (!changed.has('uuid')) return
    this.device = undefined
    this.loaded = false
    this.error = undefined
    this.createdRoom = ''
    void this.load()
  }

  /**
   * Which read is the current one; two navigations in quick succession put two in flight and
   * the disk decides which lands first. See `views/device.ts`.
   */
  private request = 0

  private documentId(): string | undefined {
    try {
      return documentId('device', this.uuid)
    } catch {
      return undefined
    }
  }

  private async load(): Promise<void> {
    const token = ++this.request
    const id = this.documentId()
    const [device, rooms] = await Promise.all([
      id === undefined ? undefined : this.repos().devices.get(id),
      this.repos().rooms.list(),
    ])
    if (token !== this.request) return

    this.device = device
    this.rooms = rooms
    this.loaded = true
    if (device !== undefined) await this.fill(device, rooms)
  }

  /**
   * Writes the stored values into the controls, once.
   *
   * Only from {@link load}, and deliberately not from `updated`: re-filling after a failed save
   * would throw away everything the user had just typed, which is the one thing a validation
   * error must not do.
   */
  private async fill(device: DeviceDocument, rooms: readonly RoomDocument[]): Promise<void> {
    await this.updateComplete
    this.setControlValue('[data-field="name"]', device.name)
    this.setControlValue('[data-field="spot"]', device.spot ?? '')
    this.setControlValue('[data-field="serial"]', device.serial ?? '')
    this.setControlValue('[data-field="installed-at"]', device.installedAt)

    // An empty path means the device's room no longer exists — deleted on another replica.
    // The field is then left blank and the save cannot succeed until a room is chosen, which
    // is the honest outcome: the reference is already dangling and this is where it gets fixed.
    const path = rooms.find((room) => room._id === device.roomId)?.path ?? ''
    await this.selectRoom(path)
  }

  private async onSubmit(event: Event): Promise<void> {
    event.preventDefault()
    const device = this.device
    if (this.saving || device === undefined) return
    this.saving = true

    try {
      // Re-read for the same reason the add form does: a room another tab created since this
      // form opened must be matched rather than duplicated.
      const rooms = await this.repos().rooms.list()
      this.rooms = rooms

      let update: ReturnType<typeof planDeviceEdit>
      try {
        update = planDeviceEdit(device, this.fields(), rooms, () => crypto.randomUUID())
      } catch (problem) {
        if (problem instanceof DraftError) {
          this.error = problem
          return
        }
        // A bug rather than a statement about the form; see `add-device.ts`.
        throw problem
      }

      this.error = undefined

      if (!(await this.write(update))) {
        // A rejected write here is most often a conflict: another tab or another replica has
        // moved the document on, so the `_rev` in hand is stale and every retry fails exactly
        // the same way. Re-reading makes the next attempt plan against what is actually
        // stored, and touches nothing the user typed - `fill` runs only from `load`.
        const fresh = await this.repos().devices.get(device._id)
        if (fresh !== undefined) this.device = fresh
        return
      }
    } finally {
      this.saving = false
    }

    window.location.hash = `#/devices/${uuidOf(device._id) ?? ''}`
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
      <form class="wa-stack wa-gap-l app-form" @submit=${this.onSubmit} novalidate>
        <h1>${msg('Edit device')}</h1>

        ${this.renderError()}

        <!-- The setup code is shown, not offered for editing: it is what identifies this
             physical device, and every field derived from it would have to be re-derived
             together or the QR stops commissioning. -->
        <div class="wa-stack wa-gap-2xs">
          <small class="app-empty">${msg('Pairing code')}</small>
          <code class="app-pairing-code" data-manual-code>${device.manualCode}</code>
          <small class="app-empty">
            ${msg('The setup code cannot be changed. If it is wrong, delete this device and add it again.')}
          </small>
        </div>

        ${this.renderFields()}

        <div class="wa-cluster wa-gap-s">
          <wa-button type="submit" variant="brand" ?disabled=${this.saving}>
            ${msg('Save changes')}
          </wa-button>
          <wa-button href="#/devices/${uuidOf(device._id) ?? ''}" appearance="plain">
            ${msg('Cancel')}
          </wa-button>
        </div>
      </form>
    `
  }
}

customElements.define('edit-device-view', EditDeviceView)
