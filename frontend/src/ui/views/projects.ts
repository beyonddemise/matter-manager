import { msg, str, updateWhenLocaleChanges } from '@lit/localize'
import { html, LitElement, nothing, type TemplateResult } from 'lit'
import type { LocalProjectEntry } from '../../data/index.js'
import { DEFAULT_PLAN, showsUpgrade } from '../../domain/plan.js'
import { projects } from '../composition.js'
import { writeCurrentProjectId } from '../current-project.js'
import { currentProjectDatabaseName, useProjectDatabase } from '../db/project-database.js'
import {
  createLocalProject,
  indexServerProject,
  localProjectDefaults,
  renameLocalProject,
  setLocalClient,
} from '../local-projects.js'
import {
  type ActionSync,
  type CurrentTarget,
  ProjectActionError,
  type ProjectActions,
  projectActions,
} from '../project-actions.js'
import { beginProjectAction } from '../project-busy.js'
import {
  createProject,
  type NewProject,
  type Project,
  ProjectCreationError,
  type ProjectPatch,
  type ProjectsApi,
  ProjectUpdateError,
  updateProject,
} from '../projects.js'
import {
  type ProjectsInput,
  type ProjectsModel,
  projectsModel,
  type Row,
} from '../projects-model.js'
import {
  type Confirmation,
  needsConfirmation,
  renderActionsMenu,
  renderConfirmDialog,
} from './project-action-menu.js'
import { clearFields, fieldValue, replicated, type Sort, sortRows } from './projects-helpers.js'
import {
  locationText,
  type MenuAction,
  openRefusalText,
  overLimitText,
  reasonText,
} from './projects-text.js'

/**
 * The projects page: what this device and the server hold, and the way into each project.
 *
 * **It renders `projectsModel` and decides nothing.** Whether a row may be opened or renamed,
 * whether a project may be created and where it goes, which layout the plan sees — every one of
 * those answers comes from the model, refusal reason included. The page only turns answers into
 * markup and reasons into sentences ({@link reasonText}), so a rule changes in the model and its
 * tests, and nowhere here.
 *
 * Usable on its own: everything it reads arrives through {@link ProjectsView.input} and
 * everything it does goes through an injectable seam, which the shell wires to the real things
 * and a test to fakes. After every change it asks its host to {@link ProjectsView.refresh} the
 * inputs rather than patching them itself, so the page never shows a list nobody has read back.
 *
 * Promoting, downloading and removing go through each row's actions menu
 * (`project-action-menu.ts`), and run in `project-actions.ts`; removals are confirmed first.
 *
 * @module
 */

/**
 * The longest name or client the contract accepts (`openapi.yaml`, `maxLength: 200`). Enforced
 * by the fields, so a local-only project cannot hold a name its promotion would be refused for.
 */
const TEXT_MAX_LENGTH = 200

/** The local-only project operations the page performs. Injectable so a test owns no database. */
export interface LocalProjects {
  create(request: NewProject): Promise<LocalProjectEntry>
  rename(dbName: string, name: string): Promise<void>
  /** `undefined` clears the client. */
  setClient(dbName: string, client: string | undefined): Promise<void>
  /** Lists (or updates the listing of) this device's copy of a server project. */
  indexServerProject(project: Project): Promise<void>
}

/** The real operations, wrapped so the functions' optional dependency parameter stays unset. */
const LOCAL_PROJECTS: LocalProjects = {
  create: (request) => createLocalProject(request),
  rename: (dbName, name) => renameLocalProject(dbName, name),
  setClient: (dbName, client) => setLocalClient(dbName, client),
  indexServerProject: (project) => indexServerProject(project),
}

/**
 * Replication when the host has given none: nothing replicates and nothing can be pushed, so
 * every action that needs a push refuses rather than destroying anything.
 */
const NO_SYNC: ActionSync = {
  set: () => {},
  pushNow: async () => {
    throw new Error('Nothing is being synchronized.')
  },
  suspend: () => {},
  resume: () => {},
}

