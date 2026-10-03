import { msg, updateWhenLocaleChanges } from '@lit/localize'
import { html, LitElement, type TemplateResult } from 'lit'
import { DEFAULT_PLAN, showsUpgrade } from '../domain/plan.js'
import {
  beginSignIn,
  endSession,
  followProfileLocale,
  projectSync,
  projects,
  requestTokens,
  type TokenOutcome,
} from './composition.js'
import { browserConnectivity, type ConnectivitySource, watchConnectivity } from './connectivity.js'
import {
  readCurrentProjectId,
  resolveCurrentProject,
  writeCurrentProjectId,
} from './current-project.js'
import { localDatabase, useProjectDatabase } from './db/project-database.js'
import { negotiateLocale } from './i18n/locale.js'
import { activateLocale } from './i18n/localization.js'
import {
  adoptLegacyCatalogue,
  type LocalProjectDependencies,
  localProjectDefaults,
} from './local-projects.js'
import { fetchProjectList, type ProjectFacts, readProjectFacts } from './project-inputs.js'
import type { Project } from './projects.js'
import { type ProjectsInput, projectsModel, synchronizedProjects } from './projects-model.js'
import { matchRoute } from './router/match.js'
import { NAV_ROUTES, ROUTES } from './router/routes.js'
import {
  applyScheme,
  readPreference,
  resolveScheme,
  type SchemePreference,
  writePreference,
} from './scheme.js'
import { type SessionState, sessionExpired } from './session.js'
import type { SyncManager } from './sync/manager.js'
import type { SyncState } from './sync/replication.js'
import { startRefresher } from './token-refresher.js'
import { forgetTokens, pouchRefreshTokenStore } from './tokens.js'
import { applyUpdate } from './updates.js'
import './views/add-device.js'
import './views/rooms.js'
import './views/device-list.js'
import './views/device.js'
import './views/edit-device.js'
import './views/not-found.js'
import './views/projects.js'
import './views/settings.js'

/**
 * The public website: what Matter Manager is, its privacy notice and its terms.
 *
 * Absolute, because the application and the website are separate deployments on separate
 * hosts. A constant rather than configuration: a self-hosted instance is governed by its own
 * operator and the Apache-2.0 licence, not by these pages - whoever runs one and wants their
 * own notice changes this line.
 */
export const WEBSITE = 'https://www.matter-manager.io'

/**
 * View id to markup, given whatever the route captured.
 *
 * `Record<string, …>` accepts any key, so a route whose `view` has no entry here is not a type
 * error - it silently falls through to the not-found view at render time. The actual guard
 * against that drift is the hand-maintained assertion in `routes.test.ts` that every registered
 * route's view exists.
 *
 * Every entry takes the parameters even where it ignores them, so adding a parameter to an
 * existing route is a change to one line rather than to this signature.
 */
type ViewParams = Readonly<Record<string, string>>

/**
 * What a view may ask of the shell that renders it. Only the projects page asks anything: its
 * inputs (the index, the server list, the session, replication) are the shell's state.
 */
export interface ViewHost {
  /** The projects page, wired to the shell's state and replication. */
  renderProjects(): TemplateResult
}

export const VIEWS: Readonly<
  Record<string, (params: ViewParams, host: ViewHost) => TemplateResult>
> = {
  projects: (_params, host) => host.renderProjects(),
  'add-device': () => html`<add-device-view></add-device-view>`,
  device: (params) => html`<device-view uuid=${params.id ?? ''}></device-view>`,
  'device-list': () => html`<device-list-view></device-list-view>`,
  'edit-device': (params) => html`<edit-device-view uuid=${params.id ?? ''}></edit-device-view>`,
  rooms: () => html`<rooms-view></rooms-view>`,
  settings: () => html`<settings-view></settings-view>`,
}

/** What the projects page reads before the first refresh: a device holding nothing yet. */
const NO_FACTS: ProjectFacts = {
  local: [],
  server: undefined,
  serverStale: true,
  plan: DEFAULT_PLAN,
}

/**
 * Starts the real token refresher: the token exchange, a timer, and the browser's own `online`.
 *
 * Only a *regained* network triggers a retry. `watchConnectivity` reports the current state
 * immediately, which would be a second request on top of the one `startRefresher` makes by
 * itself, and a retry on going offline would only fail.
 */
