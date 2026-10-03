/**
 * One line per successful sign-in.
 *
 * Sign-in creates no record (most people who sign in never use the product), so this line is
 * the only trace that they came. `console.log` for now; #212 replaces it with a sink that has
 * retention and a PII policy for the address.
 *
 * @module
 */

/** What is recorded about a sign-in. */
export interface SignInEvent {
  readonly sub: string
  readonly email: string
  readonly provider: string
  /** Whether the person already had, or now has, a user record. */
  readonly hasRecord: boolean
}

/** Where sign-ins are recorded. */
export type SignInLogger = (event: SignInEvent) => void

/** The default: one JSON object on stdout, in pino's field names. */
export const consoleSignInLog =
  (clock: () => Date = () => new Date()): SignInLogger =>
  (event) => {
    console.log(
      JSON.stringify({ level: 'info', msg: 'sign-in', at: clock().toISOString(), ...event }),
    )
  }