/** What the page shows before its host has said anything: a signed-out device with nothing. */
const NOTHING_YET: ProjectsInput = {
  local: [],
  server: undefined,
  plan: DEFAULT_PLAN,
  session: 'signed-out',
  online: true,
  syncStates: () => undefined,
}

/** The projects page. See the module comment. */
export class ProjectsView extends LitElement {
  /** Light DOM, like every view: Web Awesome's layout utilities are global selectors. */
  protected override createRenderRoot(): HTMLElement {
    return this
  }

  static override properties = {
    input: { attribute: false },
    api: { attribute: false },
    sync: { attribute: false },
    localProjects: { attribute: false },
    navigate: { attribute: false },
    refresh: { attribute: false },
    actions: { attribute: false },
    busy: { state: true },
    confirming: { state: true },
    typed: { state: true },
    error: { state: true },
    editing: { state: true },
    adding: { state: true },
    sort: { state: true },
  }

  /** What the model is computed from. Set by the shell; a signed-out empty device until then. */
  declare input: ProjectsInput
  /** The API. Unset in the application, where it reaches the real one. */
  declare api?: ProjectsApi
  /**
   * Replication, so a project created on the server gets its local copy at once, and the pushes
   * and holds that promoting and removing need. Unset, a copy starts when the host next hands
   * replication its list — which it builds from the same index — and every push refuses.
   */
  declare sync?: ActionSync
  /** Local-only project operations. Unset in the application, where they reach the real ones. */
  declare localProjects?: LocalProjects
  /** Where Open goes. Unset in the application, where it sets the location hash. */
  declare navigate?: (hash: string) => void
  /**
   * Asks the host to read the inputs again — the local index and the server list — and to set
   * {@link input}. Resolves once it has. Called after every change the page makes.
   */
  declare refresh?: () => Promise<void>
  /** Promote, download and the removals. Unset in the application, where they are the real ones. */
  declare actions?: ProjectActions

  /** Whether an action is running. Every control that starts one is disabled meanwhile. */
  declare busy: boolean
  /** The last action's failure, as a sentence. Cleared when the next one starts. */
  declare error: string | undefined
  /** The key of the row whose name is being edited. */
  declare editing: string | undefined
  /** Whether the pro plan's "Add project" dialog is open. */
  declare adding: boolean
  declare sort: Sort
  /** The removal being confirmed, if any. */
  declare confirming: Confirmation | undefined
  /** What has been typed into the delete confirmation's name field. */
  declare typed: string

  constructor() {
    super()
    updateWhenLocaleChanges(this)
    this.input = NOTHING_YET
    this.busy = false
    this.error = undefined
    this.editing = undefined
    this.adding = false
    this.sort = { by: 'name', ascending: true }
    this.confirming = undefined
    this.typed = ''
  }

  /**
   * Runs one action: busy while it runs, its failure shown as a sentence afterwards.
   *
   * Only the API's failures carry a reason; anything else is a fault in this device (a database
   * that would not write), reported generically and logged, because there is no sentence that
   * would tell the reader what to do about it.
   */
  private async run(action: () => Promise<void>): Promise<void> {
    this.busy = true
    this.error = undefined
    try {
      await action()
    } catch (error) {
      if (
        error instanceof ProjectCreationError ||
        error instanceof ProjectUpdateError ||
        error instanceof ProjectActionError
      ) {
        this.error = reasonText(error.reason)
      } else {
        console.error('A projects page action failed.', error)
        this.error = msg('That did not work. Please try again.')
      }
    } finally {
      this.busy = false
    }
  }