function startRealRefresher(onOutcome: (outcome: TokenOutcome) => void): { stop(): void } {
  const store = pouchRefreshTokenStore(localDatabase())
  return startRefresher({
    request: (signal) => requestTokens(store, fetch, signal),
    onOutcome,
    schedule: (run, ms) => {
      const timer = setTimeout(run, ms)
      return () => clearTimeout(timer)
    },
    onVisible: (run) => {
      const onChange = () => {
        if (document.visibilityState === 'visible') run()
      }
      document.addEventListener('visibilitychange', onChange)
      return () => document.removeEventListener('visibilitychange', onChange)
    },
    onOnline: (run) => {
      let first = true
      return watchConnectivity(browserConnectivity(), (online) => {
        if (first) {
          first = false
          return
        }
        if (online) run()
      })
    },
  })
}

/**
 * The cycle order for the scheme toggle: light → dark → system → light.
 *
 * Three stops, not two - the design explicitly calls for "follow the system" to be a
 * reachable choice from the header control, not just the unset default. Collapsing the
 * button to a light/dark flip (as an earlier version did) makes "system" a state a user can
 * fall out of but never choose again through the UI.
 */
const SCHEME_CYCLE: readonly SchemePreference[] = ['light', 'dark', 'system']

/** Icon for each scheme preference, so the button's own icon shows what is currently applied. */
const SCHEME_ICON: Readonly<Record<SchemePreference, string>> = {
  light: 'sun',
  dark: 'moon',
  system: 'circle-half-stroke',
}

/**
 * The application shell.
 *
 * `<wa-page>` owns the layout, the sticky regions, the desktop sidebar and the mobile drawer.
 * Navigation is written once into `slot="navigation"` and rendered in both views by the
 * component; there is deliberately no second copy and no hand-rolled drawer.
 */
export class AppShell extends LitElement implements ViewHost {
  /**
   * Light DOM, and this is load-bearing rather than a preference.
   *
   * `<wa-page>` reads `--menu-width` and its own `view` attribute from document CSS, and the
   * `wa-stack` / `wa-cluster` / `wa-split` / `wa-mobile-only` utilities are global selectors.
   * None of that crosses a shadow boundary. Custom properties *do* inherit, so a shadow root
   * yields a page where the tokens look right and the layout silently does not happen.
   */
  protected override createRenderRoot(): HTMLElement {
    return this
  }

  static override properties = {
    session: { state: true },
    syncing: { state: true },
    facts: { state: true },
    signingOut: { state: true },
    upgrading: { state: true },
    refresher: { attribute: false },
    sessionEndedNotice: { state: true },
    listProjects: { attribute: false },
    makeSync: { attribute: false },
    followLocale: { attribute: false },
    signIn: { attribute: false },
    signOutOf: { attribute: false },
    hash: { state: true },
    schemePreference: { state: true },
    online: { state: true },
    updateReady: { attribute: false },
    connectivity: { attribute: false },
    takeUpdate: { attribute: false },
    projectStore: { attribute: false },
  }

  declare hash: string
  declare schemePreference: SchemePreference

  /**
   * What this browser believes about the session.
   *
   * `undefined` until the first answer arrives, which is why the control renders nothing at
   * first: offering "Sign in" to somebody who *is* signed in, for the moment it takes to find
   * out, is worse than offering nothing for that moment.
   */
  declare session: SessionState | undefined

  /**
   * What replication is doing across every project, or `undefined` when none is running.
   *
   * The worst state wins, because a summary that reported `idle` while one project was
   * unreachable would be reassuring and wrong. `offline` is not an error - the local database
   * is complete and usable - so it is shown as quietly as the connectivity tag beside it.
   */
  declare syncing: SyncState | undefined

  /**
   * What the projects page and the header are computed from: the local index, the server list
   * (fresh or remembered), and the cached plan and email. `undefined` until first read.
   */
  declare facts: ProjectFacts | undefined
  /** Whether the sign-out confirmation is open. */
  declare signingOut: boolean
  /** Whether the upgrade dialog is open. */
  declare upgrading: boolean
  /** Whether the "session ended" notice is showing. Dismissed by the reader, never by timeout. */
  declare sessionEndedNotice: boolean

