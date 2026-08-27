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

/**
 * Pino's `redact` configuration.
 *
 * `censor` rather than `remove`, so a log line says a field was present and withheld. Removing
 * it makes a redacted request indistinguishable from one that never carried the field, which
 * is exactly the distinction someone reading the log is trying to make.
 */
export function redactionOptions(): { readonly paths: string[]; readonly censor: string } {
  return {
    // `*.name` syntax matches the field at any depth, which is what makes this a list of
    // *names* rather than of the shapes that were anticipated.
    paths: REDACTED_FIELDS.flatMap((field) => [field, `*.${field}`, `*.*.${field}`]),
    censor: REDACTION,
  }
}
