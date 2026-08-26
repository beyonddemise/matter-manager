import { msg, updateWhenLocaleChanges } from '@lit/localize'
import {
  type DeviceDraft,
  DraftError,
  type DraftField,
  normaliseRoomPath,
  planNewDevice,
  type RoomDocument,
} from '@matter-manager/core'
import type { ProjectRepositories } from '@matter-manager/data'
import { html, LitElement } from 'lit'
import { projectDatabase } from '../db/project-database.js'

/** Today, as `<input type="date">` writes it: a calendar date in the user's own timezone. */
function today(): string {
  const now = new Date()
  const local = new Date(now.getTime() - now.getTimezoneOffset() * 60_000)
  // `toISOString` is UTC, which is why the offset is subtracted first: without it, anyone east
  // of Greenwich filing a device late in the evening would have it dated tomorrow.
  return local.toISOString().slice(0, 10)
}

/** Reads a form control's value defensively; controls report through DOM properties. */
function fieldValue(root: ParentNode, selector: string): string {
  const control = root.querySelector(selector) as { value?: unknown } | null
  return typeof control?.value === 'string' ? control.value : ''
}

/**
 * The add-a-device form.
 *
 * One field takes the setup code in either form it comes in — an `MT:` payload or a manual
 * pairing code — because a person holding a label does not first classify what is printed on
 * it. `readCredential` in `core` decides, and the camera in M2b-1 becomes one more way to fill
 * the same field rather than a second flow.
 *
 * Nothing is written until every field has passed: `planNewDevice` returns documents rather
 * than saving them, so "an invalid payload creates no device" is a property of the code's
 * shape rather than of remembering to return early.
 */
export class AddDeviceView extends LitElement {
  /** Light DOM, so Web Awesome's global utility classes reach this markup. See `app-shell.ts`. */
  protected override createRenderRoot(): HTMLElement {
    return this
  }

  static override properties = {
    repositories: { attribute: false },
    rooms: { state: true },
    createdRoom: { state: true },
    error: { state: true },
    saving: { state: true },
  }

  /**
   * Where devices and rooms are read and written.
   *
   * Bound by a test to an in-memory pair; left unset in the application, where it resolves to
   * the real database on first use. Resolved in {@link firstUpdated} rather than the
   * constructor so that a bound value is already in place — property bindings are committed
   * before the first update, but not before construction.
   */
  declare repositories?: ProjectRepositories
  declare rooms: readonly RoomDocument[]
  /** A room path the user asked to create, not yet written. See {@link onCreateRoom}. */
  declare createdRoom: string
  // `| undefined` rather than `?:`: the field is cleared on a successful attempt, and under
  // `exactOptionalPropertyTypes` assigning `undefined` to an optional property is an error.
  declare error: DraftError | undefined
  declare saving: boolean

  constructor() {
    super()
    updateWhenLocaleChanges(this)
    this.rooms = []
    this.createdRoom = ''
    this.saving = false
  }

  protected override firstUpdated(): void {
    // The date is set once, imperatively, rather than bound in the template: a bound `value`
    // would be rewritten on every re-render, so the first validation error would silently
    // undo whatever date the user had chosen.
    const installed = this.querySelector('[data-field="installed-at"]') as { value?: string } | null
    if (installed) installed.value = today()
    void this.loadRooms()
  }

  /**
   * The repositories to use, resolving the default on first use.
   *
   * The result is cached in a plain field rather than written back to `repositories`, which is
   * reactive: assigning a reactive property from inside `firstUpdated` schedules a second
   * update for no reason, and Lit says so in dev mode.
   */
  private resolved: ProjectRepositories | undefined
  private repos(): ProjectRepositories {
    this.resolved ??= this.repositories ?? projectDatabase()
    return this.resolved
  }

  private async loadRooms(): Promise<void> {
    this.rooms = await this.repos().rooms.list()
  }

  /**
   * The combobox's own "Create *X*" option, taken over.
   *
   * `preventDefault` matters: left alone, the component appends a `<wa-option>` of its own to
   * DOM that Lit owns and re-renders, so the new room would vanish on the next update. Holding
   * the path in state instead means Lit renders the option and it survives.
   */
  private async onCreateRoom(event: CustomEvent<{ inputValue: string }>): Promise<void> {
    event.preventDefault()
    this.createdRoom = normaliseRoomPath(event.detail.inputValue)
    // The option has to exist before it can be selected, and Lit renders asynchronously.
    await this.updateComplete
    const combobox = this.querySelector('[data-field="room"]') as { value?: string } | null
    if (combobox) combobox.value = this.createdRoom
  }

  /**
   * The room the user settled on.
   *
   * `value` is the selected option; `inputValue` is what is currently typed. Falling back to
   * the typed text is deliberate rather than defensive: someone who types "Bathroom" and
   * presses Save has said which room they mean, and refusing them because they did not also
   * pick "Create Bathroom" from a list would be the application being pedantic about its own
   * widget.
   */
  private roomValue(): string {
    const combobox = this.querySelector('[data-field="room"]') as {
      value?: unknown
      inputValue?: unknown
    } | null
    const selected = typeof combobox?.value === 'string' ? combobox.value : ''
    const typed = typeof combobox?.inputValue === 'string' ? combobox.inputValue : ''
    return selected === '' ? typed : selected
  }

