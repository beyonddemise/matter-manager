import { msg, updateWhenLocaleChanges } from '@lit/localize'
import { html, LitElement, type TemplateResult } from 'lit'
import { DEFAULT_PLAN, type Plan } from '../domain/plan.js'
import { BACKFILL_WANTED } from './catalog.js'
import { type CatalogBackfill, defaultCatalogBackfill } from './catalog-backfill.js'
import {
  beginSignIn,
  endSession,
  followProfileLocale,
  requestTokens,
  type TokenOutcome,
  waitlist as waitlistClient,
} from './composition.js'
import { browserConnectivity, type ConnectivitySource, watchConnectivity } from './connectivity.js'
import { PROJECT_CHANGED } from './current-project.js'
import { localDatabase } from './db/project-database.js'
import { negotiateLocale } from './i18n/locale.js'
import { activateLocale } from './i18n/localization.js'
import { type LocalProjectDependencies, localProjectDefaults } from './local-projects.js'
import { cachedProfileOf, type PlanRequest } from './profile.js'
import { beginProjectAction } from './project-busy.js'
import type { Project } from './projects.js'
import { ProjectsController } from './projects-controller.js'
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
import {
  offersUpgrade,
  renderAccount,
  renderSignOut,
  renderSignOutConfirmation,
  renderUpgrade,
  type SignOutStep,
} from './shell-header.js'
import {
  announcementFor,
  renderNetworkStatus,
  renderSyncStatus,
  type StatusSnapshot,
} from './shell-status.js'
import type { SyncManager } from './sync/manager.js'
import type { SyncState } from './sync/replication.js'
import { startRefresher } from './token-refresher.js'
import { forgetTokens, pouchRefreshTokenStore } from './tokens.js'
import { applyUpdate } from './updates.js'
import { focusWaitlist, type WaitlistProblem } from './upgrade-dialog.js'
import type { WaitlistApi, WaitlistOutcome } from './waitlist.js'
import './views/add-device.js'
import './views/rooms.js'
import './views/device-list.js'
import './views/device.js'
import './views/edit-device.js'
import './views/not-found.js'
import './views/projects.js'
import './views/settings.js'
/**
 * The application icon, as a fingerprinted /assets/ URL. `index.html` names the same file as the
 * favicon, which is what gets it precached for offline use; see the note there.
 */
