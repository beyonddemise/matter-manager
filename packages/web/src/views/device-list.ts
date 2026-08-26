import { msg, str, updateWhenLocaleChanges } from '@lit/localize'
import {
  browseDevices,
  type DeviceDocument,
  type DeviceGroup,
  type RoomDocument,
} from '@matter-manager/core'
import type { ProjectRepositories } from '@matter-manager/data'
import { html, LitElement } from 'lit'
import { projectDatabase } from '../db/project-database.js'
import { getLocale } from '../i18n/localization.js'

/**
 * The device list: rooms, in order, with what is in them.
 *
 * Every decision about *which* devices and *in what order* is `browseDevices` in `core` — a
 * pure function over plain data, so "search matches the room path" is a millisecond-long test
 * with no DOM. What is left here is genuinely a rendering job, plus the one thing `core`
 * cannot know: the locale to order names in.
 *
 * M2-8 adds editing, moving and disabling from here; the shell does not change when it does.
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
    query: { state: true },
    includeDisabled: { state: true },
  }

  /** Bound by a test to a database of its own; resolved to the real one otherwise. */
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
  declare query: string
  declare includeDisabled: boolean

  constructor() {
    super()
    // Subscribes this component to locale changes; without it the view keeps rendering the
    // strings that were active when it first rendered.
    updateWhenLocaleChanges(this)
    this.devices = []
    this.rooms = []
    this.loaded = false
    this.query = ''
    this.includeDisabled = false
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

  /**
   * What to show, decided in `core`.
   *
   * The collator is the one thing `core` cannot supply: ordering is locale-dependent, and that
   * package holds no ambient locale on purpose. This view already knows which locale it is
   * rendering in, so it passes one — which is what puts `Ärmelleuchte` before `Zuluft` in
   * German rather than after it.
   */
  private groups(): readonly DeviceGroup[] {
    return browseDevices(this.devices, this.rooms, {
      query: this.query,
      includeDisabled: this.includeDisabled,
      compare: new Intl.Collator(getLocale()).compare,
    })
  }

  private onSearch(event: Event): void {
    const value = (event.target as { value?: unknown }).value
    this.query = typeof value === 'string' ? value : ''
  }

  private onToggleDisabled(event: Event): void {
    this.includeDisabled = (event.target as { checked?: unknown }).checked === true
  }

  /** The heading for a group, including the group with no room. */
  private groupLabel(group: DeviceGroup): string {
    // An empty path means the room is gone but its devices are not. Naming it rather than
    // leaving a blank heading is what stops those devices looking like a rendering fault.
    return group.path === '' ? msg('Without a room') : group.path
  }

  private renderDevice(device: DeviceDocument) {
    return html`
      <li
        class="wa-split app-device"
        data-device-id=${device._id}
        ?data-disabled=${device.disabled}
      >
        <span class="wa-stack wa-gap-3xs">
          <span>${device.name}</span>
          ${device.spot === undefined ? '' : html`<small class="app-empty">${device.spot}</small>`}
        </span>
        ${device.disabled ? html`<wa-tag variant="neutral">${msg('Disabled')}</wa-tag>` : ''}
      </li>
    `
  }

  private renderGroup(group: DeviceGroup) {
    const count = group.devices.length
    return html`
      <section class="wa-stack wa-gap-2xs" data-room=${group.path}>
        <div class="wa-cluster wa-gap-s app-room-heading">
          <h2>${this.groupLabel(group)}</h2>
          <wa-badge variant="neutral">${count}</wa-badge>
        </div>
        <ul class="wa-stack wa-gap-2xs app-device-list">
          ${group.devices.map((device) => this.renderDevice(device))}
        </ul>
      </section>
    `
  }

  /**
   * What to say when there is nothing to show.
   *
   * "No devices yet" and "nothing matched your search" are different facts, and telling a user
   * with a full catalogue that it is empty because they mistyped a word is the kind of small
   * lie that makes people distrust an application.
   */
  private renderEmpty() {
    if (this.devices.length === 0) return html`<p class="app-empty">${msg('No devices yet.')}</p>`
    const query = this.query.trim()
    return html`<p class="app-empty">${msg(str`Nothing matches “${query}”.`)}</p>`
  }

  override render() {
    const groups = this.groups()

    return html`
      <div class="wa-stack wa-gap-l">
        <div class="wa-split">
          <h1>${msg('Devices')}</h1>
          <wa-button href="#/devices/new" variant="brand">
            <wa-icon slot="start" name="plus"></wa-icon>
            ${msg('Add a device')}
          </wa-button>
        </div>

        <div class="wa-stack wa-gap-s">
          <wa-input
            data-search
            type="search"
            with-clear
            label=${msg('Search')}
            placeholder=${msg('Name, room, serial or product')}
            .value=${this.query}
            @input=${this.onSearch}
          ></wa-input>
          <wa-checkbox data-include-disabled @change=${this.onToggleDisabled}>
            ${msg('Show disabled devices')}
          </wa-checkbox>
        </div>

        ${
          this.loaded && groups.length === 0
            ? this.renderEmpty()
            : html`<div class="wa-stack wa-gap-l">
                ${groups.map((group) => this.renderGroup(group))}
              </div>`
        }
      </div>
    `
  }
}

customElements.define('device-list-view', DeviceListView)