  private draft(): DeviceDraft {
    return {
      credential: fieldValue(this, '[data-field="credential"]'),
      name: fieldValue(this, '[data-field="name"]'),
      room: this.roomValue(),
      spot: fieldValue(this, '[data-field="spot"]'),
      serial: fieldValue(this, '[data-field="serial"]'),
      installedAt: fieldValue(this, '[data-field="installed-at"]'),
    }
  }

  private async onSubmit(event: Event): Promise<void> {
    event.preventDefault()
    if (this.saving) return
    // Set before the first `await`, not after the planning: two quick clicks would otherwise
    // both get past the guard while the room read below was still in flight.
    this.saving = true

    try {
      // Re-read the rooms rather than planning against `this.rooms`.
      //
      // `firstUpdated` starts that read asynchronously, so a user who types the name of an
      // existing room and saves before it lands would be planned against an empty list - and
      // `planNewDevice`, seeing no match, would create a *second* room with the same path.
      // That is precisely the duplicate this flow exists to prevent, and it would appear only
      // on a slow device or a large catalogue, which is where nobody is watching for it.
      //
      // Re-reading closes the window completely rather than narrowing it, and it costs one
      // ranged `_all_docs` on a deliberate action. It also picks up a room another tab created
      // since this form was opened.
      const rooms = await this.repos().rooms.list()
      this.rooms = rooms

      let creation: ReturnType<typeof planNewDevice>
      try {
        creation = planNewDevice(this.draft(), rooms, {
          uuid: () => crypto.randomUUID(),
          now: () => new Date().toISOString(),
        })
      } catch (problem) {
        if (problem instanceof DraftError) {
          this.error = problem
          return
        }
        // Anything else is a bug rather than a statement about the form, and swallowing it
        // here would show the user a validation message for a fault that is not theirs.
        // Unreachable from the form and deliberately left uncovered; see the matching note in
        // `core/src/documents/new-device.ts`.
        throw problem
      }

      this.error = undefined

      // The room first. PouchDB has no transactions, so a failure between the two writes
      // leaves either nothing or an empty room - and an empty room is harmless and reusable,
      // whereas a device pointing at a room that does not exist is a broken record.
      if (creation.room !== undefined) {
        await this.repos().rooms.save(creation.room)
      }
      await this.repos().devices.save(creation.device)
    } finally {
      this.saving = false
    }

    window.location.hash = '#/'
  }

  /**
   * The message for a field, when that is the field the last attempt failed on.
   *
   * The callout above the form says what went wrong; this puts the same sentence next to the
   * control that caused it, which is what stops the user hunting across six of them. `DraftField`
   * being a closed union is what makes a new field a type error here rather than a silent gap.
   */
  private messageFor(field: DraftField): string | undefined {
    return this.error?.field === field ? this.error.message : undefined
  }

  /**
   * Every known room path, plus one the user just asked to create.
   *
   * De-duplicated because `wa-combobox` keys its options by value, and a room the user typed
   * that turns out to already exist would otherwise appear twice.
   */
  private roomPaths(): readonly string[] {
    const paths = this.rooms.map((room) => room.path)
    return this.createdRoom === '' || paths.includes(this.createdRoom)
      ? paths
      : [...paths, this.createdRoom]
  }

  override render() {
    return html`
      <form class="wa-stack wa-gap-l app-form" @submit=${this.onSubmit} novalidate>
        <h1>${msg('Add a device')}</h1>

        ${
          this.error === undefined
            ? ''
            : html`
                <wa-callout variant="danger" data-error>
                  <wa-icon slot="icon" name="circle-exclamation"></wa-icon>
                  ${this.error.message}
                </wa-callout>
              `
        }

        <wa-input
          data-field="credential"
          label=${msg('Setup code')}
          hint=${this.messageFor('credential') ?? msg('The MT: code from the QR label, or the numeric pairing code beneath it.')}
          autocomplete="off"
          spellcheck="false"
        ></wa-input>

        <wa-input
          data-field="name"
          label=${msg('Name')}
          hint=${this.messageFor('name') ?? msg('What you would call it out loud: "kitchen ceiling light".')}
        ></wa-input>

        <wa-combobox
          data-field="room"
          allow-create
          label=${msg('Room')}
          hint=${this.messageFor('room') ?? msg('Pick a room, or type a new one to create it. Use "/" for floors: "Ground Floor/Kitchen".')}
          @wa-create=${this.onCreateRoom}
        >
          ${this.roomPaths().map((path) => html`<wa-option value=${path}>${path}</wa-option>`)}
        </wa-combobox>

        <wa-input
          data-field="spot"
          label=${msg('Spot')}
          hint=${msg('Where in the room, if that helps: "ceiling, north end".')}
        ></wa-input>

        <wa-input data-field="serial" label=${msg('Serial number')}></wa-input>

        <wa-input
          data-field="installed-at"
          type="date"
          label=${msg('Installed')}
          hint=${this.messageFor('installedAt') ?? ''}
        ></wa-input>

        <div class="wa-cluster wa-gap-s">
          <wa-button type="submit" variant="brand" ?disabled=${this.saving}>
            ${msg('Save device')}
          </wa-button>
          <wa-button href="#/" appearance="plain">${msg('Cancel')}</wa-button>
        </div>
      </form>
    `
  }
}

customElements.define('add-device-view', AddDeviceView)
