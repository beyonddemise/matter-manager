/**
 * The user's own settings, stored in CouchDB's `_users` database.
 *
 * `_users` rather than a database of our own, because CouchDB already keeps a document per user
 * there and extra fields on it survive untouched. A parallel store would be a second place a
 * user can exist, and the two would disagree the first time one write succeeded and the other
 * did not.
 *
 * **The browser never reads this directly.** A JWT-authenticated client cannot read `_users` at
 * all — not even its own document; it gets a 403, verified against CouchDB 3.5.2. That is not
 * an obstacle to work around but the reason `GET /profile` exists, and the reason the value has
 * to be cached in `mm-local` to survive going offline (#44).
 *
 * @module
 */

import type { Identity } from '../auth/oidc.js'
import type { CouchClient } from '../couch/client.js'
import { type Plan, PROJECT_LIMITS } from '../domain/index.js'

/** What a user may choose. `auto` follows the browser, as the contract says. */
export type Locale = 'auto' | 'en' | 'de'

/** The locales the interface has. A value outside this is a preference nothing can honour. */
export const LOCALES: readonly Locale[] = ['auto', 'en', 'de']

/** The profile as the contract describes it. */
export interface Profile {
  readonly sub: string
  readonly email: string
  readonly displayName: string
  readonly locale: Locale
  /** What the account may do. Absent from the document means `free`; see {@link isPlan}. */
  readonly plan: Plan
  /**
   * How many projects this plan may own, with **`-1` for unlimited**.
   *
   * Derived from {@link PROJECT_LIMITS} rather than stored, so it cannot disagree with the limit
   * the gate actually enforces. A number that said one thing while `can.ts` did another would be
   * worse than no number at all: the page would offer a slot the API then refuses.
   *
   * Reported because the page has to render "3 of 5 used" before it has tried anything, and the
   * alternative is a client-side copy of the policy table — which ADR 0009 exists to prevent.
   * The `-1` is a sentinel and must be tested before it is compared; see `withinLimit`.
   */
  readonly projectLimit: number
}

/** What a user is allowed to change about themselves. */
export interface ProfileUpdate {
  readonly locale: Locale
  readonly displayName?: string
}

/**
 * The `_users` document.
 *
 * `name`, `roles` and `type` are CouchDB's and must be written back unchanged — a `_users`
 * document that loses its `type: 'user'` stops being a user, and the account simply cannot
 * authenticate afterwards.
 */
interface UserDocument {
  readonly _id: string
  readonly _rev?: string
  readonly name: string
  readonly roles: readonly string[]
  readonly type: 'user'
  readonly email?: string
  readonly displayName?: string
  readonly locale?: Locale
  /**
   * `string`, not `Plan` — this is whatever an operator typed by hand, and the narrowing to a
   * plan this build knows happens in one place, {@link toProfile}, via {@link isPlan}.
   */
  readonly plan?: string
}

/** CouchDB's own id scheme for a user. */
export const userDocumentId = (sub: string): string => `org.couchdb.user:${sub}`

/**
 * How this store reports a `plan` it does not recognise.
 *
 * @param event - The account, and the value that was found on its document.
 */
export type UnknownPlanReporter = (event: { readonly sub: string; readonly plan: string }) => void

/**
 * Where an unrecognised plan is reported when nobody says otherwise.
 *
 * Not `request.log`, and that is a constraint rather than a preference: the store is built by
 * `serverOptions` *before* `buildServer` exists, so there is no Fastify logger to reach at the
 * point this has to be decided. Hence a seam with a default that works — the alternative
 * default is a no-op, and a no-op default for a diagnostic means the deployment that forgot to
 * wire it has exactly the silence this exists to end.
 *
 * One JSON object on stderr, in pino's field names, so it reads the same way as every other
 * line the service emits and is greppable by `msg`. Neither field is redactable: `sub` is
 * already logged by name elsewhere, and the plan is a string an operator typed. Nothing here
 * comes from a request body.
 */