  /**
   * Creates a project where the model says it goes.
   *
   * On the server: `POST /projects`, then the copy is indexed and handed to replication, so it
   * reads "Synchronized" and opens offline from the start. Replication is given **every**
   * synchronized project, not only the new one, because `SyncManager.set` makes the running
   * set match its argument exactly — handing it one would stop all the others.
   *
   * Reads the name (and, in the dialog, the client) from `form`, and empties it once the project
   * exists, so the same form never offers to create it twice.
   *
   * @returns whether it was created
   */
  private async create(form: Element | null): Promise<boolean> {
    const name = fieldValue(form, 'name')
    const client = fieldValue(form, 'client')
    if (name === '') {
      this.error = msg('Give the project a name.')
      return false
    }
    const model = this.model()
    if (!model.canCreate.allowed) return false

    let created = false
    await this.run(async () => {
      const request: NewProject = { name, ...(client === '' ? {} : { client }) }
      if (model.createTarget === 'synced') {
        const project = await createProject(
          { api: this.api ?? projects(), online: () => this.input.online },
          request,
        )
        // Held as a project action (`project-busy.ts`): a shell refresh between the two would
        // hand replication a list read before the copy was indexed, stopping the new copy.
        const end = beginProjectAction()
        try {
          await this.locals().indexServerProject(project)
          this.sync?.set(replicated(model, project))
        } finally {
          end()
        }
      } else {
        await this.locals().create(request)
      }
      created = true
      clearFields(form)
      await this.refresh?.()
    })
    return created
  }

  /**
   * Saves a name, and in the pro layout a client, for one row.
   *
   * Only what changed is written: a local-only project through its `project` document and index
   * entry, a server project through `PATCH`, after which this device's listing of its copy is
   * brought up to date from the answer. An empty client clears it (`null` on the server).
   */
  private async save(row: Row, form: Element | null): Promise<void> {
    // The pen is disabled when renaming is refused, but the inputs can change while the form is
    // open (the connection drops), and the model is the authority, not the button.
    if (!row.actions.rename.allowed) return
    const name = fieldValue(form, 'name')
    const hasClient = form?.querySelector('[data-field="client"]') != null
    const client = hasClient ? fieldValue(form, 'client') : undefined
    if (name === '') {
      this.error = msg('Give the project a name.')
      return
    }
    const nameChanged = name !== row.name
    const clientChanged = client !== undefined && client !== (row.client ?? '')

    await this.run(async () => {
      if (row.projectId === undefined) {
        if (nameChanged) await this.locals().rename(row.dbName, name)
        if (clientChanged) await this.locals().setClient(row.dbName, client || undefined)
      } else if (nameChanged || clientChanged) {
        const patch: ProjectPatch = {
          ...(nameChanged ? { name } : {}),
          ...(clientChanged ? { client: client || null } : {}),
        }
        const updated = await updateProject(
          { api: this.api ?? projects(), online: () => this.input.online },
          row.projectId,
          patch,
        )
        if (row.location === 'synced') await this.locals().indexServerProject(updated)
      }
      this.editing = undefined
      if (nameChanged || clientChanged) await this.refresh?.()
    })
  }

  /**
   * Makes a row the current project and goes to its devices.
   *
   * Remembered by project id when it has one, by database name while it is local-only — the only
   * name a local-only project has. Opened with the model's `editable`, which is how a lapsed
   * owner's server project comes to be read-only.
   */
  private open(row: Row): void {
    if (!row.actions.open.allowed) return
    select({ dbName: row.dbName, id: row.projectId ?? row.dbName, editable: row.editable })
    const navigate =
      this.navigate ??
      ((hash: string) => {
        window.location.hash = hash
      })
    navigate('#/devices')
  }

  /**
   * Starts a menu action: promoting and downloading at once, a removal by asking first.
   * Ignored while another action runs; the menu is disabled then, but a click can race it.
   */
  private choose(row: Row, action: MenuAction): void {
    if (this.busy || !row.actions[action].allowed) return
    this.error = undefined
    if (needsConfirmation(action)) {
      this.typed = ''
      this.confirming = { action, row }
      return
    }
    const model = this.model()
    void this.run(() =>
      action === 'promote'
        ? this.projectActions().promote(model, row)
        : this.projectActions().download(model, row),
    )
  }

