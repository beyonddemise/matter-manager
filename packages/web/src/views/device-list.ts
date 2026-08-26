import { msg, updateWhenLocaleChanges } from '@lit/localize'
import type { DeviceDocument, RoomDocument } from '@matter-manager/core'
import type { ProjectRepositories } from '@matter-manager/data'
import { html, LitElement } from 'lit'
import { projectDatabase } from '../db/project-database.js'

/**
 * The device list.
 *
 * Deliberately the smallest thing that makes a save observable: name, room, and nothing else.
 * Without it, "the device is saved" is a claim the application contradicts one screen later.
 * Search, filter, room grouping and ordering are M2-6, and the shell does not change when they
 * arrive.
 */
export class DeviceListView extends LitElement {
  // Light DOM: Web Awesome's utility classes are global CSS and do not cross a shadow
  // boundary. `static styles` is not used for the same reason — Lit only adopts it into
  // shadow roots. App CSS lives in styles/app.css.
  protected override createRenderRoot(): HTMLElement {
    return this
  }

  static override properties = {
    repositories: { attribute: false },
    devices: { state: true },
    rooms: { state: true },
    loaded: { state: true },
  }

  /** Bound by a test to an in-memory pair; resolved to the real database otherwise. */
  declare repositories?: ProjectRepositories
  declare devices: readonly DeviceDocument[]
  declare rooms: readonly RoomDocument[]
  /**
   * Whether the first read has finished.
   *
   * Kept apart from `devices.length === 0`, because those are different facts: one is "you
   * have no devices", the other is "we have not looked yet". Showing the empty message during
   * the read would tell a user with a full catalogue that it is gone.
   */
  declare loaded: boolean

  constructor() {
    super()
    // Subscribes this component to locale changes; without it the view keeps rendering the
    // strings that were active when it first rendered.
    updateWhenLocaleChanges(this)
    this.devices = []
    this.rooms = []
    this.loaded = false
  }

  protected override firstUpdated(): void {
    void this.load()
  }

  /**
   * The repositories to use, resolving the default on first use.
   *
   * Property bindings are committed before the first update, so a bound value is already in
   * place by the time this runs; only the application reaches for the real database. The
   * result is cached in a plain field rather than written back to `repositories`, which is
   * reactive: assigning to it from inside `firstUpdated` schedules a second update for
   * nothing, and Lit says so in dev mode.
   */
  private resolved: ProjectRepositories | undefined
  private repos(): ProjectRepositories {
    this.resolved ??= this.repositories ?? projectDatabase()
    return this.resolved
  }

  private async load(): Promise<void> {
    const repositories = this.repos()
    const [devices, rooms] = await Promise.all([
      repositories.devices.list(),
      repositories.rooms.list(),
    ])
    this.devices = devices
    this.rooms = rooms
    this.loaded = true
  }

  /** A device's room path, or nothing when the room is missing — never an id on screen. */
  private roomPath(device: DeviceDocument): string {
    return this.rooms.find((room) => room._id === device.roomId)?.path ?? ''
  }

  override render() {
    return html`
      <div class="wa-stack wa-gap-l">
        <div class="wa-split">
          <h1>${msg('Devices')}</h1>
          <wa-button href="#/devices/new" variant="brand">
            <wa-icon slot="start" name="plus"></wa-icon>
            ${msg('Add a device')}
          </wa-button>
        </div>

        ${
          this.loaded && this.devices.length === 0
            ? html`<p class="app-empty">${msg('No devices yet.')}</p>`
            : html`
                <ul class="wa-stack wa-gap-2xs app-device-list" data-device-list>
                  ${this.devices.map(
                    (device) => html`
                      <li class="wa-split app-device" data-device-id=${device._id}>
                        <span>${device.name}</span>
                        <span class="app-empty">${this.roomPath(device)}</span>
                      </li>
                    `,
                  )}
                </ul>
              `
        }
      </div>
    `
  }
}

customElements.define('device-list-view', DeviceListView)
