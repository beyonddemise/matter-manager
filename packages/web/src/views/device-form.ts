import { msg, updateWhenLocaleChanges } from '@lit/localize'
import {
  type DeviceDocument,
  type DeviceFields,
  type DraftError,
  type DraftField,
  normaliseRoomPath,
  type RoomDocument,
  type Unsaved,
} from '@matter-manager/core'
import type { ProjectRepositories } from '@matter-manager/data'
import { html, LitElement, type PropertyDeclarations, type TemplateResult } from 'lit'
import { projectDatabase } from '../db/project-database.js'
import { problemMessage } from '../i18n/problems.js'

/**
 * Reads a form control's value defensively; controls report through DOM properties.
 *
 * Exported because both forms read their own extra controls with it — the setup code on the
 * add form, and whatever a later story adds.
 */
export function fieldValue(root: ParentNode, selector: string): string {
  const control = root.querySelector(selector) as { value?: unknown } | null
  return typeof control?.value === 'string' ? control.value : ''
}

/**
 * What the add form and the edit form have in common.
 *
 * They differ in one input — the setup code, which only a new device carries — and in what
 * they do on submit. Everything between those is the same: five controls, an error callout
 * that has to name a field, the room combobox's `wa-create` handling, and the rule that values
 * are written to controls imperatively rather than bound.
 *
 * That last one is the subtle one and the reason this is a base class rather than two files
 * that look alike: binding `.value` in the template means Lit rewrites every control on every
 * re-render, so the first validation error silently reverts everything the user had typed.
 *
 * **This defines no custom element.** It is a base, not a component.
 */
export abstract class DeviceFormView extends LitElement {
  /** Light DOM, so Web Awesome's global utility classes reach this markup. See `app-shell.ts`. */
  protected override createRenderRoot(): HTMLElement {
    return this
  }

  // Annotated rather than inferred: without it TypeScript pins this to the literal shape, and
  // a subclass adding its own properties is then an incompatible static override. Lit merges
  // the two maps at finalize time, so a subclass declares only what it adds.
  static override properties: PropertyDeclarations = {
    repositories: { attribute: false },
    rooms: { state: true },
    createdRoom: { state: true },
    error: { state: true },
    saving: { state: true },
    saveFailed: { state: true },
    roomsFailed: { state: true },
  }

  /**
   * Where devices and rooms are read and written.
   *
   * Bound by a test to an in-memory pair; left unset in the application, where it resolves to
   * the real database on first use.
   */
  declare repositories?: ProjectRepositories
  declare rooms: readonly RoomDocument[]
  /** A room path the user asked to create, not yet written. See {@link onCreateRoom}. */
  declare createdRoom: string
  // `| undefined` rather than `?:`: the field is cleared on a successful attempt, and under
  // `exactOptionalPropertyTypes` assigning `undefined` to an optional property is an error.
  declare error: DraftError | undefined
  declare saving: boolean
  /** Whether the last write was rejected by storage. Distinct from a rejected *field*. */
  declare saveFailed: boolean
  /**
   * Whether the existing rooms could not be read.
   *
   * Not fatal — a room can be typed — but worth saying, because offering no suggestions
   * silently invites a duplicate room that outlives the failure that caused it.
   */
  declare roomsFailed: boolean

  constructor() {
    super()
    // Every component rendering a `msg()` needs this, and one that forgets keeps its old
    // strings while its neighbours change - a silent failure, hence the locale-switch test.
    updateWhenLocaleChanges(this)
    this.rooms = []
    this.roomsFailed = false
    this.createdRoom = ''
    this.saving = false
    this.saveFailed = false
  }

  /**
   * The repositories to use, resolving the default on first use.
   *
   * The result is cached in a plain field rather than written back to `repositories`, which is
   * reactive: assigning a reactive property from inside an update schedules a second update
   * for no reason, and Lit says so in dev mode.
   */
  private resolved: ProjectRepositories | undefined
  protected repos(): ProjectRepositories {
    this.resolved ??= this.repositories ?? projectDatabase()
    return this.resolved
  }

  protected async loadRooms(): Promise<void> {
    try {
      this.rooms = await this.repos().rooms.list()
    } catch {
      // The least severe of the three read failures, and still worth saying. The rooms are only
      // suggestions here — the form works without them, because a room can be typed. But
      // silently offering none invites somebody to type "Kitchen" for a project that already
      // has a Kitchen, and the duplicate outlives the failure that caused it.
      //
      // Not logged: the form holds a setup code.
      this.roomsFailed = true
    }
  }

  /**
   * Writes the planned documents, and says whether it worked.
   *
   * The room goes first. PouchDB has no transactions, so a failure between the two writes
   * leaves either nothing or an empty room — and an empty room is harmless and reusable,
   * whereas a device pointing at a room that does not exist is a broken record.
   *
   * A rejected write is reported rather than thrown. Left to propagate out of a submit
   * handler it becomes an unhandled rejection: the button un-busies, nothing appears on
   * screen, and the user cannot tell whether their device was saved — which for a form whose
   * whole purpose is not losing a code is the worst possible way to fail.
   *
   * The error itself is deliberately not logged. The document being written contains the
   * setup passcode, and a storage error carrying a copy of it into a console — and from there
   * into whatever a user pastes into a bug report — is the one leak this application must not
   * have. What the user needs is on screen; what a developer needs is the failing operation,
   * which is this one.
   */
  protected async write(plan: {
    readonly room?: Unsaved<RoomDocument>
    readonly device: Unsaved<DeviceDocument>
  }): Promise<boolean> {
    try {
      if (plan.room !== undefined) await this.repos().rooms.save(plan.room)
      await this.repos().devices.save(plan.device)
      // Not observable today: a successful save always navigates away from the form, so
      // nothing renders this flag afterwards, and a mutation probe reports the line as a
      // survivor. It stays because it makes the flag a true statement about the last attempt
      // rather than one that happens to be true because of where the caller goes next - the
      // same reason `new-device.ts` keeps its unreachable rethrow.
      this.saveFailed = false
      return true
    } catch {
      this.saveFailed = true
      return false
    }
  }