  /**
   * Runs the removal being confirmed, against the row as the page shows it **now**: the inputs
   * may have changed while the dialog was open, and the model is the authority, not the dialog.
   * A row that is gone by then (removed, promoted, archived elsewhere) is said to have changed,
   * rather than the dialog closing as if it had worked. The dialog closes once it is done, so a
   * failure is read on the page.
   */
  private async confirm(): Promise<void> {
    const asked = this.confirming
    if (asked === undefined || this.busy) return
    const model = this.model()
    const row = [...model.owned, ...model.shared].find((r) => r.key === asked.row.key)
    const actions = this.projectActions()
    if (row === undefined) {
      this.error = msg('This project changed — try again')
      this.confirming = undefined
      return
    }
    await this.run(async () => {
      if (asked.action === 'removeLocal') await actions.removeLocalCopy(model, row)
      else if (asked.action === 'removeServer') await actions.removeFromServer(model, row)
      else await actions.deleteLocalProject(model, row, this.typed)
    })
    this.confirming = undefined
  }

  /** The actions, or the real ones over the page's seams. */
  private projectActions(): ProjectActions {
    return (
      this.actions ??
      projectActions({
        api: this.api ?? projects(),
        // The browser is asked as well as the input: the input may be a render old, and a
        // `false` from `navigator.onLine` is the one answer it gives that can be trusted.
        online: () => this.input.online && navigator.onLine,
        sync: this.sync ?? NO_SYNC,
        local: localProjectDefaults,
        currentDatabase: currentProjectDatabaseName,
        switchTo: select,
        refresh: async () => {
          await this.refresh?.()
        },
      })
    )
  }

  private locals(): LocalProjects {
    return this.localProjects ?? LOCAL_PROJECTS
  }

  private model(): ProjectsModel {
    return projectsModel(this.input)
  }

  override render(): TemplateResult {
    const model = this.model()
    return html`
      <section class="wa-stack wa-gap-l app-projects">
        <h1>${msg('Projects')}</h1>
        ${this.renderHints(model)}
        ${
          this.error === undefined
            ? nothing
            : html`<wa-callout variant="danger" data-error>
                <wa-icon slot="icon" name="circle-exclamation"></wa-icon>
                ${this.error}
              </wa-callout>`
        }
        ${
          model.layout === 'free'
            ? this.renderFree(model)
            : model.layout === 'member'
              ? this.renderMember(model)
              : this.renderPro(model)
        }
        ${
          model.shared.length === 0
            ? nothing
            : html`<section class="wa-stack wa-gap-s" data-shared>
                <h2>${msg('Shared with me')}</h2>
                ${
                  model.layout === 'pro'
                    ? this.renderTable(model.shared, false)
                    : html`<ul class="wa-stack wa-gap-s app-project-slots">
                        ${model.shared.map((row) => this.renderListRow(row))}
                      </ul>`
                }
              </section>`
        }
        ${renderConfirmDialog(this.confirming, {
          busy: this.busy,
          typed: this.typed,
          onType: (typed) => {
            this.typed = typed
          },
          onConfirm: () => void this.confirm(),
          onCancel: () => {
            if (!this.busy) this.confirming = undefined
          },
        })}
      </section>
    `
  }

  /** The page-wide sentences: no session, offline, over the limit. */
  private renderHints(model: ProjectsModel): TemplateResult {
    const { session, online } = this.input
    return html`
      ${
        // Not while the session is still being checked: the reader may well be signed in.
        session === 'signed-in' || session === 'checking'
          ? nothing
          : html`<wa-callout variant="neutral" data-hint="signed-out">
              <wa-icon slot="icon" name="circle-info"></wa-icon>
              ${msg('Sign in to sync')}
            </wa-callout>`
      }
      ${
        session === 'signed-in' && !online
          ? html`<p class="app-empty" data-hint="offline">
              ${msg('Offline: new projects stay on this device for now.')}
            </p>`
          : nothing
      }
      ${
        model.overLimit
          ? html`<wa-callout variant="neutral" data-over-limit>
              <wa-icon slot="icon" name="circle-info"></wa-icon>
              ${overLimitText(model.limit, model.ownedCount)}
            </wa-callout>`
          : nothing
      }
    `
  }

