/**
 * Who the application believes is acting.
 *
 * One function, so that M4 has exactly one place to replace when sign-in exists. Every caller
 * that needs to attribute something — a remark now, an audit entry later — goes through here
 * rather than reaching for a session of its own, because the failure mode of several answers
 * to "who is this" is documents attributed inconsistently, which is not visible until someone
 * tries to read the history back.
 *
 * @module
 */

import type { RemarkAuthor } from '@matter-manager/core'

/**
 * The subject claim written while the catalogue is local-only.
 *
 * A literal rather than an empty string, because the field is what a later reader matches on:
 * `local` says "written on a device before this project had accounts", which is true and
 * distinguishable from a real provider subject (`auth0|…`, `google|…`) forever after. An empty
 * string would be indistinguishable from a bug that failed to set one.
 */
export const LOCAL_AUTHOR_SUB = 'local'

/**
 * Who to attribute a write to.
 *
 * The name is empty until M4-5 gives the user a profile. That is deliberate rather than a
 * placeholder: `authorName` is stored verbatim and never resolved again, so writing a
 * translated string like "You" would put one reader's language permanently into another
 * reader's document — and "You" is false the moment anyone else opens the project. An empty
 * name is a fact the view can render in the reader's own language.
 */
export function currentAuthor(): RemarkAuthor {
  return { sub: LOCAL_AUTHOR_SUB, name: '' }
}
