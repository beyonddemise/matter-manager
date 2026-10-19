import { msg, str, updateWhenLocaleChanges } from '@lit/localize'
import { html, LitElement, nothing, type PropertyDeclarations, type TemplateResult } from 'lit'
import type { ProjectRepositories } from '../../data/index.js'
import {
  type DeviceDocument,
  isValidRoomPath,
  type Room,
  renameRoom,
  roomsOf,
} from '../../domain/index.js'
import { PROJECT_CHANGED } from '../current-project.js'
import { projectDatabase, projectIsEditable } from '../db/project-database.js'
import { getLocale } from '../i18n/localization.js'
import { fieldValue } from './device-form.js'
import { projectLine } from './project-line.js'
import { roomSpellings } from './room-breadcrumb.js'
import { devicesInRoomHref } from './room-filter.js'

/** What the open dialog is doing: renaming a room, or merging its spellings into one. */
interface Editing {
  readonly room: Room
  readonly merge: boolean
}

/**
 * The rooms of a project, and renaming one (ADR 0021).
 *
 * A room is not a document: it is the path its devices carry, so this page lists `roomsOf` the
 * devices and a rename rewrites the devices (`renameRoom`). A room appears when the first device
 * is filed under it and goes when the last one leaves, so there is nothing to create, order or
 * delete here.
 *
 * A room whose devices spell it differently (`Kitchen`, `kitchen`) shows every spelling and a
 * Merge button. Merging is a rename to one name, so every spelling ends up the same.
 *
 * @module
 */
export class RoomsView extends LitElement {
  /** Light DOM, so Web Awesome's global utility classes reach this markup. See `app-shell.ts`. */
  protected override createRenderRoot(): HTMLElement {
    return this
  }

  static override properties: PropertyDeclarations = {
    repositories: { attribute: false },
    projectName: { attribute: false },
    devices: { state: true },
    loaded: { state: true },
    failed: { state: true },
    editing: { state: true },
    busy: { state: true },
  }

  declare repositories?: ProjectRepositories
  /** The open project's name, from the shell; see `projectLine`. */
  declare projectName: string
  /** Every device: the rooms are derived from them. */
  declare devices: readonly DeviceDocument[]
  declare loaded: boolean
  /** A read or a rename did not finish. */
  declare failed: boolean
  /** The room in the rename dialog, or `undefined` when it is closed. */
  declare editing: Editing | undefined
  declare busy: boolean

  constructor() {
    super()
    updateWhenLocaleChanges(this)
    this.projectName = ''
    this.devices = []
    this.loaded = false
    this.failed = false
    this.busy = false
  }

  private resolved: ProjectRepositories | undefined
  private repos(): ProjectRepositories {
    this.resolved ??= this.repositories ?? projectDatabase()
    return this.resolved
  }