  /** Injected by tests. Unset in the application, where these reach the real API. */
  declare refresher?: (onOutcome: (outcome: TokenOutcome) => void) => { stop(): void }
  declare listProjects?: () => Promise<readonly Project[]>
  declare makeSync?: (onState: (id: string, state: SyncState) => void) => SyncManager
  /**
   * Follows the profile's locale; `onCached` says the fetched profile is now in the cache, so the
   * email and plan are read again.
   */
  declare followLocale?: (
    onChange: (locale: string) => void,
    onCached?: () => void,
  ) => Promise<unknown>
  /**
   * The local index and databases: what is listed, and where the first-run catalogue is adopted.
   * Injected by tests, so they never touch what the application keeps; the real ones otherwise.
   */
  declare projectStore?: LocalProjectDependencies
  declare signIn?: () => void
  declare signOutOf?: (includeLocalCatalogue: boolean) => Promise<readonly string[]>
  /** What the browser last said about the network. See `connectivity.ts` on trusting it. */
  declare online: boolean
  /**
   * The worker waiting to take over, once there is one.
   *
   * Set from outside — `main.ts` owns the registration and watches it — rather than watched
   * from in here. The shell is where the update is *announced*; noticing one is a different
   * concern with different tests, and one that has to keep working if this component is ever
   * replaced.
   */
  declare updateReady: ServiceWorker | undefined
  /** Bound by a test to a network it controls; `window` otherwise. */
  declare connectivity?: ConnectivitySource
  /**
   * What accepting the update does.
   *
   * A seam, and a necessary one rather than a tidy one: the real thing schedules a reload of
   * the page it is running in. A test that called it would reload the test browser three
   * seconds later, out of the middle of whatever was running by then — a failure appearing in
   * an unrelated file, which is the worst kind to chase.
   */
  declare takeUpdate?: (waiting: ServiceWorker) => void

  private readonly onHashChange = () => {
    this.hash = window.location.hash
  }

  constructor() {
    super()
    // Every component that renders a `msg()` needs this, and a component that forgets keeps
    // its old strings while its neighbours change - a silent failure, hence the test in
    // `i18n.browser.test.ts` that switches locale and checks each view's text.
    updateWhenLocaleChanges(this)
    this.facts = undefined
    this.signingOut = false
    this.upgrading = false
    this.sessionEndedNotice = false
    this.hash = window.location.hash
    // Read once at construction. The write side (`cycleScheme`) keeps this field and
    // storage in sync itself, so there is no need to re-read on every render.
    this.schemePreference = readPreference(() => localStorage)
    this.online = true
    this.updateReady = undefined
  }

  private stopWatchingNetwork: (() => void) | undefined

  override connectedCallback(): void {
    super.connectedCallback()
    window.addEventListener('hashchange', this.onHashChange)
    this.stopWatchingNetwork = watchConnectivity(
      this.connectivity ?? browserConnectivity(),
      (online) => {
        const regained = online && !this.online
        this.online = online
        // The list may have changed while the connection was gone, and the page can only act on
        // a list this session heard (C-R5).
        if (regained && this.session === 'signed-in') void this.refreshProjects(true)
      },
    )

    // The index, the remembered list and the cached plan, and the first-run catalogue adopted:
    // none of it waits for the session, so the page is right offline from the first render.
    void this.refreshProjects(false)

    // Not awaited, and nothing waits for it. The application is local-first: every view works
    // without a session, so holding the shell back on a network request would delay the whole
    // interface to answer a question that changes one button.
    this.tokenRefresher = (this.refresher ?? startRealRefresher)((outcome) =>
      this.onTokenOutcome(outcome),
    )
  }

  private tokenRefresher: { stop(): void } | undefined

  /**
   * What the shell does with each answer from the refresher.
   *
   * `unreachable` changes nothing, deliberately: being offline is ordinary here, and the
   * refresher is already retrying. Replication starts on the *transition* into `signed-in`,
   * because `refreshed` arrives again before every expiry and a second manager built each time
   * would leak the first.
   */
  private onTokenOutcome(outcome: TokenOutcome): void {
    switch (outcome.kind) {
      case 'refreshed': {
        const wasSignedIn = this.session === 'signed-in'
        this.session = 'signed-in'
        if (!wasSignedIn) this.startSyncing()
        return
      }
      case 'signed-out':
        // Arriving after `signed-in`, this is a sign-out of this tab. This tab's exchange had no
        // refresh token to send, for one of two reasons: another tab signed out and removed the
        // stored token, or the local store could not be read (`read` reports an unreadable store
        // as no token). Either way this tab cannot renew its session. Treated as the expired path
        // without its notice — nothing was refused by the server — so replication stops and the
        // in-memory token goes. Local data stays: removing it is a sign-out's decision, not a
        // refresher's. On a first answer there is nothing running, and this only records the
        // state.
        if (this.session === 'signed-in') {
          this.endReplication()
          forgetTokens()
        }
        this.session = 'signed-out'
        // Re-read either way: on a first answer this is the page's session arriving, after a
        // sign-in it is this session's list going stale.
        void this.refreshProjects(false)
        return
      case 'ended':
        // Local data stays: `sessionExpired` forgets the in-memory access token and nothing
        // else. Replication is stopped because its token is now dead, and a manager retrying
        // with it would only produce 401s.
        this.endReplication()
        this.session = sessionExpired({ forgetTokens })
        this.sessionEndedNotice = true
        // No longer this session's list: the page falls back to the remembered one, stale.
        void this.refreshProjects(false)
        return
      case 'unreachable':
        return
    }
  }