const reportToStderr: UnknownPlanReporter = ({ sub, plan }) => {
  console.warn(
    JSON.stringify({
      level: 'warn',
      msg: 'unknown plan on a _users document; this account is being treated as free',
      sub,
      plan,
    }),
  )
}

/** The database CouchDB keeps users in. */
const USERS = '_users'

export interface ProfileStore {
  /** The profile, or `undefined` when the user has never signed in. */
  read(sub: string): Promise<Profile | undefined>
  /** Creates or updates the user from what the identity provider said. */
  remember(identity: Identity): Promise<void>
  /** Applies what the user chose. Returns the profile as stored. */
  update(sub: string, update: ProfileUpdate): Promise<Profile>
  /** The roles CouchDB holds for this subject, or none when there is no document. */
  rolesOf(sub: string): Promise<readonly string[]>
  /** Sets the plan. Separate from {@link update} because a user may not do this to themselves. */
  setPlan(sub: string, plan: Plan): Promise<Profile>
}

/** Whether a value is a locale this interface can honour. */
export function isLocale(value: unknown): value is Locale {
  return typeof value === 'string' && (LOCALES as readonly string[]).includes(value)
}

/** Whether a value is a plan this build knows. */
export function isPlan(value: unknown): value is Plan {
  return value === 'free' || value === 'member' || value === 'pro'
}

/** Raised when a subject has no `_users` document. The route turns this into a 404. */
export class UnknownSubjectError extends Error {
  constructor(readonly sub: string) {
    // `update` throws a bare Error for the same condition, which a route cannot tell from a
    // bug. This one is nameable, so "no such account" and "something went wrong" can be
    // different answers to an operator who needs to know which.
    super(`No profile for ${sub}`)
    this.name = 'UnknownSubjectError'
  }
}

/** A `_users` document as a profile, filling in what CouchDB does not hold. */
function toProfile(document: UserDocument, reportUnknownPlan: UnknownPlanReporter): Profile {
  // Narrowed once, into a name, and then used twice. Unknown reads as free, for the same reason
  // an unknown locale reads as `auto`: this field is hand-edited by an operator, so a typo is a
  // question of when. A miss would make `PROJECT_LIMITS[plan]` undefined and every comparison
  // against it false, which is a crash or a silent grant depending on where it lands.
  //
  // Narrowing in one place is also what keeps the two reported fields consistent: a document
  // saying `Pro` must not report `plan: 'free'` beside `projectLimit: undefined`, which is what
  // a second, separate test of `document.plan` would eventually produce.
  const plan: Plan = isPlan(document.plan) ? document.plan : 'free'

  // Narrowing quietly was the whole problem. The field is guarded *because* an operator
  // hand-editing a `_users` document will eventually write `Pro` or `premium` or `user ` — and
  // when they do, the account behaves as `free`, the operator sees the change they made sitting
  // in the document, and nothing anywhere connects the two. The support conversation that
  // follows is "I upgraded them and it did not work", with no evidence to look at.
  //
  // `document.plan !== undefined` rather than `!isPlan(...)` alone, and this is the difference
  // between a useful warning and a log nobody reads. An **absent** plan is the ordinary case —
  // every account that has never been upgraded has no such field — so warning on it would emit
  // a line per profile read and teach an operator to filter this message out. Only a value that
  // is *there* and unrecognised is a mistake somebody made.
  if (document.plan !== undefined && !isPlan(document.plan)) {
    reportUnknownPlan({ sub: document.name, plan: document.plan })
  }

  return {
    sub: document.name,
    email: document.email ?? '',
    displayName: document.displayName ?? document.name,
    // `auto` rather than a stored default. A profile that has never chosen and one that chose
    // `auto` are the same thing to the interface, and writing `en` in for a new user would give
    // a German-speaking visitor an English interface they never asked for.
    locale: isLocale(document.locale) ? document.locale : 'auto',
    plan,
    // A lookup, never a comparison against a tier: ADR 0009 forbids `plan === 'free'` outside
    // the policy table, and *reporting* what a plan allows is as much a policy decision as
    // enforcing it. Derived here rather than at each route because three operations return a
    // `Profile` — `GET /profile`, `PATCH /profile` and `PUT /customer` — and the contract's
    // schema requires this field of all three. Three derivations would be three chances to
    // forget one, and the one forgotten would be the operator's.
    projectLimit: PROJECT_LIMITS[plan],
  }
}

