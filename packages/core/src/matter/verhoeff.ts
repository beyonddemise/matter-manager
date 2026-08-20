/**
 * Verhoeff check digit, as the Matter manual pairing code requires.
 *
 * A manual pairing code is read off a label and typed in by hand, so the errors that matter
 * are human ones: a mistyped digit and a pair of digits swapped. Verhoeff catches **all** of
 * both, which a simple checksum such as a digit sum does not — a sum cannot see a
 * transposition at all, because addition is commutative.
 *
 * The algorithm works in the dihedral group D5, where the operation is non-commutative;
 * that is precisely what makes order-dependent errors detectable. The three tables below are
 * the group's multiplication table, a permutation applied by position, and the inverse used
 * to turn the accumulated value into the digit that cancels it.
 *
 * The tables are data, not logic, so a transcription error would be invisible to inspection.
 * They are pinned instead by an externally verified vector in the tests, and by exhaustive
 * checks that every single-digit substitution and every adjacent transposition is caught.
 *
 * @module
 */

/** Multiplication in the dihedral group D5. */
const MULTIPLY: readonly (readonly number[])[] = [
  [0, 1, 2, 3, 4, 5, 6, 7, 8, 9],
  [1, 2, 3, 4, 0, 6, 7, 8, 9, 5],
  [2, 3, 4, 0, 1, 7, 8, 9, 5, 6],
  [3, 4, 0, 1, 2, 8, 9, 5, 6, 7],
  [4, 0, 1, 2, 3, 9, 5, 6, 7, 8],
  [5, 9, 8, 7, 6, 0, 4, 3, 2, 1],
  [6, 5, 9, 8, 7, 1, 0, 4, 3, 2],
  [7, 6, 5, 9, 8, 2, 1, 0, 4, 3],
  [8, 7, 6, 5, 9, 3, 2, 1, 0, 4],
  [9, 8, 7, 6, 5, 4, 3, 2, 1, 0],
]

/** The permutation applied to a digit according to its position, repeating every 8. */
const PERMUTE: readonly (readonly number[])[] = [
  [0, 1, 2, 3, 4, 5, 6, 7, 8, 9],
  [1, 5, 7, 6, 2, 8, 3, 0, 9, 4],
  [5, 8, 0, 3, 7, 9, 6, 1, 4, 2],
  [8, 9, 1, 6, 0, 4, 3, 5, 2, 7],
  [9, 4, 5, 3, 1, 2, 6, 8, 7, 0],
  [4, 2, 8, 6, 5, 7, 3, 9, 0, 1],
  [2, 7, 9, 3, 8, 0, 6, 4, 1, 5],
  [7, 0, 4, 6, 9, 1, 3, 2, 5, 8],
]

/** The inverse element, turning an accumulated value into the digit that cancels it. */
const INVERSE: readonly number[] = [0, 4, 3, 2, 1, 5, 6, 7, 8, 9]

const ONLY_DIGITS = /^\d+$/

/** Thrown when a string given to the check digit routines is not a run of digits. */
export class VerhoeffError extends Error {
  override readonly name = 'VerhoeffError'
}

/**
 * Folds the digits right to left through the group, which is where the order sensitivity
 * that catches transpositions comes from.
 */
function accumulate(digits: string): number {
  let value = 0
  for (let i = 0; i < digits.length; i++) {
    const digit = digits.charCodeAt(digits.length - 1 - i) - 48
    const permuted = (PERMUTE[i % 8] as readonly number[])[digit] as number
    value = (MULTIPLY[value] as readonly number[])[permuted] as number
  }
  return value
}

/**
 * Computes the check digit that should be appended to `digits`.
 *
 * @param digits The code without its check digit.
 * @returns A single digit, 0-9.
 * @throws {VerhoeffError} If the input is empty or contains anything but digits. Coercing a
 *   stray character to zero would return a plausible check digit for a different number.
 */
export function verhoeffCheckDigit(digits: string): number {
  if (!ONLY_DIGITS.test(digits)) {
    throw new VerhoeffError(
      `A Verhoeff check digit is defined only over digits; received ${JSON.stringify(digits)}.`,
    )
  }
  // The placeholder zero occupies the position the check digit will take, so that every
  // other digit is permuted by the position it will actually hold in the finished code.
  return INVERSE[accumulate(`${digits}0`)] as number
}

/**
 * Reports whether a complete code, check digit included, is self-consistent.
 *
 * Returns `false` for malformed input rather than throwing: this answers a yes/no question,
 * and a predicate that throws forces every caller to wrap it in a try/catch to ask it.
 */
export function isVerhoeffValid(digits: string): boolean {
  if (!ONLY_DIGITS.test(digits)) return false
  return accumulate(digits) === 0
}