  /** Writes a value into a control, once. Never bound; see the class comment. */
  protected setControlValue(selector: string, value: string): void {
    const control = this.querySelector(selector) as { value?: string } | null
    if (control) control.value = value
  }

  /**
   * The combobox's own "Create *X*" option, taken over.
   *
   * `preventDefault` matters: left alone, the component appends a `<wa-option>` of its own to
   * DOM that Lit owns and re-renders, so the new room would vanish on the next update. Holding
   * the path in state instead means Lit renders the option and it survives.
   */
  protected async onCreateRoom(event: CustomEvent<{ inputValue: string }>): Promise<void> {
    event.preventDefault()
    this.createdRoom = normaliseRoomPath(event.detail.inputValue)
    await this.selectRoom(this.createdRoom)
  }

  /**
   * Selects a room path in the combobox, waiting for its option to exist first.
   *
   * `<wa-combobox>` rejects a `value` matching no option and leaves itself at `null`, and Lit
   * renders asynchronously — so assigning before the update lands sets nothing at all, silently.
   */
  protected async selectRoom(path: string): Promise<void> {
    await this.updateComplete
    this.setControlValue('[data-field="room"]', path)
  }

  /**
   * The room the user settled on.
   *
   * `value` is the selected option; `inputValue` is what is currently typed. Taking the typed
   * text is deliberate rather than defensive: someone who types "Bathroom" and presses Save has
   * said which room they mean, and refusing them because they did not also pick "Create
   * Bathroom" from a list would be the application being pedantic about its own widget.
   *
   * The typed text wins whenever it **differs** from the selection, and that condition is the
   * load-bearing part. Selecting an option syncs `inputValue` to that option's label, but
   * typing afterwards leaves `value` on the stale selection - verified against the component,
   * not assumed. So `selected === '' ? typed : selected` silently files the device in the room
   * the user changed their mind about, which on the edit form is a move that does not move.
   * When the two agree, `selected` is preferred because it is the option's normalised path.
   *
   * This rests on options rendering the path as both their value and their label, which
   * {@link renderFields} does.
   */
  protected roomValue(): string {
    const combobox = this.querySelector('[data-field="room"]') as {
      value?: unknown
      inputValue?: unknown
    } | null
    const selected = typeof combobox?.value === 'string' ? combobox.value : ''
    const typed = typeof combobox?.inputValue === 'string' ? combobox.inputValue : ''
    return typed !== '' && typed !== selected ? typed : selected
  }

  /** The five shared controls, read back exactly as the DOM reports them. */
  protected fields(): DeviceFields {
    return {
      name: fieldValue(this, '[data-field="name"]'),
      room: this.roomValue(),
      spot: fieldValue(this, '[data-field="spot"]'),
      serial: fieldValue(this, '[data-field="serial"]'),
      installedAt: fieldValue(this, '[data-field="installed-at"]'),
    }
  }

  /**
   * The message for a field, when that is the field the last attempt failed on.
   *
   * The callout above the form says what went wrong; this puts the same sentence next to the
   * control that caused it, which is what stops the user hunting across six of them.
   * `DraftField` being a closed union is what makes a new field a type error here rather than
   * a silent gap.
   *
   * Translated from the error's `problem` rather than taken from its `message`: the message is
   * English, decided in `core`, which holds no locale (#75).
   */
  protected messageFor(field: DraftField): string | undefined {
    return this.error?.field === field ? problemMessage(this.error.problem) : undefined
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

  /**
   * The callout above the form, or nothing when the last attempt was fine.
   *
   * Two different failures, deliberately two different callouts. "This field is wrong" is
   * something the user can act on by fixing it; "storage refused the write" is not their
   * mistake at all, and dressing the second up as the first sends them hunting through
   * controls that were all correct.
   */
  protected renderError(): TemplateResult | '' {
    if (this.error !== undefined) {
      return html`
        <wa-callout variant="danger" data-error>
          <wa-icon slot="icon" name="circle-exclamation"></wa-icon>
          ${problemMessage(this.error.problem)}
        </wa-callout>
      `
    }

    if (this.roomsFailed) {
      return html`
        <wa-callout variant="warning" data-rooms-failed>
          <wa-icon slot="icon" name="triangle-exclamation"></wa-icon>
          ${msg('The rooms already in this catalogue could not be read, so none are suggested below. You can still type a room name.')}
        </wa-callout>
      `
    }

    if (this.saveFailed) {
      return html`
        <wa-callout variant="danger" data-save-failed>
          <wa-icon slot="icon" name="triangle-exclamation"></wa-icon>
          ${msg('Could not save to this browser’s storage. Everything you entered is still here — try again. If it keeps failing, the browser may be out of space.')}
        </wa-callout>
      `
    }

    return ''
  }

  /** The five controls both forms have, in the order both forms show them. */
  protected renderFields(): TemplateResult {
    return html`
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
    `
  }
}
