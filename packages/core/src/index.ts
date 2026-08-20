/**
 * `@matter-manager/core` - the pure domain layer.
 *
 * Everything exported here is a function over plain data. No I/O, no DOM, no network, no
 * database. That constraint is load-bearing rather than stylistic: this package holds the
 * logic that can actually be wrong, so it has to be exhaustively testable in milliseconds
 * with no setup, and reusable unchanged by the browser app and the API server alike.
 *
 * If something here needs a browser or a database to test, it is two things tangled
 * together - a pure decision and an impure action. Split them and leave only the decision.
 *
 * @module
 */

export { BASE38_ALPHABET, Base38Error, decodeBase38, encodeBase38 } from './matter/base38.js'
export {
  deriveManualCode,
  type ManualCode,
  type ManualCodeInput,
  parseManualCode,
} from './matter/manual-code.js'
export {
  type CustomFlow,
  type DiscoveryCapabilities,
  decodePayload,
  encodePayload,
  type OnboardingPayload,
  PAYLOAD_PREFIX,
  PayloadError,
} from './matter/payload.js'
export { isVerhoeffValid, VerhoeffError, verhoeffCheckDigit } from './matter/verhoeff.js'