  /**
   * Why a project cannot be created, beside the control that would create it — unless the page
   * already said so: signed out is the page-wide hint, over the limit its own sentence.
   */
  private renderCreateReason(model: ProjectsModel): TemplateResult | typeof nothing {
    const { reason } = model.canCreate
    if (reason === undefined || reason === 'signed-out' || model.overLimit) return nothing
    return html`<p class="app-empty" data-create-reason>${reasonText(reason)}</p>`
  }

  /**
   * Free: one card. Naming the first-run project comes first, because until it has a name there
   * is nothing to "continue with"; with no project, the card creates one.
   */
  private renderFree(model: ProjectsModel): TemplateResult {
    if (model.needsName !== undefined) return this.renderNameCard(model.needsName)
    if (model.owned.length === 0) return this.renderCreateCard(model)
    return html`
      ${model.owned.map((row) => this.renderProjectCard(row))}
      ${
        showsUpgrade(this.input.plan)
          ? html`<p class="app-empty" data-upgrade-hint>
              ${msg('Upgrade to keep your projects in sync across devices, and to have more than one.')}
            </p>`
          : nothing
      }
    `
  }

  private renderCreateCard(model: ProjectsModel): TemplateResult {
    return html`
      <wa-card data-create-card class="app-form">
        <div class="wa-stack wa-gap-m">
          <h2>${msg('Create your project')}</h2>
          <wa-input data-field="name" maxlength=${TEXT_MAX_LENGTH} label=${msg('Name')}></wa-input>
          ${this.renderCreateReason(model)}
          <wa-button
            data-create
            variant="brand"
            ?disabled=${!model.canCreate.allowed || this.busy}
            @click=${(event: Event) => this.create(this.containerOf(event, '[data-create-card]'))}
          >
            ${msg('Create')}
          </wa-button>
        </div>
      </wa-card>
    `
  }

  /** First run: the adopted catalogue has no name yet, and it is the one thing to ask. */
  private renderNameCard(row: Row): TemplateResult {
    return html`
      <wa-card data-name-project class="app-form">
        <div class="wa-stack wa-gap-m">
          <h2>${msg('Name your project')}</h2>
          <p>${msg('Everything recorded on this device so far is in it.')}</p>
          <wa-input data-field="name" maxlength=${TEXT_MAX_LENGTH} label=${msg('Name')}></wa-input>
          <wa-button
            data-save
            variant="brand"
            ?disabled=${this.busy}
            @click=${(event: Event) => this.save(row, this.containerOf(event, '[data-name-project]'))}
          >
            ${msg('Save')}
          </wa-button>
        </div>
      </wa-card>
    `
  }

  private renderProjectCard(row: Row): TemplateResult {
    return html`
      <wa-card data-row=${row.key} class="app-form">
        <div class="wa-stack wa-gap-m">
          ${
            // Not inside the heading while editing: a form is not a heading's content.
            this.editing === row.key
              ? this.renderName(row, false)
              : html`<h2 class="wa-cluster wa-gap-xs">${this.renderName(row, false)}</h2>`
          }
          <div class="wa-cluster wa-gap-2xs">
            ${
              row.actions.open.allowed
                ? html`<wa-button data-open variant="brand" @click=${() => this.open(row)}>
                    ${msg(str`Continue with “${row.name}”`)}
                  </wa-button>`
                : nothing
            }
            ${renderActionsMenu(row, this.busy, (action) => this.choose(row, action), [
              'promote',
              'download',
            ])}
          </div>
          ${this.renderRowNote(row)}
        </div>
      </wa-card>
    `
  }

