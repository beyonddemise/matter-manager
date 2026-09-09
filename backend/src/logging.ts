/**
 * What must never reach a log, and the configuration that stops it.
 *
 * M4-1 asks for this **before there is anything to redact**, and that ordering is the whole
 * point. A redaction list added after an incident is a list written by someone reading a log
 * file that already contains the thing. Added first, it is a list written by someone reasoning
 * about what the application holds.
 *
 * What this application holds is setup passcodes. A Matter payload encodes one, and a manual
 * pairing code *is* one — so either, in a log line, is a credential in a file that gets
 * rotated to disk, shipped to a log service, and read by whoever is debugging something else.
 *
 * @module
 */

/**
 * Field names whose values are replaced wherever they appear.
 *
 * Names rather than paths, applied at every depth: a payload is a payload whether it arrives
 * as a body field, inside an array of devices, or nested in an error someone attached context
 * to. A path-based list protects the shapes that were thought of.
 *
 * `authorization` and `cookie` are here for the ordinary reason. The Matter fields are here
 * for this application's reason, and are the ones a general-purpose default would miss.
 */
export const REDACTED_FIELDS: readonly string[] = [
  // Credentials this service handles.
  'authorization',
  'cookie',
  'set-cookie',
  'password',
  'token',
  'access_token',
  'refresh_token',
  'id_token',
  'client_secret',
  'code',
  'code_verifier',
  // Credentials this *application* is about. See the module note.
  'payload',
  'manualCode',
  'passcode',
  'setupPasscode',
  'discriminator',
]

/** What replaces a redacted value. Says a value was there, which an absence would not. */
export const REDACTION = '[redacted]'

/** Lower-cased once, because header names arrive in whatever case the client sent. */
const REDACTED = new Set(REDACTED_FIELDS.map((field) => field.toLowerCase()))

/**
 * How deep to walk before giving up.
 *
 * A bound rather than trust: a log object is built from request data, and an attacker who can
 * nest ten thousand objects should get a truncated log line rather than a stack overflow in the
 * logger. Twelve is far past anything this service logs deliberately.
 */
const MAX_DEPTH = 12

/** What replaces anything below {@link MAX_DEPTH}. Withheld, not omitted, as everywhere here. */
const TOO_DEEP = '[too deep to redact]'

/** Whether this is something to walk into rather than a value to keep. */
const isWalkable = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' &&
  value !== null &&
  !(value instanceof Date) &&
  !(value instanceof RegExp) &&
  !Buffer.isBuffer(value)

/**
 * Replaces every redacted field, wherever it is.
 *
 * **Pino's `redact` cannot do this, and used to be asked to.** Its wildcards are not recursive:
 * `*.payload` matches one level and `*.*.payload` two, so a list of `[field, *.field,
 * *.*.field]` covers depths nought to two and nothing below. `{ err: { cause: { request: {
 * payload } } } }` — an error somebody attached a request to, which is an ordinary shape — went
 * to the log in clear. The module note above already said the list was applied "at every
 * depth"; this is what makes that true rather than intended.
 *
 * Errors are copied rather than mutated: the object being logged belongs to the caller, and a
 * logger that redacted in place would blank the field for whatever runs next.
 *
 * @returns a censored copy; the value itself only when there is nothing to walk into.
 */
export function censor(value: unknown, depth = 0, seen = new WeakSet<object>()): unknown {
  if (!isWalkable(value)) return value

  // **Fails closed.** Returning the value here would serialise everything below the bound
  // untouched, which would make nesting past it a way to publish a secret rather than a way to
  // lose one. The marker says something was withheld, which is what the censor is for.
  if (depth >= MAX_DEPTH) return TOO_DEEP

  // A cycle would otherwise recurse until the stack ends. Pino handles cycles in its own
  // serializer; this runs before that, so it has to handle its own.
  if (seen.has(value)) return '[circular]'
  seen.add(value)

  if (value instanceof Error) return censorError(value, depth, seen)

  if (Array.isArray(value)) return value.map((entry) => censor(entry, depth + 1, seen))

  const out: Record<string, unknown> = {}
  for (const [key, entry] of Object.entries(value)) {
    out[key] = REDACTED.has(key.toLowerCase()) ? REDACTION : censor(entry, depth + 1, seen)
  }
  return out
}

/**
 * An error, with its context censored and everything that makes it an error kept.
 *
 * **`message` and `stack` are non-enumerable own properties**, so `Object.entries` does not see
 * them. Rebuilding an error as a plain object therefore produces a log line that records that
 * something failed and nothing whatever about what — and `main.ts` logs `{ err: error }` on a
 * failed start and a failed shutdown, which are the two lines most worth reading.
 *
 * A copy rather than the original with fields overwritten: the error belongs to the caller, and
 * a logger that redacted in place would blank the field for whatever handles it next.
 */
function censorError(error: Error, depth: number, seen: WeakSet<object>): Error {
  const copy = new Error(error.message)
  copy.name = error.name
  if (error.stack !== undefined) copy.stack = error.stack
  // Enumerable when assigned, non-enumerable when passed to the constructor — so it is carried
  // explicitly rather than left to the loop below to find.
  if (error.cause !== undefined) copy.cause = censor(error.cause, depth + 1, seen)

  for (const [key, entry] of Object.entries(error)) {
    ;(copy as unknown as Record<string, unknown>)[key] = REDACTED.has(key.toLowerCase())
      ? REDACTION
      : censor(entry, depth + 1, seen)
  }
  return copy
}

/**
 * The logging options this service uses.
 *
 * A **formatter** rather than `redact`, because `redact` is path-based and this list is a list
 * of names — see {@link censor}. Spread into pino's options, so that the test suite configures
 * a logger exactly as `server.ts` does rather than approximately.
 *
 * `censor` rather than `remove`, so a log line says a field was present and withheld. Removing
 * it makes a redacted request indistinguishable from one that never carried the field, which
 * is exactly the distinction someone reading the log is trying to make.
 */
export function redactionOptions(): {
  readonly formatters: {
    readonly log: (object: Record<string, unknown>) => Record<string, unknown>
  }
} {
  return {
    formatters: {
      log: (object) => censor(object) as Record<string, unknown>,
    },
  }
}
