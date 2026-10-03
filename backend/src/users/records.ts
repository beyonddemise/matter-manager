/**
 * User records in `matter_manager`: profile, plan, operator roles and refresh-token hashes.
 *
 * Replaces the old CouchDB user-database document entirely (see the spec, "What moves off _users"). A record
 * exists only once something needed one. A user without a record is `free`, and their profile is
 * built from their token's claims by {@link profileOf}.
 *
 * **Updates name their fields.** Every write spreads the stored document and then applies
 * specific fields, never a request body, so `roles`, `plan`, `sub`, `email` and
 * `refreshTokens` cannot be set by the user they describe. A user who could write `roles`
 * could make themselves an operator, and every gate that reads roles would then mean nothing.
 *
 * @module
 */

import type { CouchClient } from '../couch/client.js'
import { CouchError } from '../couch/client.js'
import { type Plan, PROJECT_LIMITS } from '../domain/index.js'
import { BY_SUB_DESIGN, BY_SUB_VIEW, ensureUsersDatabase, USERS_DB } from './database.js'
import { userDocId } from './key.js'

/** What a user may choose. `auto` follows the browser, as the contract says. */
export type Locale = 'auto' | 'en' | 'de'

/** The locales the interface has. A value outside this is a preference nothing can honour. */
export const LOCALES: readonly Locale[] = ['auto', 'en', 'de']

/** Whether a value is a locale this interface can honour. */
export function isLocale(value: unknown): value is Locale {
  return typeof value === 'string' && (LOCALES as readonly string[]).includes(value)
}

/**
 * Whether a value is a plan this build knows. A plan is typed by an operator in Fauxton, so
 * anything may be there; this is the single place a stored string becomes a {@link Plan}.
 */
export function isPlan(value: unknown): value is Plan {
  return value === 'free' || value === 'member' || value === 'pro'
}

/** The profile as the contract describes it. */
export interface Profile {
  readonly sub: string
  readonly email: string
  readonly displayName: string
  readonly locale: Locale
  /** What the account may do. Absent from the record means `free`; see {@link isPlan}. */
  readonly plan: Plan
  /**
   * How many projects this plan may own, with **`-1` for unlimited**.
   *
   * Derived from {@link PROJECT_LIMITS} rather than stored, so it cannot disagree with the limit
   * the gate actually enforces. A number that said one thing while `can.ts` did another would be
   * worse than no number at all: the page would offer a slot the API then refuses.
   *
   * Reported because the page has to render "3 of 5 used" before it has tried anything, and the
   * alternative is a client-side copy of the policy table, which ADR 0009 exists to prevent.
   * The `-1` is a sentinel and must be tested before it is compared; see `withinLimit`.
   */
  readonly projectLimit: number
}

/** What a user may change about themselves. */
export interface ProfileUpdate {
  readonly locale?: Locale
  readonly displayName?: string
}

/** One device's refresh token, as stored: never the token, only its hash. */
export interface RefreshEntry {
  /** `sha256(jti)`, lowercase hex. */
  readonly hash: string
  /** Seconds since the epoch. */
  readonly exp: number
  /** Seconds since the epoch. */
  readonly createdAt: number
}

/** The stored document. */
export interface UserRecord {
  readonly _id: string
  readonly _rev?: string
  readonly type: 'user'
  /** Absent on a record an operator created by address before its owner ever signed in. */
  readonly sub?: string
  readonly email: string
  readonly displayName?: string
  readonly locale?: Locale
  /** `string`, not `Plan`: hand-edited by operators, narrowed only by {@link planOf}. */
  readonly plan?: string
  /** Set by hand in Fauxton. Only `customerservice` is read. */
  readonly roles?: readonly string[]
  readonly refreshTokens?: readonly RefreshEntry[]
}

/** What a sign-in knows about a person. */
export interface Seed {
  readonly email: string
  readonly sub: string
  readonly name?: string
}

/** Where an unrecognised plan is reported. */
export type UnknownPlanReporter = (event: { readonly email: string; readonly plan: string }) => void

/**
 * Where an unrecognised plan is reported when nobody says otherwise: one JSON line on stderr,
 * in pino's field names. A no-op default would hide operator typos, and the deployment that
 * forgot to wire a reporter would have exactly the silence this exists to end.
 */
const reportToStderr: UnknownPlanReporter = ({ email, plan }) => {
  console.warn(
    JSON.stringify({
      level: 'warn',
      msg: 'unknown plan on a user record; this account is being treated as free',
      email,
      plan,
    }),
  )
}

/**
 * The plan a record grants: `free` without a record, without a plan, or with one this build
 * does not know. Only a value that is present and unknown is reported, because an absent plan
 * is the ordinary case and warning on it would teach operators to filter the warning out.
 */
export function planOf(
  record: UserRecord | undefined,
  report: UnknownPlanReporter = reportToStderr,
): Plan {
  if (record?.plan === undefined) return 'free'
  if (isPlan(record.plan)) return record.plan
  report({ email: record.email, plan: record.plan })
  return 'free'
}

/**
 * The profile for a caller, from their record if there is one and from their token otherwise.
 *
 * `projectLimit` is looked up, never compared against a tier (ADR 0009).
 */
