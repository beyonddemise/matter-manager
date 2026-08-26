import { msg, str, updateWhenLocaleChanges } from '@lit/localize'
import {
  browseDevices,
  countSelected,
  type DeviceDocument,
  type DeviceGroup,
  type ExportSelection,
  type RoomDocument,
  selectForExport,
  uuidOf,
} from '@matter-manager/core'
import type { ProjectRepositories } from '@matter-manager/data'
import { html, LitElement } from 'lit'
import { projectDatabase } from '../db/project-database.js'
import { getLocale } from '../i18n/localization.js'
import { inventoryFilename, inventoryLabels, offerDownload } from '../pdf/download.js'
import { buildInventoryPdf, ExportCancelled, type InventoryProgress } from '../pdf/inventory.js'

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
    exporting: { state: true },
    exportProgress: { state: true },
    exportFailed: { state: true },
    selected: { state: true },
    download: { attribute: false },
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
  /** Whether an export is running. Guards a second press landing on the same work. */
  declare exporting: boolean
  /** How far along, so a long export says what it is doing rather than appearing to hang. */
  declare exportProgress: InventoryProgress | undefined
  declare exportFailed: boolean
  /**
   * Which devices are ticked, by full document id.
   *
   * A set rather than a flag on each device: the devices are re-read from the database and
   * re-derived by `browseDevices` on every change, so a flag would be lost on the next read,
   * and the selection has to outlive a search the user types while choosing.
   */
  declare selected: ReadonlySet<string>
  /**
   * How the finished bytes reach the user. Bound by a test.
   *
   * A seam because the real one clicks a link: in a test browser that is a download prompt,
   * or a file written into whatever directory the run happens to have — neither of which a
   * test should cause, and both of which are invisible when they go wrong.
   */
  declare download?: (bytes: Uint8Array, filename: string) => void

  constructor() {
    super()
    // Subscribes this component to locale changes; without it the view keeps rendering the
    // strings that were active when it first rendered.
    updateWhenLocaleChanges(this)
    this.exporting = false
    this.exportProgress = undefined
    this.exportFailed = false
    this.selected = new Set()
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

  /** Ticks or unticks one device. */
  private toggleSelected(id: string): void {
    const next = new Set(this.selected)
    if (!next.delete(id)) next.add(id)
    this.selected = next
  }

  private renderDevice(device: DeviceDocument) {
    return html`
      <li class="wa-cluster wa-gap-s" ?data-disabled=${device.disabled} data-device-id=${device._id}>
        <!-- Outside the link, deliberately. Inside it, every tick would also navigate to the
             device — and on a phone the two targets would overlap, so choosing several devices
             would mean visiting each one. -->
        <wa-checkbox
          data-select
          ?checked=${this.selected.has(device._id)}
          @change=${() => this.toggleSelected(device._id)}
          label=${msg(str`Select ${device.name}`)}
        ></wa-checkbox>
        <!-- The whole row is the link, not just the name: a target the width of the list is
             what makes this usable on a phone, which is where a device gets looked up. -->
        <a class="wa-split app-device app-device-row" href="#/devices/${uuidOf(device._id) ?? ''}">
          <span class="wa-stack wa-gap-3xs">
            <span>${device.name}</span>
            ${device.spot === undefined ? '' : html`<small class="app-empty">${device.spot}</small>`}
          </span>
          ${device.disabled ? html`<wa-tag variant="neutral">${msg('Disabled')}</wa-tag>` : ''}
        </a>
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
          <!-- Per room, because "print the labels for the kitchen" is the request people
               actually have, and ticking eleven boxes to make it is not an answer. Absent for
               devices whose room no longer exists: there is no room there to export. -->
          ${
            group.path === ''
              ? ''
              : html`<wa-button
                  data-export-room=${group.path}
                  size="small"
                  appearance="plain"
                  ?disabled=${this.exporting}
                  @click=${() => void this.onExport({ kind: 'room', path: group.path })}
                >
                  <wa-icon slot="start" name="file-pdf"></wa-icon>
                  ${msg('Export this room')}
                </wa-button>`
          }
        </div>
        <ul class="wa-stack wa-gap-2xs app-device-list">
          ${group.devices.map((device) => this.renderDevice(device))}
        </ul>
      </section>
    `
  }

  /**
   * What to say when there is nothing to show. Three different facts, three sentences.
   *
   * Telling a user with a full catalogue that it is empty because they mistyped a word is the
   * kind of small lie that makes people distrust an application. The third case is the one
   * that is easy to miss and was: with every device disabled and the box unticked, there is
   * nothing to show and *nothing was searched for*, so the search sentence would appear with an
   * empty pair of quotes in it - blaming the user for a filter they did not notice they had on.
   */
  private renderEmpty() {
    if (this.devices.length === 0) return html`<p class="app-empty">${msg('No devices yet.')}</p>`

    const query = this.query.trim()
    if (query === '') {
      // Reached only when the disabled filter hid everything: `browseDevices` returns nothing,
      // yet there are devices and no search. Naming the control is the point - the remedy is
      // one tick away and the message has to say which one.
      return html`<p class="app-empty">
        ${msg('Every device you have is disabled. Tick "Show disabled devices" to see them.')}
      </p>`
    }

    return html`<p class="app-empty">${msg(str`Nothing matches “${query}”.`)}</p>`
  }

  /**
   * Whether an export has been asked for that this one should abandon.
   *
   * A counter rather than a boolean: a cancelled export and a *newer* export are the same
   * thing to the one being abandoned, and both have to stop the loop that is already running.
   */
  private exportToken = 0

  /** Stops whatever export is running. */
  private cancelExport(): void {
    this.exportToken += 1
    this.exporting = false
    this.exportProgress = undefined
  }

  /**
   * Exports what is on screen.
   *
   * What is on screen, not what is in the database: the export takes the same groups the list
   * is rendering, so the search and the disabled filter apply to it exactly as the user sees
   * them. M3-2 turns that into a deliberate choice rather than a consequence.
   */
  private async onExport(selection: ExportSelection = { kind: 'all' }): Promise<void> {
    if (this.exporting) return
    const token = ++this.exportToken
    this.exporting = true
    this.exportFailed = false
    this.exportProgress = { done: 0, total: 0 }

    try {
      // Narrowed from what is on screen, never from the raw device list. That is what makes
      // "disabled devices are excluded unless explicitly included" true for every selection
      // rather than for the default one: a device the user cannot see is not in `groups()`,
      // so no amount of selecting can reach it.
      const chosen = selectForExport(this.groups(), selection)
      const bytes = await buildInventoryPdf(chosen, {
        labels: inventoryLabels(),
        onProgress: (progress) => {
          if (token === this.exportToken) this.exportProgress = progress
        },
        cancelled: () => token !== this.exportToken,
      })
      if (token !== this.exportToken) return
      ;(this.download ?? offerDownload)(bytes, inventoryFilename())
    } catch (error) {
      // A cancelled export is not a failure, and saying so would be the application
      // complaining about something the user asked for.
      if (error instanceof ExportCancelled) return
      // Not logged: the document being built contains setup passcodes, and an error carrying
      // one into a console is exactly the leak this project keeps saying it will not have.
      if (token === this.exportToken) this.exportFailed = true
    } finally {
      if (token === this.exportToken) {
        this.exporting = false
        this.exportProgress = undefined
      }
    }
  }

  override render() {
    const groups = this.groups()

    return html`
      <div class="wa-stack wa-gap-l">
        <div class="wa-split">
          <h1>${msg('Devices')}</h1>
          <div class="wa-cluster wa-gap-s">
            ${
              this.selected.size === 0
                ? ''
                : html`<wa-button
                    data-export-selected
                    appearance="outlined"
                    ?disabled=${this.exporting}
                    @click=${() => void this.onExport({ kind: 'devices', ids: this.selected })}
                  >
                    <wa-icon slot="start" name="file-pdf"></wa-icon>
                    <!-- Says how many, because "Export selection" on a page where the ticks
                         have scrolled out of view is a button whose effect is invisible. -->
                    ${msg(
                      str`Export ${countSelected(this.groups(), { kind: 'devices', ids: this.selected })} selected`,
                    )}
                  </wa-button>`
            }
            <wa-button data-export appearance="outlined" @click=${() => void this.onExport()} ?disabled=${this.exporting}>
              <wa-icon slot="start" name="file-pdf"></wa-icon>
              ${msg('Export PDF')}
            </wa-button>
            <wa-button href="#/devices/new" variant="brand">
              <wa-icon slot="start" name="plus"></wa-icon>
              ${msg('Add a device')}
            </wa-button>
          </div>
        </div>

        ${
          this.exporting
            ? html`
                <wa-callout variant="neutral" data-export-progress>
                  <wa-icon slot="icon" name="file-pdf"></wa-icon>
                  <div class="wa-split wa-gap-m">
                    <span>
                      ${msg(
                        str`Building the PDF: ${this.exportProgress?.done ?? 0} of ${this.exportProgress?.total ?? 0} devices.`,
                      )}
                    </span>
                    <wa-button data-cancel-export size="small" appearance="plain" @click=${this.cancelExport}>
                      ${msg('Cancel')}
                    </wa-button>
                  </div>
                </wa-callout>
              `
            : ''
        }
        ${
          this.exportFailed
            ? html`
                <wa-callout variant="danger" data-export-failed>
                  <wa-icon slot="icon" name="triangle-exclamation"></wa-icon>
                  ${msg('The PDF could not be built. Nothing was saved; try again.')}
                </wa-callout>
              `
            : ''
        }

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