/**
 * Creates a profile store backed by CouchDB's `_users` database.
 *
 * @param couch - The CouchDB client.
 * @param reportUnknownPlan - Where a `plan` this build does not know is reported. Injectable so
 *   a test can assert the warning happened rather than read a log, and so a deployment can send
 *   it wherever its other lines go. See {@link reportToStderr} for why the default is not a
 *   no-op.
 * @returns A store for reading, creating, and updating user profiles
 */
export function profileStore(
  couch: CouchClient,
  reportUnknownPlan: UnknownPlanReporter = reportToStderr,
): ProfileStore {
  const load = (sub: string) => couch.getDoc<UserDocument>(USERS, userDocumentId(sub))
  /** Bound once, so no call site below can forget to pass it. */
  const asProfile = (document: UserDocument) => toProfile(document, reportUnknownPlan)

  return {
    async read(sub: string): Promise<Profile | undefined> {
      const document = await load(sub)
      return document === undefined ? undefined : asProfile(document)
    },

    async remember(identity: Identity): Promise<void> {
      const existing = await load(identity.sub)

      // The provider's address when it sends one, the stored address otherwise — never
      // nothing. `email` is optional in OIDC and `identityFrom` drops an empty one, so a later
      // sign-in without the claim is ordinary rather than malformed; dropping the field here
      // would unindex the account in `users.ts`, and sharing a project with that person would
      // answer "nobody with that address has an account yet".
      const email = identity.email ?? existing?.email

      // A returning user keeps their settings. The identity provider is authoritative about
      // who they are and says nothing about what they prefer — so `locale` is carried through
      // rather than reset, which is M4-3's second scenario ("existing account and the
      // preferences stored in _users are used").
      const document: UserDocument = {
        _id: userDocumentId(identity.sub),
        ...(existing?._rev === undefined ? {} : { _rev: existing._rev }),
        name: identity.sub,
        // Never widened here. Roles are how CouchDB decides what a user may reach, and a
        // sign-in is not the moment to grant any — M5 adds project roles deliberately.
        roles: existing?.roles ?? [],
        type: 'user',
        ...(email === undefined ? {} : { email }),
        // The provider's name is a default, not an override: someone who has set their own
        // display name should not have it replaced every time they sign in.
        displayName: existing?.displayName ?? identity.name ?? identity.sub,
        ...(existing?.locale === undefined ? {} : { locale: existing.locale }),
      }

      await couch.putDoc(USERS, document)
    },

    async update(sub: string, update: ProfileUpdate): Promise<Profile> {
      const existing = await load(sub)
      if (existing === undefined) {
        throw new Error(`No profile for ${sub}; a signed-in user always has one.`)
      }

      // Spread `existing` first so CouchDB's own fields — `name`, `roles`, `type` — are carried
      // through verbatim. A `_users` document that loses its `type` stops being a user, and the
      // account cannot authenticate afterwards; one that loses its roles loses every project.
      const document: UserDocument = {
        ...existing,
        locale: update.locale,
        ...(update.displayName === undefined ? {} : { displayName: update.displayName }),
      }

      await couch.putDoc(USERS, document)
      return asProfile(document)
    },

    async rolesOf(sub: string): Promise<readonly string[]> {
      return (await load(sub))?.roles ?? []
    },

    async setPlan(sub: string, plan: Plan): Promise<Profile> {
      const existing = await load(sub)
      if (existing === undefined) {
        throw new UnknownSubjectError(sub)
      }
      // Spread first, exactly as `update` does, so CouchDB's own fields survive. The difference
      // between this and `update` is not how it writes but who is allowed to call it.
      const document: UserDocument = { ...existing, plan }
      await couch.putDoc(USERS, document)
      return asProfile(document)
    },
  }
}
