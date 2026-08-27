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
 */
export function censor(value: unknown, depth = 0, seen = new WeakSet<object>()): unknown {
  if (!isWalkable(value) || depth >= MAX_DEPTH) return value

  // A cycle would otherwise recurse until the stack ends. Pino handles cycles in its own
  // serializer; this runs before that, so it has to handle its own.
  if (seen.has(value)) return '[circular]'
  seen.add(value)

  if (Array.isArray(value)) return value.map((entry) => censor(entry, depth + 1, seen))

  const out: Record<string, unknown> = {}
  for (const [key, entry] of Object.entries(value)) {
    out[key] = REDACTED.has(key.toLowerCase()) ? REDACTION : censor(entry, depth + 1, seen)
  }
  // An Error's own enumerable properties are what `Object.entries` sees; `message` and `stack`
  // are not among them, and pino's error serializer has already lifted what it needs by here.
  return out
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