export function profileOf(
  record: UserRecord | undefined,
  claims: { readonly sub: string; readonly email: string; readonly name?: string },
  report: UnknownPlanReporter = reportToStderr,
): Profile {
  const plan = planOf(record, report)
  return {
    sub: record?.sub ?? claims.sub,
    email: record?.email ?? claims.email,
    displayName: record?.displayName ?? claims.name ?? claims.sub,
    locale: isLocale(record?.locale) ? record.locale : 'auto',
    plan,
    projectLimit: PROJECT_LIMITS[plan],
  }
}

/** The store. Every method that writes retries on a lost race; see {@link userRecords}. */
export interface UserRecords {
  read(email: string): Promise<UserRecord | undefined>
  readBySub(sub: string): Promise<UserRecord | undefined>
  /** Creates the record, or fills in `sub` on one an operator created. Appends `adopt`. */
  ensure(seed: Seed, adopt?: readonly RefreshEntry[]): Promise<UserRecord>
  /** @throws {Error} when there is no record; callers ensure one first. */
  update(email: string, update: ProfileUpdate): Promise<UserRecord>
  /** Creates the record when there is none. Who may call this is the route's decision. */
  setPlan(email: string, plan: Plan): Promise<UserRecord>
  /** `false` when there is no record to hold the entry. */
  addRefresh(email: string, entry: RefreshEntry): Promise<boolean>
  /** `undefined` when there is no record, so the caller knows to look in memory instead. */
  hasRefresh(email: string, hash: string, now: number): Promise<boolean | undefined>
  removeRefresh(email: string, hash: string): Promise<void>
}

/** How many times a write is attempted before a 409 is allowed to escape. */
const WRITE_ATTEMPTS = 3

/**
 * Creates the store.
 *
 * Writes go through `mutate`, which re-reads and re-applies on a 409. Refresh entries are
 * written by every device of a user, and two devices refreshing in the same second is ordinary.
 * Without the retry, one of them would lose its entry and be signed out at its next refresh,
 * for no reason it could see.
 */
export function userRecords(couch: CouchClient): UserRecords {
  const get = async (email: string): Promise<UserRecord | undefined> => {
    await ensureUsersDatabase(couch)
    return couch.getDoc<UserRecord>(USERS_DB, userDocId(email))
  }

  /** Read, change, write; on conflict, again. `change` returns `undefined` to write nothing. */
  const mutate = async (
    email: string,
    change: (existing: UserRecord | undefined) => UserRecord | undefined,
  ): Promise<UserRecord | undefined> => {
    for (let attempt = 1; ; attempt += 1) {
      const existing = await get(email)
      const next = change(existing)
      if (next === undefined) return existing
      try {
        const { rev } = await couch.putDoc(USERS_DB, next)
        return { ...next, _rev: rev }
      } catch (error) {
        const lost = error instanceof CouchError && error.status === 409
        if (!lost || attempt >= WRITE_ATTEMPTS) throw error
      }
    }
  }

  return {
    read: get,

    async readBySub(sub) {
      await ensureUsersDatabase(couch)
      // The client JSON-encodes view parameters itself; encoding here would double-quote the key.
      const { rows } = await couch.view<{ id: string }>(USERS_DB, BY_SUB_DESIGN, BY_SUB_VIEW, {
        key: sub,
      })
      const id = rows[0]?.id
      return id === undefined ? undefined : couch.getDoc<UserRecord>(USERS_DB, id)
    },

    async ensure(seed, adopt = []) {
      const written = await mutate(seed.email, (existing) => {
        const tokens = [...(existing?.refreshTokens ?? []), ...adopt]
        if (existing !== undefined && existing.sub === seed.sub && adopt.length === 0) {
          return undefined
        }
        return {
          ...(existing ?? { _id: userDocId(seed.email), type: 'user' as const }),
          sub: seed.sub,
          email: existing?.email ?? seed.email.trim(),
          // The provider's name is a default, never an override of one the user chose.
          ...(existing?.displayName === undefined && seed.name !== undefined
            ? { displayName: seed.name }
            : {}),
          ...(tokens.length === 0 ? {} : { refreshTokens: tokens }),
        }
      })
      // `mutate` returns the existing record when nothing needed writing.
      return written as UserRecord
    },

    async update(email, update) {
      const written = await mutate(email, (existing) => {
        if (existing === undefined) {
          throw new Error(`No record for ${email}; ensure one before updating it.`)
        }
        return {
          ...existing,
          ...(update.locale === undefined ? {} : { locale: update.locale }),
          ...(update.displayName === undefined ? {} : { displayName: update.displayName }),
        }
      })
      return written as UserRecord
    },

    async setPlan(email, plan) {
      const written = await mutate(email, (existing) => ({
        ...(existing ?? { _id: userDocId(email), type: 'user' as const, email: email.trim() }),
        plan,
      }))
      return written as UserRecord
    },

    async addRefresh(email, entry) {
      let held = false
      await mutate(email, (existing) => {
        if (existing === undefined) {
          held = false
          return undefined
        }
        held = true
        return { ...existing, refreshTokens: [...(existing.refreshTokens ?? []), entry] }
      })
      return held
    },

    async hasRefresh(email, hash, now) {
      const record = await get(email)
      if (record === undefined) return undefined
      return (record.refreshTokens ?? []).some((e) => e.hash === hash && e.exp > now)
    },

    async removeRefresh(email, hash) {
      await mutate(email, (existing) => {
        if (existing === undefined) return undefined
        const kept = (existing.refreshTokens ?? []).filter((e) => e.hash !== hash)
        if (kept.length === (existing.refreshTokens ?? []).length) return undefined
        return { ...existing, refreshTokens: kept }
      })
    },
  }
}