  /**
   * Member: exactly as many rows as the plan allows. The empty ones are where projects are
   * created, so "how many more can I have" is answered by looking rather than by a number.
   */
  private renderMember(model: ProjectsModel): TemplateResult {
    const free =
      model.overLimit || model.limit < 0 ? 0 : Math.max(0, model.limit - model.ownedCount)
    return html`
      ${this.renderCreateReason(model)}
      <ul class="wa-stack wa-gap-s app-project-slots">
        ${model.owned.map((row) => this.renderListRow(row))}
        ${Array.from({ length: free }, () => this.renderEmptySlot(model))}
      </ul>
    `
  }

  private renderEmptySlot(model: ProjectsModel): TemplateResult {
    return html`
      <li data-slot-empty class="wa-flank:end wa-gap-s app-project-slot">
        <!-- The label is for assistive technology only: the placeholder says the same thing,
             and a visible one would make an empty slot twice as tall as a filled one. -->
        <wa-input
          data-field="name"
          class="wa-visually-hidden-label"
          maxlength=${TEXT_MAX_LENGTH}
          label=${msg('New project')}
          placeholder=${msg('New project name')}
          ?disabled=${!model.canCreate.allowed}
        ></wa-input>
        <wa-button
          data-create
          appearance="filled-outlined"
          ?disabled=${!model.canCreate.allowed || this.busy}
          @click=${(event: Event) => this.create(this.containerOf(event, '[data-slot-empty]'))}
        >
          ${msg('Create')}
        </wa-button>
      </li>
    `
  }

  private renderListRow(row: Row): TemplateResult {
    return html`
      <li data-row=${row.key} class="wa-flank:end wa-gap-s app-project-slot">
        <div class="wa-cluster wa-gap-xs">
          <div class="wa-cluster wa-gap-2xs app-project-name">${this.renderName(row, false)}</div>
          ${this.renderLocation(row)} ${this.renderSync(row)} ${this.renderRowNote(row)}
        </div>
        <div class="wa-cluster wa-gap-2xs app-row-actions">
          ${this.renderOpen(row)} ${this.renderMenu(row)}
        </div>
      </li>
    `
  }

  /** Pro: a table, because at this many projects the reader is looking one up. */
  private renderPro(model: ProjectsModel): TemplateResult {
    return html`
      ${
        model.overLimit
          ? nothing
          : html`<div class="wa-cluster wa-gap-s">
              <wa-button
                data-add-project
                variant="brand"
                ?disabled=${!model.canCreate.allowed || this.busy}
                @click=${() => {
                  this.error = undefined
                  this.adding = true
                }}
              >
                <wa-icon slot="start" name="plus"></wa-icon>
                ${msg('Add project')}
              </wa-button>
              ${this.renderCreateReason(model)}
            </div>`
      }
      ${this.renderTable(model.owned, true)} ${this.renderAddDialog(model)}
    `
  }

  /**
   * A table of rows, sorted as the reader chose. Only the owned table sorts: the shared one is
   * short, and two sets of sort controls on one page would leave the reader unsure which applied.
   */
  private renderTable(rows: readonly Row[], sortable: boolean): TemplateResult {
    const sorted = sortable ? sortRows(rows, this.sort) : rows
    return html`
      <wa-scroller><table class="app-projects-table">
        <thead>
          <tr>
            ${this.renderSortHeader('name', msg('Name'), sortable)}
            ${this.renderSortHeader('client', msg('Client'), sortable)}
            <th scope="col" class="app-col-fit">${msg('Location')}</th>
            <th scope="col" class="app-col-fit">${msg('Sync')}</th>
            <th scope="col" class="app-col-fit app-col-end">${msg('Actions')}</th>
          </tr>
        </thead>
        <tbody>
          ${sorted.map(
            (row) => html`
              <tr data-row=${row.key}>
                <td>
                  <div class="wa-stack wa-gap-3xs">
                    <div class="wa-cluster wa-gap-2xs app-project-name">${this.renderName(row, true)}</div>
                    ${this.renderRowNote(row)}
                  </div>
                </td>
                <td data-client>${this.editing === row.key ? nothing : (row.client ?? nothing)}</td>
                <td class="app-col-fit">${this.renderLocation(row)}</td>
                <td class="app-col-fit">${this.renderSync(row)}</td>
                <td class="app-col-fit app-col-end">
                  <div class="wa-cluster wa-gap-2xs wa-justify-content-end app-row-actions">
                    ${this.renderOpen(row)} ${this.renderMenu(row)}
                  </div>
                </td>
              </tr>
            `,
          )}
        </tbody>
      </table></wa-scroller>
    `
  }