  /**
   * Stops replication for a session that has ended without the user signing out here.
   *
   * The generation moves first, as in `onSignOut`, so a startup still in flight cannot finish
   * into the session that has just ended.
   */
  private endReplication(): void {
    this.sessionGeneration += 1
    this.sync?.stopAll()
    this.sync = undefined
    this.states.clear()
    this.syncing = undefined
    this.fresh = undefined
  }

  override disconnectedCallback(): void {
    // The same guard, for a shell torn down rather than signed out of. A replication left
    // running against a detached component is a request nobody will read the answer to.
    this.sessionGeneration += 1
    this.tokenRefresher?.stop()
    this.tokenRefresher = undefined
    this.sync?.stopAll()
    this.sync = undefined
    window.removeEventListener('hashchange', this.onHashChange)
    this.stopWatchingNetwork?.()
    this.stopWatchingNetwork = undefined
    super.disconnectedCallback()
  }

  /**
   * Takes the waiting update.
   *
   * The reload is the point: a new worker controlling an old page does not change the
   * JavaScript already running in it. `updates.ts` owns the sequencing, including the case
   * where the worker never answers.
   */
  private onTakeUpdate(): void {
    const waiting = this.updateReady
    if (waiting === undefined) return

    const take =
      this.takeUpdate ??
      ((worker: ServiceWorker) =>
        applyUpdate(worker, navigator.serviceWorker, () => {
          window.location.reload()
        }))
    take(waiting)
  }

  /** Advances the preference one step around light → dark → system → light. */
  private cycleScheme(): void {
    const currentIndex = SCHEME_CYCLE.indexOf(this.schemePreference)
    const next = SCHEME_CYCLE[(currentIndex + 1) % SCHEME_CYCLE.length] as SchemePreference

    writePreference(() => localStorage, next)
    this.schemePreference = next

    const prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches
    applyScheme(document.documentElement, resolveScheme(next, prefersDark))
  }

  /**
   * The accessible label for the scheme toggle, describing what the *next* activation will
   * select rather than the state it is in now - the icon already shows the current state, so
   * naming it again in the label would be redundant, not additionally informative.
   */
  private schemeToggleLabel(): string {
    const currentIndex = SCHEME_CYCLE.indexOf(this.schemePreference)
    const next = SCHEME_CYCLE[(currentIndex + 1) % SCHEME_CYCLE.length] as SchemePreference
    switch (next) {
      case 'light':
        return msg('Switch to light scheme')
      case 'dark':
        return msg('Switch to dark scheme')
      case 'system':
        return msg('Switch to system scheme')
    }
  }

  /**
   * What replication is doing, when it is doing anything.
   *
   * Nothing at all when it is `idle`: the steady state is everything being fine, and a badge
   * that is always present says nothing when it matters.
   */
  private renderSyncing(): TemplateResult | '' {
    if (this.syncing === undefined || this.syncing === 'idle') return ''

    return html`
      <wa-tag
        data-syncing
        variant=${this.syncing === 'denied' ? 'warning' : 'neutral'}
        size="s"
      >
        <wa-icon slot="start" name="arrows-rotate"></wa-icon>
        ${
          this.syncing === 'denied'
            ? msg('No permission to sync')
            : this.syncing === 'offline'
              ? msg('Waiting to sync')
              : msg('Syncing')
        }
      </wa-tag>
    `
  }