  /** Re-reads when the reader moves to another project (#55). */
  private onProjectChanged = (): void => {
    this.resolved = undefined
    this.devices = []
    this.editing = undefined
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

  protected override firstUpdated(): void {
    void this.load()
  }

  /** Counts loads, so one from the previous project cannot land in this one. */
  private loadGeneration = 0

  private async load(): Promise<void> {
    const generation = ++this.loadGeneration
    try {
      const devices = await this.repos().devices.list()
      if (generation !== this.loadGeneration) return
      this.devices = devices
      this.loaded = true
      this.failed = false
    } catch {
      // Not logged: a device document carries a setup code. The message says the one thing
      // that is certainly true — the rooms were not read, and nothing has been lost.
      if (generation === this.loadGeneration) this.failed = true
    }
  }

  /** In the interface's locale, so the list sorts as the device list does. */
  private rooms(): readonly Room[] {
    return roomsOf(this.devices, new Intl.Collator(getLocale()).compare)
  }

  /**
   * Renames a room, or merges its spellings, by rewriting every device in it.
   *
   * `renameRoom` takes the whole subtree: renaming `Ground Floor` takes `Ground Floor/Kitchen`
   * with it. Renaming onto a room that exists files the devices there too, which is a merge and
   * the intended result.
   *
   * The devices are saved one at a time, so a failure can leave some renamed. The page re-reads
   * before reporting it, and a second attempt plans from what was saved: a device already
   * renamed is no longer in the old room, so it is not renamed twice.
   */
  private async onRename(room: Room, to: string): Promise<void> {
    const target = to.trim()
    if (!isValidRoomPath(target)) return
    this.editing = undefined

    const planned = renameRoom(this.devices, room.spellings[0], target)
    if (planned.length === 0) return

    this.busy = true
    try {
      for (const device of planned) await this.repos().devices.save(device)
      await this.load()
    } catch {
      await this.load()
      this.failed = true
    } finally {
      this.busy = false
    }
  }

  override render(): TemplateResult {
    const rooms = this.rooms()

    return html`
      <div class="wa-stack wa-gap-l">
        <div class="wa-stack wa-gap-3xs">
          <h1>${msg('Rooms')}</h1>
          ${projectLine(this.projectName)}
        </div>
        <p data-rooms-intro>${msg('A room appears when you add the first device to a new room.')}</p>

        ${
          this.failed
            ? html`<wa-callout variant="danger" data-rooms-failed>
                <wa-icon slot="icon" name="triangle-exclamation"></wa-icon>
                ${msg('That did not finish. Some changes may have been saved. Check and try again.')}
              </wa-callout>`
            : ''
        }

        ${
          rooms.length === 0
            ? nothing
            : html`<ul class="wa-stack wa-gap-2xs" data-rooms>
                ${rooms.map((room) => this.renderRoom(room))}
              </ul>`
        }

        ${this.renderDialog()}
      </div>
    `
  }

  private renderRoom(room: Room): TemplateResult {
    const mixed = room.spellings.length > 1

    return html`
      <li class="wa-split wa-gap-s" data-room data-room-key=${room.key}>
        <div class="wa-stack wa-gap-3xs">
          <!-- The first spelling in the link: the filter matches every spelling (by key), so any
               one of them lists the same devices. -->
          <a href=${devicesInRoomHref(room.spellings[0])} data-room-path>
            ${roomSpellings(room.spellings)}
          </a>
          <small class="app-empty" data-room-count>
            ${
              room.deviceCount === 1
                ? msg('1 device')
                : msg(str`${room.deviceCount} devices`, { desc: 'How many devices are in a room.' })
            }
          </small>
        </div>

        ${
          // Absent, not disabled, on a project somebody may only read (#55).
          !projectIsEditable()
            ? ''
            : html`
                <div class="wa-cluster wa-gap-2xs">
                  ${
                    mixed
                      ? html`<wa-button
                          data-merge
                          size="s"
                          appearance="outlined"
                          ?disabled=${this.busy}
                          @click=${() => {
                            this.editing = { room, merge: true }
                          }}
                        >
                          ${msg('Merge')}
                        </wa-button>`
                      : ''
                  }
                  <wa-button
                    data-rename
                    appearance="plain"
                    ?disabled=${this.busy}
                    @click=${() => {
                      this.editing = { room, merge: false }
                    }}
                  >
                    <wa-icon name="pen" label=${msg('Rename')}></wa-icon>
                  </wa-button>
                </div>
              `
        }
      </li>
    `
  }

  /**
   * The rename dialog, which is also the merge dialog.
   *
   * Prefilled with the first spelling either way. For a merge it says what saving does, because
   * "Rename" on a room that already looks right would otherwise read as a no-op.
   */
  private renderDialog(): TemplateResult | typeof nothing {
    const editing = this.editing
    if (editing === undefined) return nothing

    const save = (): void => {
      const value = fieldValue(this, '[data-rename-input]')
      void this.onRename(editing.room, value)
    }

    return html`
      <wa-dialog
        data-rename-dialog
        open
        label=${editing.merge ? msg('Merge the spellings') : msg('Rename the room')}
        @wa-after-hide=${(event: Event) => {
          // Only the dialog's own close: a select or tooltip inside it bubbles the same event.
          if (event.target === event.currentTarget) this.editing = undefined
        }}
      >
        <form
          class="wa-stack wa-gap-m"
          @submit=${(event: Event) => {
            event.preventDefault()
            save()
          }}
        >
          <wa-input
            data-rename-input
            required
            value=${editing.room.spellings[0]}
            label=${msg('Room name')}
            hint=${
              editing.merge
                ? msg('All devices in this room will use this name.')
                : msg(
                    'Every device in this room, and in the rooms inside it, moves to the new name.',
                  )
            }
          ></wa-input>
        </form>
        <wa-button slot="footer" data-dialog="close" appearance="plain">${msg('Cancel')}</wa-button>
        <wa-button slot="footer" data-save-rename variant="brand" @click=${save}>
          ${editing.merge ? msg('Merge') : msg('Rename')}
        </wa-button>
      </wa-dialog>
    `
  }
}

customElements.define('rooms-view', RoomsView)
