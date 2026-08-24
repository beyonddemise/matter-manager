/**
 * Which setup passcodes a Matter device may actually have.
 *
 * The specification forbids a handful of values because they are guessable: a passcode of
 * `11111111` or `12345678` would be the first thing anyone tried. A device whose label shows
 * one is misprinted or counterfeit, and the person holding it should learn that while they
 * are still standing in front of it rather than after filing it away.
 *
 * **These rules report; they do not refuse.** The codec in `payload.ts` and `manual-code.ts`
 * stays permissive on purpose, and this module deliberately throws nothing.
 *
 * A decoder that rejected an invalid passcode would make its own diagnosis impossible: the
 * application could no longer show the user what their label actually says, which is exactly
 * the information needed to explain the problem or to file a complaint with a manufacturer.
 * Faithful representation is the codec's job; judging what was represented is this module's.
 * Refusing to store or commission such a device is then a decision the application makes, in
 * one place, with the reason in hand.
 *
 * Rules verified against `PayloadContents::IsValidSetupPIN` in the connectedhomeip reference
 * implementation rather than recalled.
 *
 * @module
 */

/**
 * Why a passcode cannot be used.
 *
 * A code rather than a sentence, deliberately. These reach the user interface, which is
 * translated (`en` and `de` from M2 onward); an English string decided here could not be.
 * The wording belongs with the translations, and the reason belongs here.
 */
export type PasscodeProblem =
  /** Not a whole number at all: negative, fractional, `NaN` or infinite. */
  | 'notAWholeNumber'
  /** A whole number, but outside 1 to 99999998 — which includes zero. */
  | 'outOfRange'
  /** In range, but one of the values the specification forbids as guessable. */
  | 'forbidden'

/** The lowest usable passcode. Zero marks an undefined passcode and is not usable. */
export const MIN_PASSCODE = 1

/**
 * The highest usable passcode.
 *
 * Note this is below what 27 bits can hold (134217727). A payload can therefore carry a
 * passcode that decodes perfectly well and is still not one a compliant device may use.
 */
export const MAX_PASSCODE = 99999998

/**
 * The values the specification forbids outright.
 *
 * Ten, not eleven: `99999999` is excluded by {@link MAX_PASSCODE} rather than enumerated, so
 * there are eight repeated-digit entries here and not nine. The behaviour is identical either
 * way; the distinction only matters to whoever edits this list next.
 */
export const FORBIDDEN_PASSCODES: ReadonlySet<number> = new Set([
  11111111, 22222222, 33333333, 44444444, 55555555, 66666666, 77777777, 88888888, 12345678,
  87654321,
])

/**
 * Reports why a passcode cannot be used, or `null` when it can.
 *
 * @param passcode The passcode to judge, typically from {@link decodePayload}.
 * @returns The reason it is unusable, or `null` if it is fine.
 */
export function passcodeProblem(passcode: number): PasscodeProblem | null {
  if (!Number.isInteger(passcode)) return 'notAWholeNumber'
  if (passcode < MIN_PASSCODE || passcode > MAX_PASSCODE) return 'outOfRange'
  // Matched by equality rather than by shape. A rule such as "any run of repeated digits"
  // would reject legitimate passcodes that merely look repetitive, and the specification
  // enumerates rather than describes.
  if (FORBIDDEN_PASSCODES.has(passcode)) return 'forbidden'
  return null
}

/** Whether a passcode is one a compliant device may use. See {@link passcodeProblem}. */
export function isValidPasscode(passcode: number): boolean {
  return passcodeProblem(passcode) === null
}