  /**
   * The account, top right: the signed-in email, or the way to sign in, or nothing at all until
   * the first answer arrives — offering "Sign in" to somebody who *is* signed in, for the moment
   * it takes to find out, is worse than offering nothing for that moment.
   *
   * `expired` gets the same control as `signed-out` and a different word. The remedy is
   * identical - sign in again - but "your session ended" and "you are not signed in" are
   * different facts, and the first one reassures somebody whose data is still on the device
   * that nothing has been lost.
   *
   * Signing out is not here but in the navigation (`renderSignOut`): it is rarely wanted, and
   * the header is for what is true now.
   */
  private renderAccount(): TemplateResult | '' {
    if (this.session === undefined) return ''

    if (this.session === 'signed-in') {
      const email = this.facts?.email
      return email === undefined
        ? ''
        : html`<span data-user-email class="app-email">${email}</span>`
    }

    return html`
      <wa-button data-sign-in appearance="plain" @click=${this.onSignIn}>
        ${this.session === 'expired' ? msg('Session ended - sign in again') : msg('Sign in')}
      </wa-button>
    `
  }

  /**
   * Signing out, as the navigation's last item while there is a session. It still asks first:
   * see {@link renderSignOutConfirmation}.
   */
  private renderSignOut(): TemplateResult | '' {
    if (this.session !== 'signed-in') return ''
    return html`
      <wa-button
        data-sign-out
        data-drawer="close"
        appearance="plain"
        class="app-nav-action"
        @click=${this.onAskSignOut}
      >
        <wa-icon slot="start" name="right-from-bracket"></wa-icon>
        ${msg('Sign out')}
      </wa-button>
    `
  }

  /**
   * The way to a bigger plan, while there is one (`showsUpgrade`, never a tier literal: ADR
   * 0009). There is nothing to buy yet, and the dialog says so plainly.
   */
  private renderUpgrade(): TemplateResult | '' {
    if (!showsUpgrade(this.facts?.plan ?? DEFAULT_PLAN)) return ''
    return html`
      <wa-button data-upgrade size="s" variant="brand" appearance="outlined" @click=${this.onUpgrade}>
        <wa-icon slot="start" name="rocket"></wa-icon>
        ${msg('Upgrade')}
      </wa-button>
      ${
        this.upgrading
          ? html`<wa-dialog
              data-upgrade-dialog
              open
              label=${msg('Upgrade')}
              @wa-after-hide=${(event: Event) => {
                // Only the dialog's own hide: an element inside it can fire the same event.
                if (event.target === event.currentTarget) this.upgrading = false
              }}
            >
              <p>${msg("It's just alpha — coming soon")}</p>
              <wa-button slot="footer" data-close-upgrade @click=${this.onCloseUpgrade}>
                ${msg('Close')}
              </wa-button>
            </wa-dialog>`
          : ''
      }
    `
  }

  /**
   * Whether the browser has a network, said quietly either way.
   *
   * Always present since the projects page: whether a project can be created on the server,
   * promoted or removed depends on it, so the reader should not have to infer it from a
   * refusal. Neutral in both states — nothing in this application is blocked by being offline:
   * every write goes to a local database first, so offline explains a delay in sharing rather
   * than a loss of function. `data-offline` exists only while offline, which is what the
   * offline journey asserts.
   */
  private renderNetwork(): TemplateResult {
    return this.online
      ? html`<wa-tag data-online variant="neutral" size="s">
          <wa-icon slot="start" name="plug-circle-check"></wa-icon>
          ${msg('Online')}
        </wa-tag>`
      : html`<wa-tag data-offline variant="neutral" size="s">
          <wa-icon slot="start" name="plug-circle-xmark"></wa-icon>
          ${msg('Offline')}
        </wa-tag>`
  }

  /** The projects page, given the shell's state and its replication. See {@link ViewHost}. */
  renderProjects(): TemplateResult {
    return html`<projects-view
      .input=${this.projectsInput()}
      .sync=${this.sync}
      .refresh=${this.refreshFromPage}
    ></projects-view>`
  }

  /**
   * The projects page's input, from the facts last read and what the shell knows now.
   *
   * A list is fresh only within the signed-in session that fetched it, so any other session
   * marks it stale whatever the facts say (see `ProjectsInput.serverStale`).
   */
  private projectsInput(): ProjectsInput {
    const facts = this.facts ?? NO_FACTS
    const session = this.session ?? 'signed-out'
    return {
      local: facts.local,
      server: facts.server,
      serverStale: facts.serverStale || session !== 'signed-in',
      plan: facts.plan,
      ...(facts.reportedLimit === undefined ? {} : { reportedLimit: facts.reportedLimit }),
      session,
      online: this.online,
      syncStates: (projectId) => this.states.get(projectId),
    }
  }