  private renderSortHeader(by: Sort['by'], label: string, sortable: boolean): TemplateResult {
    if (!sortable) return html`<th scope="col">${label}</th>`
    const active = this.sort.by === by
    const direction = active ? (this.sort.ascending ? 'ascending' : 'descending') : 'none'
    return html`
      <th scope="col" aria-sort=${direction}>
        <wa-button
          data-sort=${by}
          class="app-sort"
          appearance="plain"
          size="s"
          @click=${() => {
            this.sort = { by, ascending: active ? !this.sort.ascending : true }
          }}
        >
          ${label}
          ${
            // The inactive column shows that it can be sorted, quietly; the active one which way.
            !active
              ? html`<wa-icon slot="end" name="sort" class="app-sort-idle"></wa-icon>`
              : this.sort.ascending
                ? html`<wa-icon slot="end" name="sort-up"></wa-icon>`
                : html`<wa-icon slot="end" name="sort-down"></wa-icon>`
          }
        </wa-button>
      </th>
    `
  }

  private renderAddDialog(model: ProjectsModel): TemplateResult {
    return html`
      <wa-dialog
        data-add-dialog
        label=${msg('Add project')}
        ?open=${this.adding}
        @wa-after-hide=${(event: Event) => {
          // Only the dialog's own hide: a tooltip or select inside it fires the same event.
          if (event.target === event.currentTarget) this.adding = false
        }}
      >
        <div class="wa-stack wa-gap-m">
          <wa-input
            data-field="name"
            maxlength=${TEXT_MAX_LENGTH}
            label=${msg('Name')}
            autofocus
          ></wa-input>
          <wa-input data-field="client" maxlength=${TEXT_MAX_LENGTH} label=${msg('Client (optional)')}></wa-input>
          ${this.renderCreateReason(model)}
        </div>
        <wa-button slot="footer" data-cancel appearance="outlined" @click=${() => {
          this.adding = false
        }}>
          ${msg('Cancel')}
        </wa-button>
        <wa-button
          slot="footer"
          data-create
          variant="brand"
          ?disabled=${!model.canCreate.allowed || this.busy}
          @click=${async (event: Event) => {
            const dialog = this.containerOf(event, '[data-add-dialog]')
            const done = await this.create(dialog)
            if (done) this.adding = false
          }}
        >
          ${msg('Create')}
        </wa-button>
      </wa-dialog>
    `
  }

