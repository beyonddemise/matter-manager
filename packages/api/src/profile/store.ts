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
}

/** CouchDB's own id scheme for a user. */
export const userDocumentId = (sub: string): string => `org.couchdb.user:${sub}`

/** The database CouchDB keeps users in. */
const USERS = '_users'

export interface ProfileStore {
  /** The profile, or `undefined` when the user has never signed in. */
  read(sub: string): Promise<Profile | undefined>
  /** Creates or updates the user from what the identity provider said. */
  remember(identity: Identity): Promise<void>
  /** Applies what the user chose. Returns the profile as stored. */
  update(sub: string, update: ProfileUpdate): Promise<Profile>
}

/** Whether a value is a locale this interface can honour. */
export function isLocale(value: unknown): value is Locale {
  return typeof value === 'string' && (LOCALES as readonly string[]).includes(value)
}

/** A `_users` document as a profile, filling in what CouchDB does not hold. */
function toProfile(document: UserDocument): Profile {
  return {
    sub: document.name,
    email: document.email ?? '',
    displayName: document.displayName ?? document.name,
    // `auto` rather than a stored default. A profile that has never chosen and one that chose
    // `auto` are the same thing to the interface, and writing `en` in for a new user would give
    // a German-speaking visitor an English interface they never asked for.
    locale: isLocale(document.locale) ? document.locale : 'auto',
  }
}

export function profileStore(couch: CouchClient): ProfileStore {
  const load = (sub: string) => couch.getDoc<UserDocument>(USERS, userDocumentId(sub))

  return {
    async read(sub: string): Promise<Profile | undefined> {
      const document = await load(sub)
      return document === undefined ? undefined : toProfile(document)
    },

    async remember(identity: Identity): Promise<void> {
      const existing = await load(identity.sub)

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
        ...(identity.email === undefined ? {} : { email: identity.email }),
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
      return toProfile(document)
    },
  }
}