  /** The page's `refresh`: the list fetched again, then everything re-read. */
  private refreshFromPage = (): Promise<void> => this.refreshProjects(true)

  /**
   * Reads the projects again and applies them: the current project, and what replicates.
   *
   * The fetch runs outside the queue and the read inside it. Reads are local and quick, so
   * queueing them keeps two refreshes from interleaving (the first-run adoption above all);
   * a fetch can take as long as the network likes, and queued it would hold up every later
   * refresh — the one after a sign-out included — behind a request nobody is waiting for.
   *
   * @param fetchList whether to ask the server for the list first (only signed in and online)
   */
  private async refreshProjects(fetchList: boolean): Promise<void> {
    const generation = this.sessionGeneration
    if (fetchList && this.session === 'signed-in' && this.online) {
      const store = this.store()
      const listed = await fetchProjectList(
        this.listProjects ?? (() => projects().list()),
        store.cache(),
      )
      // A list asked for by a session that has since ended belongs to nobody.
      if (generation !== this.sessionGeneration) return
      // A failed fetch drops the fresh list: the remembered one stands in, stale (C-R5).
      this.fresh = listed
    }
    const read = this.reading.then(() => this.readProjects())
    this.reading = read.catch(() => undefined)
    await read
  }

  /** The tail of the refresh queue. */
  private reading: Promise<void> = Promise.resolve()

  /** This session's `GET /projects`, if it answered. Dropped whenever the session ends. */
  private fresh: readonly Project[] | undefined

  /** One queued read: adopt on a first run, read the facts, apply them. */
  private async readProjects(): Promise<void> {
    const generation = this.sessionGeneration
    const store = this.store()
    // Ruling C-R7: a device with nothing indexed adopts its catalogue, even empty, so it always
    // has one project to name and open. Idempotent and a no-op once anything is indexed. A
    // failure leaves the page offering to create a project instead, which loses nothing.
    await adoptLegacyCatalogue('', store).catch(() => undefined)
    const facts = await readProjectFacts(
      store.cache(),
      this.session === 'signed-in' ? this.fresh : undefined,
    )
    if (generation !== this.sessionGeneration) return
    this.facts = facts
    this.applyProjects()
  }

  /**
   * Opens the current project and hands replication its list, both from the page's model, so the
   * shell and the page never disagree about what a project is.
   *
   * Replication gets **only the copies on this device** (`synchronizedProjects`), never every
   * server project: one listed but not downloaded would be downloaded, a copy just removed
   * downloaded again. A project an action holds (`SyncManager.suspend`) stays held whatever this
   * list says.
   */
  private applyProjects(): void {
    const model = projectsModel(this.projectsInput())
    const stored = readCurrentProjectId(() => localStorage)
    const current = resolveCurrentProject(stored, model)
    // The *choice* is corrected too, not only the database: a stored id that matches nothing
    // would be re-resolved, and fall back again, on every load.
    if (current.id !== stored) writeCurrentProjectId(() => localStorage, current.id)
    useProjectDatabase(current.dbName, current.editable)
    this.sync?.set(synchronizedProjects(model))
  }

  /** The local index and databases, the injected ones or the application's. */
  private store(): LocalProjectDependencies {
    return this.projectStore ?? localProjectDefaults
  }

