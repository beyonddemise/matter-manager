import { msg, updateWhenLocaleChanges } from '@lit/localize'
import {
  devicesInRoom,
  planRoomDeletion,
  type RoomDestination,
  type RoomDocument,
  renameRoom,
  reorderRooms,
  roomsInOrder,
} from '@matter-manager/core'
import type { ProjectRepositories } from '@matter-manager/data'
import { html, LitElement, type PropertyDeclarations, type TemplateResult } from 'lit'
import { PROJECT_CHANGED } from '../current-project.js'
import { projectDatabase, projectIsEditable } from '../db/project-database.js'

/**
 * The rooms of a project: what order they are in, what they are called, and removing one.
 *
 * The decisions all live in `core/src/rooms/list.ts` — `roomsInOrder`, `renameRoom`,
 * `reorderRooms` and `planRoomDeletion` — as pure functions that plan and do not write. They
 * were written and tested at M5-9 and then imported by nothing at all: #142, which is #120's
 * defect one package over. This is the caller they were waiting for.
 *
 * Every write here is the caller's half of one of those plans, in the order the plan says.
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
    rooms: { state: true },
    devices: { state: true },
    loaded: { state: true },
    failed: { state: true },
    renaming: { state: true },
    deleting: { state: true },
    busy: { state: true },
  }

  declare repositories?: ProjectRepositories
  declare rooms: readonly RoomDocument[]
  /** Every device, so each room can say how many it holds without a second read per room. */
  declare devices: readonly Parameters<typeof devicesInRoom>[1][number][]
  declare loaded: boolean
  declare failed: boolean
  /** The room being renamed, or `undefined`. One at a time; two would be two ways to collide. */
  declare renaming: string | undefined
  /** The room being deleted, which is where its devices have to be sent. */
  declare deleting: string | undefined
  declare busy: boolean

  constructor() {
    super()
    updateWhenLocaleChanges(this)
    this.rooms = []
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
    this.rooms = []
    this.devices = []
    this.renaming = undefined
    this.deleting = undefined
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
      const [rooms, devices] = await Promise.all([
        this.repos().rooms.list(),
        this.repos().devices.list(),
      ])
      if (generation !== this.loadGeneration) return

      this.rooms = rooms
      this.devices = devices
      this.loaded = true
      this.failed = false
    } catch {
      // Not logged: a device document carries a setup code. The message says the one thing
      // that is certainly true — the rooms were not read, and nothing has been lost.
      if (generation === this.loadGeneration) this.failed = true
    }
  }

  /** Writes what a plan produced, then re-reads. Every write here goes through this. */
  private async apply(write: () => Promise<void>): Promise<void> {
    this.busy = true
    try {
      await write()
      await this.load()
    } catch {
      // A plan can fail after an earlier write succeeded. Re-read before reporting it, so a
      // retry is planned from what was actually saved rather than from the old snapshot.
      await this.load()
      this.failed = true
    } finally {
      this.busy = false
    }
  }

  private ordered(): readonly RoomDocument[] {
    return roomsInOrder(this.rooms)
  }

  /**
   * Moves a room one place up or down.
   *
   * Buttons rather than dragging. A drag needs a pointer, and the people using this are
   * standing in a building holding a phone — and `reorderRooms` returns only the rooms whose
   * position actually changed, so a nudge writes two documents rather than forty.
   */
  private async onMove(roomId: string, by: -1 | 1): Promise<void> {
    const ids = this.ordered().map((room) => room._id)
    const at = ids.indexOf(roomId)
    const to = at + by
    if (at === -1 || to < 0 || to >= ids.length) return

    const reordered = [...ids]
    const [moved] = reordered.splice(at, 1)
    if (moved === undefined) return
    reordered.splice(to, 0, moved)

    await this.apply(async () => {
      for (const room of reorderRooms(reordered, this.rooms)) await this.repos().rooms.save(room)
    })
  }

  /**
   * Renames a room, and every room beneath it.
   *
   * `renameRoom` moves the whole subtree: renaming `Ground Floor` has to take
   * `Ground Floor/Kitchen` with it, or the child becomes a room nobody meant to create. It
   * throws on a collision, which is reported rather than swallowed — the name is the user's to
   * choose again.
   */
  private async onRename(room: RoomDocument, to: string): Promise<void> {
    this.renaming = undefined
    if (to.trim() === '' || to === room.path) return

    let planned: readonly Parameters<ProjectRepositories['rooms']['save']>[0][]
    try {
      planned = renameRoom(room.path, to, this.rooms)
    } catch {
      // A collision with a room that already exists. Nothing is written and the list is
      // unchanged, so the remedy is to try another name.
      this.failed = true
      return
    }

    await this.apply(async () => {
      for (const moved of planned) await this.repos().rooms.save(moved)
    })
  }

  /**
   * Removes a room, sending whatever was in it somewhere.
   *
   * The destination is required by `planRoomDeletion`'s signature, and that is the mechanism
   * rather than a check: no value of `RoomDestination` means "never mind", so deleting a room
   * and silently orphaning its devices is not something this can express.
   */
  private async onDelete(roomId: string, destination: RoomDestination): Promise<void> {
    this.deleting = undefined

    const plan = planRoomDeletion(roomId, this.rooms, this.devices, destination, () =>
      crypto.randomUUID(),
    )

    await this.apply(async () => {
      // In the plan's order, and it is load-bearing: a device pointing at a room that does not
      // exist yet is the orphan this whole operation exists to avoid.
      if (plan.create !== undefined) await this.repos().rooms.save(plan.create)
      for (const device of plan.reassign) await this.repos().devices.save(device)
      await this.repos().rooms.remove(plan.remove)
    })
  }

  private countIn(room: RoomDocument): number {
    return devicesInRoom(room._id, this.devices).length
  }

  override render(): TemplateResult {
    const rooms = this.ordered()

    return html`
      <div class="wa-stack wa-gap-l">
        <h1>${msg('Rooms')}</h1>

        ${
          this.failed
            ? html`<wa-callout variant="danger" data-rooms-failed>
                <wa-icon slot="icon" name="triangle-exclamation"></wa-icon>
                ${msg({
                  id: 's64313212d2e974b6',
                  str: 'That did not finish. Some changes may have been saved. Check and try again.',
                })}
              </wa-callout>`
            : ''
        }

        ${
          this.loaded && rooms.length === 0
            ? html`<p class="app-empty" data-no-rooms>
                ${msg('No rooms yet. A room is created when you type one on a device.')}
              </p>`
            : html`<ul class="wa-stack wa-gap-2xs" data-rooms>
                ${rooms.map((room, index) => this.renderRoom(room, index, rooms.length))}
              </ul>`
        }
      </div>
    `
  }

  private renderRoom(room: RoomDocument, index: number, total: number): TemplateResult {
    const held = this.countIn(room)

    return html`
      <li class="wa-split wa-gap-s" data-room data-room-id=${room._id}>
        ${
          this.renaming === room._id
            ? html`
                <wa-input
                  data-rename-input
                  value=${room.path}
                  label=${msg('Room name')}
                  @keydown=${(event: KeyboardEvent) => {
                    if (event.key !== 'Enter') return
                    void this.onRename(room, (event.target as { value?: string }).value ?? '')
                  }}
                ></wa-input>
              `
            : html`
                <div class="wa-stack wa-gap-3xs">
                  <span data-room-path>${room.path}</span>
                  <small class="app-empty" data-room-count>
                    ${held === 0 ? msg('No devices') : String(held)}
                  </small>
                </div>
              `
        }

        ${
          // Absent, not disabled, on a project somebody may only read (#55).
          !projectIsEditable()
            ? ''
            : html`
                <div class="wa-cluster wa-gap-2xs">
                  <wa-button
                    data-move-up
                    appearance="plain"
                    ?disabled=${index === 0 || this.busy}
                    @click=${() => void this.onMove(room._id, -1)}
                  >
                    <wa-icon name="arrows-rotate" label=${msg('Move up')}></wa-icon>
                  </wa-button>
                  <wa-button
                    data-move-down
                    appearance="plain"
                    ?disabled=${index === total - 1 || this.busy}
                    @click=${() => void this.onMove(room._id, 1)}
                  >
                    <wa-icon name="arrows-rotate" label=${msg('Move down')}></wa-icon>
                  </wa-button>
                  <wa-button
                    data-rename
                    appearance="plain"
                    ?disabled=${this.busy}
                    @click=${() => {
                      this.renaming = room._id
                    }}
                  >
                    <wa-icon name="pen" label=${msg('Rename')}></wa-icon>
                  </wa-button>
                  <wa-button
                    data-delete-room
                    appearance="plain"
                    variant="danger"
                    ?disabled=${this.busy}
                    @click=${() => {
                      this.deleting = room._id
                    }}
                  >
                    <wa-icon name="trash" label=${msg('Delete')}></wa-icon>
                  </wa-button>
                </div>
              `
        }

        ${this.deleting === room._id ? this.renderDeletion(room, held) : ''}
      </li>
    `
  }

  /**
   * Where the devices go, asked before the room is removed.
   *
   * Asked even when the room is empty. `planRoomDeletion` requires a destination whatever the
   * room holds, on the reasoning that an optional-when-empty parameter is an optional
   * parameter — and the caller who forgets it is the caller who did not check.
   */
  private renderDeletion(room: RoomDocument, held: number): TemplateResult {
    const others = this.ordered().filter((candidate) => candidate._id !== room._id)

    return html`
      <wa-dialog data-delete-room-dialog open label=${msg('Delete this room?')}>
        <p>
          ${
            held === 0
              ? msg('This room holds no devices.')
              : msg('The devices in this room have to go somewhere. Nothing is deleted.')
          }
        </p>
        <wa-select data-destination label=${msg('Move the devices to')} value="unassigned">
          <wa-option value="unassigned">${msg('Unassigned')}</wa-option>
          ${others.map(
            (candidate) => html`<wa-option value=${candidate._id}>${candidate.path}</wa-option>`,
          )}
        </wa-select>
        <wa-button
          slot="footer"
          data-cancel-delete-room
          @click=${() => {
            this.deleting = undefined
          }}
        >
          ${msg('Cancel')}
        </wa-button>
        <wa-button
          slot="footer"
          variant="danger"
          data-confirm-delete-room
          @click=${() => {
            const select = this.querySelector('[data-destination]') as { value?: unknown } | null
            const chosen = typeof select?.value === 'string' ? select.value : 'unassigned'
            void this.onDelete(
              room._id,
              chosen === 'unassigned' ? { kind: 'unassigned' } : { kind: 'room', roomId: chosen },
            )
          }}
        >
          ${msg('Delete the room')}
        </wa-button>
      </wa-dialog>
    `
  }
}

customElements.define('rooms-view', RoomsView)