import brandMark from './brand/icon.svg'

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
    signingOut: { state: true },
    upgrading: { state: true },
    waitlistBusy: { state: true },
    waitlistProblem: { state: true },
    waitlist: { attribute: false },
    refresher: { attribute: false },
    sessionEndedNotice: { state: true },
    listProjects: { attribute: false },
    makeSync: { attribute: false },
    followLocale: { attribute: false },
    signIn: { attribute: false },
    signOutOf: { attribute: false },
    hash: { state: true },
    announcement: { state: true },
    schemePreference: { state: true },
    online: { state: true },
    updateReady: { attribute: false },
    connectivity: { attribute: false },
    backfill: { attribute: false },
    takeUpdate: { attribute: false },
    projectStore: { attribute: false },
    signOutPushTimeoutMs: { attribute: false },
  }

  declare hash: string
  /** What the status bar's live region last said; see `announcementFor`. */
  declare announcement: string
  declare schemePreference: SchemePreference

  /**
   * What this browser believes about the session.
   *
   * `undefined` until the first answer arrives, which is why the control renders nothing at
   * first: offering "Sign in" to somebody who *is* signed in, for the moment it takes to find
   * out, is worse than offering nothing for that moment.
   */
  declare session: SessionState | undefined

  /** The sign-out confirmation's step, or `undefined` while it is closed. */
  declare signingOut: SignOutStep | undefined
  /** Whether the upgrade dialog is open. */
  declare upgrading: boolean
  /** A waitlist change is on its way to the server; every action in the dialog waits. */
  declare waitlistBusy: boolean
  /** Why the last waitlist change did not happen, until the dialog closes or another is tried. */
  declare waitlistProblem: WaitlistProblem | undefined
  /** Injected by tests. Unset in the application, where it reaches the real API. */
  declare waitlist?: WaitlistApi
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
  /** How long signing out waits for each push; injected by tests, the controller's default otherwise. */
  declare signOutPushTimeoutMs?: number
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
   * Fills in manufacturer and product for devices added offline (#228). Injected by tests; the
   * real one is built on first use, so a shell that never signs in never builds it.
   */
  declare backfill?: CatalogBackfill
  private realBackfill: CatalogBackfill | undefined
  private catalogBackfill(): CatalogBackfill {
    this.realBackfill ??= this.backfill ?? defaultCatalogBackfill()
    return this.realBackfill
  }

  /**
   * True from the moment a sign-out begins until `signOutOf` has finished. The session still
   * reads `signed-in` in that window, so without this a project switch or a regained connection
   * would start a run for an account that is leaving (#238).
   */
  private endingSession = false

  /**
   * Stops backfill, if one exists. Never through `catalogBackfill()`: a shell that never signed
   * in must not build a real backfill just to stop it. An injected one is stopped even if it was
   * never adopted.
   */
  private stopBackfill(): void {
    ;(this.realBackfill ?? this.backfill)?.stop()
  }

  /** Starts a backfill run, unless a sign-out is under way. Callers check session and network. */
  private triggerBackfill(): void {
    if (this.endingSession) return
    this.catalogBackfill().trigger()
  }

  /**
   * Backfill follows the open project: the old run is stopped (its answers belong to a project
   * nobody is looking at) and a new one starts over the new project, when signed in and online.
   */
  private readonly onProjectChanged = (): void => {
    this.stopBackfill()
    if (this.session === 'signed-in' && this.online) this.triggerBackfill()
  }

  /**
   * A view asked for a run (`BACKFILL_WANTED`): a device was saved without its names. Not a
   * restart, unlike a project switch: a run already going is over the same project, and
   * `trigger` asks it for one more pass.
   */
  private readonly onBackfillWanted = (): void => {
    if (this.session === 'signed-in' && this.online) this.triggerBackfill()
  }

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
    this.signingOut = undefined
    this.upgrading = false
    this.waitlistBusy = false
    this.waitlistProblem = undefined
    this.sessionEndedNotice = false
    this.hash = window.location.hash
    this.announcement = ''
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
    window.addEventListener(PROJECT_CHANGED, this.onProjectChanged)
    window.addEventListener(BACKFILL_WANTED, this.onBackfillWanted)
    this.stopWatchingNetwork = watchConnectivity(
      this.connectivity ?? browserConnectivity(),
      (online) => {
        const regained = online && !this.online
        this.online = online
        // The list may have changed while the connection was gone, and the page can only act on
        // a list this session heard (C-R5).
        if (regained && this.session === 'signed-in') void this.projects.refresh(true)
        // The other half of "on connectivity becoming online" (spec §Backfill).
        if (regained && this.session === 'signed-in') this.triggerBackfill()
      },
    )

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
        if (!wasSignedIn) {
          this.startSyncing()
          // Once after sign-in, on the transition only: `refreshed` repeats before every expiry.
          this.triggerBackfill()
        }
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
          this.stopBackfill()
          this.endReplication()
          forgetTokens()
        }
        this.session = 'signed-out'
        // Re-read either way: on a first answer this is the page's session arriving, after a
        // sign-in it is this session's list going stale.
        void this.projects.refresh(false)
        return
      case 'ended':
        // Local data stays: `sessionExpired` forgets the in-memory access token and nothing
        // else. Replication is stopped because its token is now dead, and a manager retrying
        // with it would only produce 401s.
        this.stopBackfill()
        this.endReplication()
        this.session = sessionExpired({ forgetTokens })
        this.sessionEndedNotice = true
        // No longer this session's list: the page falls back to the remembered one, stale.
        void this.projects.refresh(false)
        return
      case 'unreachable':
        return
    }
  }

  /**
   * Stops replication for a session that has ended without the user signing out here. The
   * generation moves first (in `end`), so a startup still in flight cannot finish into the
   * session that has just ended.
   */
  private endReplication(): void {
    this.projects.end()
  }

  /** What the status bar showed at the last render, to tell what changed since. */
  private lastStatus: StatusSnapshot | undefined

  /**
   * Writes into the live region only what is worth interrupting for (`announcementFor`). Set
   * here, before rendering, so the change and its announcement arrive in one render.
   */
  protected override willUpdate(): void {
    const status: StatusSnapshot = { online: this.online, sync: this.projects.currentSync() }
    const announcement = announcementFor(this.lastStatus, status)
    if (announcement !== undefined) this.announcement = announcement
    this.lastStatus = status
    // The dialog goes with its button, whatever took the button away: leaving on the top plan,
    // or a background profile refresh that dropped the request. Without this `upgrading` would
    // stay set and the dialog would reopen by itself when a later request brings the button back.
    // Here rather than in `updated()`, so it lands in the same render instead of a second one.
    if (this.upgrading && !offersUpgrade(this.upgradeFacts())) this.onCloseUpgrade()
  }

  /** What decides whether Upgrade is offered: the cached plan and request. */
  private upgradeFacts(): { plan: Plan; request: PlanRequest | undefined } {
    const facts = this.projects.facts
    return { plan: facts?.plan ?? DEFAULT_PLAN, request: facts?.request }
  }

  /** Watches the sticky footer's height; see {@link firstUpdated}. */
  private footerObserver: ResizeObserver | undefined

  /**
   * Keeps the page's scroll padding equal to the sticky footer's height, so a control that takes
   * focus is scrolled clear of the footer rather than under it (WCAG 2.4.11). Measured, because
   * the footer's height changes with the language, the font size and the width.
   */
  protected override firstUpdated(): void {
    const footer = this.querySelector('footer[slot="footer"]')
    if (footer === null) return
    const root = document.documentElement
    this.footerObserver = new ResizeObserver(() => {
      root.style.setProperty('--app-footer-height', `${footer.getBoundingClientRect().height}px`)
    })
    // The border box, because the height written above is the border box: observing the default
    // content box would miss a change of the footer's own padding (it differs on a phone).
    this.footerObserver.observe(footer, { box: 'border-box' })
  }

  override disconnectedCallback(): void {
    this.footerObserver?.disconnect()
    this.footerObserver = undefined
    document.documentElement.style.removeProperty('--app-footer-height')
    window.removeEventListener(PROJECT_CHANGED, this.onProjectChanged)
    window.removeEventListener(BACKFILL_WANTED, this.onBackfillWanted)
    this.stopBackfill()
    // Replication is ended by the projects controller, which is disconnected with the shell.
    this.tokenRefresher?.stop()
    this.tokenRefresher = undefined
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

  /** The projects page, given the shell's state and its replication. See {@link ViewHost}. */
  renderProjects(): TemplateResult {
    return html`<projects-view
      .input=${this.projects.input()}
      .sync=${this.projects.sync}
      .refresh=${this.refreshFromPage}
    ></projects-view>`
  }

  /** The page's `refresh`: the list fetched again, then everything re-read. */
  private refreshFromPage = (): Promise<void> => this.projects.refresh(true)

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
   * do about it and nothing they lose by it: the remembered list stands in, and "Sync pending"
   * in the status bar is what replication resuming later looks like.
   */
  private startSyncing(): void {
    // Found by review. The locale callback outlives this call: somebody who signs out while it
    // is in flight would otherwise get a locale from the account they have left. The same
    // generation guards the list request and replication, inside the controller.
    const generation = this.projects.generation

    void (this.followLocale ?? followProfileLocale)(
      (locale) => {
        if (!this.projects.isCurrent(generation)) return
        void activateLocale(negotiateLocale(locale as never, navigator.languages))
      },
      () => {
        // The fetched profile is in the cache: the email and the plan are read again.
        if (this.projects.isCurrent(generation)) void this.projects.refresh(false)
      },
    )
    this.projects.start()
  }

  /** The projects: their facts, the open project, and replication. */
  private readonly projects = new ProjectsController(this)

  private onDismissSessionEnded = (): void => {
    this.sessionEndedNotice = false
  }

  private onAskSignOut = (): void => {
    this.signOutAttempt += 1
    this.signingOut = { step: 'ask', pushing: false }
  }

  private onCancelSignOut = (): void => {
    // Moves the attempt on, so pushes still running for the one cancelled sign out nobody.
    this.signOutAttempt += 1
    this.signingOut = undefined
  }

  private onSignIn = (): void => {
    ;(this.signIn ?? beginSignIn)()
  }

  /** Counts sign-out dialogs, so a push that outlives its dialog (cancelled) signs nobody out. */
  private signOutAttempt = 0

  /** The first step's "also remove projects stored only on this device", kept for the second. */
  private removeLocalProjects = false

  /**
   * The first step confirmed: every synchronized copy is pushed (ruling C-R10), and the sign-out
   * goes ahead only if all of them got through. Otherwise the dialog names the ones that did not
   * and waits for a second, explicit confirm — or a cancel, which leaves everything as it was.
   *
   * The busy registry is held throughout (`project-busy.ts`): a refresh landing now (the
   * profile, a reconnection) must not reopen a copy about to be destroyed or hand replication a
   * list of its own.
   */
  private onSignOut = async (): Promise<void> => {
    const box = this.querySelector('[data-remove-local]') as { checked?: boolean } | null
    this.removeLocalProjects = box?.checked === true
    const attempt = this.signOutAttempt
    this.signingOut = { step: 'ask', pushing: true }
    const end = beginProjectAction()
    let signedOut = false
    try {
      const check = await this.projects.unpushedCopies()
      if (attempt !== this.signOutAttempt) return
      if (check.names.length > 0 || check.unreadable) {
        this.signingOut = { step: 'unpushed', names: check.names, unreadable: check.unreadable }
        return
      }
      await this.signOut()
      signedOut = true
    } finally {
      end()
    }
    if (signedOut) await this.afterSignOut()
  }

  /** The second step confirmed: signs out although the named copies were not pushed. */
  private onSignOutUnpushed = async (): Promise<void> => {
    const end = beginProjectAction()
    try {
      await this.signOut()
    } finally {
      end()
    }
    await this.afterSignOut()
  }

  /** Ends the session and removes what the account put on this browser. Run while held busy. */
  private async signOut(): Promise<void> {
    this.signingOut = undefined

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
    this.projects.end()
    this.endingSession = true
    this.stopBackfill()
    // Stopped before the sign-out runs, so a refresh in flight cannot re-store a token that the
    // sign-out is about to forget.
    this.tokenRefresher?.stop()
    this.tokenRefresher = undefined

    try {
      await (this.signOutOf ?? endSession)(this.removeLocalProjects)
      this.session = 'signed-out'
    } finally {
      // Cleared only once the session reads `signed-out`, which every trigger site checks.
      this.endingSession = false
    }
  }

  /**
   * Back to a project that is certainly here, once the busy registry is let go (an apply while
   * it is held is skipped). The account's copies are gone from this browser, so the open project
   * falls back to the first local one (or a freshly adopted catalogue); leaving the views on a
   * destroyed copy would show an empty list that looks exactly like having lost everything.
   */
  private async afterSignOut(): Promise<void> {
    await this.projects.refresh(false)
  }

  private onUpgrade = (): void => {
    this.waitlistProblem = undefined
    this.upgrading = true
  }

  private onCloseUpgrade = (): void => {
    this.upgrading = false
    this.waitlistProblem = undefined
  }

  private onJoinWaitlist = (plan: Plan): void => {
    void this.changeWaitlist((api) => api.join(plan))
  }

  private onLeaveWaitlist = (): void => {
    void this.changeWaitlist((api) => api.leave())
  }

  /**
   * Sends one waitlist change, then caches the profile the server answered with and re-reads the
   * facts, so the dialog shows what the server now holds. The cache is what the dialog reads, and
   * offline it is all there is.
   *
   * One change at a time: a second click before the first answers is ignored here, and not only
   * by the disabled buttons, which update a render later than a quick second click arrives.
   */
  private async changeWaitlist(
    change: (api: WaitlistApi) => Promise<WaitlistOutcome>,
  ): Promise<void> {
    if (this.waitlistBusy) return
    this.waitlistBusy = true
    this.waitlistProblem = undefined
    try {
      await this.settleWaitlist(await change(this.waitlist ?? waitlistClient()))
    } finally {
      this.waitlistBusy = false
    }
    // Every outcome, a problem included: the clicked button was disabled on the way and dropped
    // focus to the page behind the dialog.
    await this.updateComplete
    const dialog = this.querySelector('[data-upgrade-dialog]')
    if (dialog !== null) await focusWaitlist(dialog)
  }

  /** Shows what a waitlist change came to: the problem, or the profile the server now holds. */
  private async settleWaitlist(outcome: WaitlistOutcome): Promise<void> {
    if (outcome.kind !== 'done') {
      this.waitlistProblem = outcome.kind
      return
    }
    // The dialog reads the cache. A cache that refuses the write leaves the server right and
    // this device showing the old state, so the reader is told rather than left to wonder
    // (ruling R12). Nothing from the profile goes into the notice or a log.
    try {
      await (this.projectStore ?? localProjectDefaults)
        .cache()
        .writeProfile(cachedProfileOf(outcome.profile, new Date().toISOString()))
    } catch {
      this.waitlistProblem = 'not-stored'
      return
    }
    await this.projects.refresh(false)
    // Leaving a request for the top plan takes the Upgrade button away (ruling R3), and
    // `willUpdate` closes the dialog with it. Its status region goes too, so the shell's own
    // live region says what happened.
    if (!offersUpgrade(this.upgradeFacts())) this.announcement = msg('You left the waitlist.')
  }

  /** The public website, its privacy notice and its terms. */
  private renderSiteLinks(): TemplateResult {
    return html`
      <a href="${WEBSITE}/">${msg('About Matter Manager')}</a>
      <a href="${WEBSITE}/privacy">${msg('Privacy')}</a>
      <a href="${WEBSITE}/tos">${msg('Terms')}</a>
    `
  }

  override render() {
    const match = matchRoute(this.hash, ROUTES)
    const view = match ? VIEWS[match.route.view] : undefined

    return html`
      <wa-page>
        <header slot="header" class="wa-split wa-gap-s app-header">
          <div class="wa-cluster wa-gap-xs app-header-title">
            <wa-button data-toggle-nav appearance="plain" size="s" class="wa-mobile-only">
              <wa-icon name="bars" label=${msg('Menu')}></wa-icon>
            </wa-button>
            <!-- The mark carries the accessible name. On a phone it stands alone: the written name
                 next to it would push the header actions onto a second row at 360-390px. On wider
                 screens the name is shown too, hidden from assistive technology so it is not
                 announced twice. -->
            <img class="app-brand-mark" src=${brandMark} alt=${msg('Matter Manager')} />
            <strong class="wa-desktop-only" aria-hidden="true">${msg('Matter Manager')}</strong>
          </div>
          <div class="wa-cluster wa-gap-xs app-header-actions">
            ${renderUpgrade(
              {
                plan: this.projects.facts?.plan ?? DEFAULT_PLAN,
                session: this.session,
                online: this.online,
                request: this.projects.facts?.request,
                busy: this.waitlistBusy,
                problem: this.waitlistProblem,
              },
              this.upgrading,
              this.onUpgrade,
              this.onCloseUpgrade,
              {
                onJoin: this.onJoinWaitlist,
                onLeave: this.onLeaveWaitlist,
                onSignIn: this.onSignIn,
              },
            )}
            <wa-button data-scheme-toggle appearance="plain" size="s" @click=${this.cycleScheme}>
              <wa-icon
                name=${SCHEME_ICON[this.schemePreference]}
                label=${this.schemeToggleLabel()}
              ></wa-icon>
            </wa-button>
            ${renderAccount(this.session, this.projects.facts?.email, this.onSignIn)}
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
          ${
            // The header has no room for the account at phone width, so the drawer carries it,
            // beside the sign-out it belongs with.
            this.session === 'signed-in' && this.projects.facts?.email !== undefined
              ? html`<span data-nav-email class="wa-mobile-only app-nav-email">
                  ${this.projects.facts.email}
                </span>`
              : ''
          }
          ${renderSignOut(this.session, this.onAskSignOut)}
        </nav>
        <!-- The website's links at phone width, where the footer holds only the status bar: in
             the drawer, which every view has. On desktop they are in the footer instead. -->
        <div slot="navigation-footer" class="wa-mobile-only wa-cluster wa-gap-m app-site-links">
          ${this.renderSiteLinks()}
        </div>
        ${renderSignOutConfirmation(this.signingOut, {
          onCancel: this.onCancelSignOut,
          onConfirm: this.onSignOut,
          onConfirmUnpushed: this.onSignOutUnpushed,
        })}

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

        <!-- The status bar and, on desktop, the website's links. Sticky (app.css): the network
             state must always be visible, and offline is the normal state here.

             Google's OAuth review expects the purpose and the privacy policy to be reachable
             from every view, and so does anybody deciding whether to sign in: here on desktop,
             in the drawer's footer at phone width, where one row of status is all the footer
             can spare. -->
        <footer slot="footer" class="wa-split wa-gap-s app-footer">
          <div class="wa-cluster wa-gap-xs" data-status-bar>
            ${renderNetworkStatus(this.online)}
            ${renderSyncStatus(this.projects.currentSync())}
            <!-- The one live region: the tags change silently, and only what is worth
                 interrupting for is written here. Always present, so it is registered before
                 the first thing it says. -->
            <span data-status-announcement role="status" class="wa-visually-hidden">
              ${this.announcement}
            </span>
          </div>
          <div class="wa-desktop-only wa-cluster wa-gap-m app-site-links">
            ${this.renderSiteLinks()}
          </div>
        </footer>
      </wa-page>
    `
  }
}

customElements.define('app-shell', AppShell)