  /**
   * A row's name and its pen, or the form that edits them. The pro layout edits the client too;
   * the others have no client column to show it in.
   */
  private renderName(row: Row, withClient: boolean): TemplateResult {
    if (this.editing === row.key) {
      return html`
        <div data-rename-form class="wa-cluster wa-gap-xs">
          <wa-input data-field="name" maxlength=${TEXT_MAX_LENGTH} label=${msg('Name')} value=${row.name}></wa-input>
          ${
            withClient
              ? html`<wa-input
                  data-field="client"
                  maxlength=${TEXT_MAX_LENGTH}
                  label=${msg('Client')}
                  value=${row.client ?? ''}
                ></wa-input>`
              : nothing
          }
          <wa-button
            data-save
            variant="brand"
            size="s"
            ?disabled=${this.busy}
            @click=${(event: Event) => this.save(row, this.containerOf(event, '[data-rename-form]'))}
          >
            ${msg('Save')}
          </wa-button>
          <wa-button
            data-cancel
            size="s"
            @click=${() => {
              this.editing = undefined
            }}
          >
            ${msg('Cancel')}
          </wa-button>
        </div>
      `
    }
    const rename = row.actions.rename
    return html`
      <span data-name>${row.name === '' ? msg('Unnamed project') : row.name}</span>
      <wa-button
        data-rename
        appearance="plain"
        size="s"
        ?disabled=${!rename.allowed || this.busy}
        title=${rename.reason === undefined ? nothing : reasonText(rename.reason)}
        @click=${() => {
          this.error = undefined
          this.editing = row.key
        }}
      >
        <wa-icon name="pen" label=${msg('Rename')}></wa-icon>
      </wa-button>
    `
  }

  private renderMenu(row: Row): TemplateResult | typeof nothing {
    return renderActionsMenu(row, this.busy, (action) => this.choose(row, action))
  }

  private renderOpen(row: Row): TemplateResult | typeof nothing {
    if (!row.actions.open.allowed) return nothing
    return html`<wa-button data-open size="s" appearance="filled-outlined" @click=${() => this.open(row)}>
      ${msg('Open')}
    </wa-button>`
  }

  /**
   * One short note per row saying what it cannot do and why: opening first, since a row that
   * cannot be opened has nothing else worth saying; then renaming, the other action on the row.
   */
  private renderRowNote(row: Row): TemplateResult | typeof nothing {
    const { open, rename } = row.actions
    const note =
      open.reason !== undefined
        ? openRefusalText(open.reason)
        : rename.reason !== undefined
          ? reasonText(rename.reason)
          : ''
    return note === '' ? nothing : html`<span class="app-empty" data-note>${note}</span>`
  }

  private renderLocation(row: Row): TemplateResult {
    return html`<wa-tag data-location size="s" variant=${row.location === 'synced' ? 'success' : 'neutral'}>
      ${locationText(row.location)}
    </wa-tag>`
  }

  /**
   * The live replication state, when there is one. Waiting is neutral, never danger: offline is
   * ordinary here and the local copy is complete. A refusal is a warning, worded as what it
   * means for this project — an archived one is simply read-only now.
   */
  private renderSync(row: Row): TemplateResult | typeof nothing {
    const state = row.syncState
    if (state === undefined) return nothing
    switch (state) {
      case 'idle':
        return html`<wa-tag data-sync size="s" variant="success">${msg('Up to date')}</wa-tag>`
      case 'active':
        return html`<wa-tag data-sync size="s" variant="neutral">${msg('Syncing')}</wa-tag>`
      case 'offline':
        return html`<wa-tag data-sync size="s" variant="neutral">${msg('Waiting to sync')}</wa-tag>`
      case 'stopped':
        return html`<wa-tag data-sync size="s" variant="neutral">${msg('Not syncing')}</wa-tag>`
      case 'denied':
        return html`<wa-tag data-sync size="s" variant="warning">
          ${row.archived ? msg('Archived — read-only') : msg('No permission to sync')}
        </wa-tag>`
    }
  }

  /** The element around a clicked control that holds its fields. */
  private containerOf(event: Event, selector: string): Element | null {
    return (event.currentTarget as Element | null)?.closest(selector) ?? null
  }
}

/**
 * Makes a project the current one: remembered by project id when it has one, by database name
 * while it is local-only — the only name a local-only project has — and opened with the model's
 * `editable`, which is how a lapsed owner's server project comes to be read-only.
 */
function select(target: CurrentTarget): void {
  writeCurrentProjectId(() => localStorage, target.id)
  useProjectDatabase(target.dbName, target.editable)
}

customElements.define('projects-view', ProjectsView)