  /**
   * Starts replicating this account's projects, and follows the profile's locale.
   *
   * Both are deliberately fire-and-forget. Every view works from the local database, so holding
   * the interface back on either would delay everything to improve something that is already
   * correct - which is the same trade the locale and the scheme make at startup.
   *
   * The manager is built at once, before the list arrives: the projects page needs it to push
   * and hold while promoting and removing, and what it replicates comes from the index, which is
   * already here. A list that cannot be fetched is not reported. There is nothing the reader can
   * do about it and nothing they lose by it: the remembered list stands in, and `offline` in the
   * summary is what replication resuming later looks like.
   */
  private startSyncing(): void {
    // Found by review. The list request and the locale callback both outlive this call. Somebody
    // who signs out while either is in flight would otherwise get the list applied - and a
    // replication handed projects - *after* the sign-out that stopped the previous one, with a
    // token that has been forgotten, and a locale from the account they have left.
    //
    // The generation is the same guard `theme.ts` uses for stylesheet loads and `device.ts` for
    // saves. Signing out increments it, so everything started before is answered by nobody.
    const generation = this.sessionGeneration

    void (this.followLocale ?? followProfileLocale)(
      (locale) => {
        if (generation !== this.sessionGeneration) return
        void activateLocale(negotiateLocale(locale as never, navigator.languages))
      },
      () => {
        // The fetched profile is in the cache: the email and the plan are read again.
        if (generation === this.sessionGeneration) void this.refreshProjects(false)
      },
    )

    this.sync = (this.makeSync ?? ((onState) => projectSync(onState)))((projectId, state) => {
      if (generation !== this.sessionGeneration) return
      // A refusal stops that project's replication (spec): retrying a write the server refuses
      // only refuses it again. Cancelling reports `stopped`, which must not overwrite the reason
      // the page shows on the row. The next list handed over (a refresh, a reconnection) starts
      // it again, which is when a changed permission or plan would let it through.
      if (state === 'stopped' && this.states.get(projectId) === 'denied') return
      this.states.set(projectId, state)
      if (state === 'denied') this.sync?.stop(projectId)
      this.syncing = worstOf([...this.states.values()])
      // The projects page shows each row's state, and the summary changing is not the only
      // change worth a render: one project going from `active` to `idle` leaves it unchanged.
      this.requestUpdate()
    })
    void this.refreshProjects(true)
  }

  /** One replication per project, and what each is doing. */
  private sync: SyncManager | undefined
  private states = new Map<string, SyncState>()
  /**
   * Counts sessions, so work started under one cannot land under the next.
   *
   * A plain field rather than a reactive property: nothing renders it, and assigning a reactive
   * property from inside an update schedules a second update for no reason.
   */
  private sessionGeneration = 0

  /**
   * The sign-out confirmation.
   *
   * It exists because signing out now has a question in it. Everything the *account* put on this
   * browser goes either way; the catalogue on this device predates accounts and holds whatever
   * was recorded before signing in, so taking it would be destroying data the account never
   * owned. Unticked by default: the safe answer is the one that keeps things.
   */
  private renderSignOutConfirmation(): TemplateResult | '' {
    if (!this.signingOut) return ''

    return html`
      <wa-dialog data-sign-out-dialog open label=${msg('Sign out')}>
        <p>${msg('Everything this account put on this browser will be removed.')}</p>
        <wa-checkbox data-remove-local>
          ${msg('Also remove the devices stored only on this device')}
        </wa-checkbox>
        <wa-button slot="footer" data-cancel-sign-out @click=${this.onCancelSignOut}>
          ${msg('Cancel')}
        </wa-button>
        <wa-button slot="footer" variant="brand" data-confirm-sign-out @click=${this.onSignOut}>
          ${msg('Sign out')}
        </wa-button>
      </wa-dialog>
    `
  }

  private onDismissSessionEnded = (): void => {
    this.sessionEndedNotice = false
  }

  private onAskSignOut = (): void => {
    this.signingOut = true
  }

  private onCancelSignOut = (): void => {
    this.signingOut = false
  }

  private onSignIn = (): void => {
    ;(this.signIn ?? beginSignIn)()
  }

  private onSignOut = async (): Promise<void> => {
    const box = this.querySelector('[data-remove-local]') as { checked?: boolean } | null
    const includeLocalCatalogue = box?.checked === true
    this.signingOut = false

    // The state is set whatever happened, because `signOut` never throws and always leaves the
    // browser signed out: it forgets the token first, unconditionally, and every later step is
    // attempted regardless of the ones before it. Leaving the button saying "Sign out" after
    // that would be the interface disagreeing with itself.
    // Before the sign-out, not after. Replication holds an access token and a live connection
    // to a database this browser is about to be told it may not read; leaving it running would
    // mean requests going out on behalf of somebody who has just left.
    //
    // The generation moves first of all, so a startup still in flight cannot finish into the
    // session that is ending - stopping what is running says nothing about what is about to
    // start.
    this.sessionGeneration += 1
    // Stopped before the sign-out runs, so a refresh in flight cannot re-store a token that the
    // sign-out is about to forget.
    this.tokenRefresher?.stop()
    this.tokenRefresher = undefined
    this.sync?.stopAll()
    this.sync = undefined
    this.states.clear()
    this.syncing = undefined

    this.fresh = undefined

    await (this.signOutOf ?? endSession)(includeLocalCatalogue)
    this.session = 'signed-out'
    // Back to a project that is certainly here. The account's copies are gone from this browser,
    // so the open project falls back to the first local one (or a freshly adopted catalogue);
    // leaving the views on a destroyed copy would show an empty list that looks exactly like
    // having lost everything.
    await this.refreshProjects(false)
  }

  private onUpgrade = (): void => {
    this.upgrading = true
  }

  private onCloseUpgrade = (): void => {
    this.upgrading = false
  }

  override render() {
    const match = matchRoute(this.hash, ROUTES)
    const view = match ? VIEWS[match.route.view] : undefined

    return html`
      <wa-page>
        <header slot="header" class="wa-split app-header">
          <div class="wa-cluster">
            <wa-button data-toggle-nav appearance="plain" class="wa-mobile-only">
              <wa-icon name="bars" label=${msg('Menu')}></wa-icon>
            </wa-button>
            <strong>${msg('Matter Manager')}</strong>
          </div>
          <div class="wa-cluster wa-gap-s">
            ${this.renderNetwork()}
            ${this.renderSyncing()}
            ${this.renderUpgrade()}
            <wa-button data-scheme-toggle appearance="plain" @click=${this.cycleScheme}>
              <wa-icon
                name=${SCHEME_ICON[this.schemePreference]}
                label=${this.schemeToggleLabel()}
              ></wa-icon>
            </wa-button>
            ${this.renderAccount()}
          </div>
        </header>

        <nav slot="navigation" class="wa-stack wa-gap-2xs app-nav">
          ${NAV_ROUTES.map(
            (route) => html`
              <a
                href="#${route.path}"
                class="wa-cluster wa-gap-s"
                data-drawer="close"
                aria-current=${match?.route === route ? 'page' : 'false'}
              >
                <wa-icon name=${route.icon ?? ''}></wa-icon>
                ${route.label?.()}
              </a>
            `,
          )}
          ${this.renderSignOut()}
        </nav>
        ${this.renderSignOutConfirmation()}

        <main class="wa-stack wa-gap-m app-main">
          <!-- Offered, never applied by itself. Reloading out from under someone mid-form is
               how an update becomes something that happened to them. -->
          ${
            this.updateReady === undefined
              ? ''
              : html`
                  <wa-callout variant="brand" data-update-available>
                    <wa-icon slot="icon" name="arrows-rotate"></wa-icon>
                    <div class="wa-split wa-gap-m">
                      <span>${msg('A new version of Matter Manager is ready.')}</span>
                      <wa-button data-take-update size="s" @click=${this.onTakeUpdate}>
                        ${msg('Reload')}
                      </wa-button>
                    </div>
                  </wa-callout>
                `
          }
          ${
            this.sessionEndedNotice
              ? html`<wa-callout variant="warning" data-session-ended>
                  <wa-icon slot="icon" name="triangle-exclamation"></wa-icon>
                  <div class="wa-split wa-gap-m">
                    <span>${msg('Your session has ended. Please sign in again.')}</span>
                    <wa-button size="s" appearance="plain" @click=${this.onDismissSessionEnded}>
                      ${msg('Dismiss')}
                    </wa-button>
                  </div>
                </wa-callout>`
              : ''
          }
          ${view && match ? view(match.params, this) : html`<not-found-view></not-found-view>`}
        </main>

        <!-- In the footer slot, not the navigation: on a phone the navigation is a closed
             drawer. Google's OAuth review expects the purpose and the privacy policy to be
             reachable from the application, and so does anybody deciding whether to sign in. -->
        <footer slot="footer" class="wa-cluster wa-gap-m app-footer">
          <a href="${WEBSITE}/">${msg('About Matter Manager')}</a>
          <a href="${WEBSITE}/privacy">${msg('Privacy')}</a>
          <a href="${WEBSITE}/tos">${msg('Terms')}</a>
        </footer>
      </wa-page>
    `
  }
}

customElements.define('app-shell', AppShell)

/**
 * The state worth reporting when several replications disagree.
 *
 * Worst wins. A summary saying `idle` while one project cannot reach the server would be
 * reassuring and wrong, and the reader's question is "is everything through?" rather than "is
 * anything through?".
 * `denied` outranks `offline`: offline heals itself, a refusal does not.
 */
function worstOf(states: readonly SyncState[]): SyncState | undefined {
  const order: readonly SyncState[] = ['denied', 'offline', 'stopped', 'active', 'idle']
  return order.find((state) => states.includes(state))
}
