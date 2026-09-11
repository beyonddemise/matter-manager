/**
 * Reading whatever is printed on the device, in either of the two forms it comes in.
 *
 * A person holding a label does not first classify the string on it, so the interface offers
 * one field and this module decides. The two forms do **not** carry the same information, and
 * the asymmetry is the whole reason this file exists rather than a call to `decodePayload`:
 *
 * |                          | `MT:` payload | 21-digit code | 11-digit code |
 * |--------------------------|---------------|---------------|---------------|
 * | passcode                 | yes           | yes           | yes           |
 * | discriminator            | all 12 bits   | top 4 only    | top 4 only    |
 * | vendor and product id    | yes           | yes           | no            |
 * | discovery, flow, TLV     | yes           | no            | no            |
 *
 * A manual code is enough to commission a device — that is what it is for — but a payload
 * cannot be rebuilt from one. The missing eight discriminator bits are unrecoverable, and
 * inventing them would produce a well-formed `MT:` string whose QR code silently fails to
 * commission. For a catalogue whose entire purpose is to still work in five years, handing
 * back a code that looks right and is not is the worst available failure, so the fields a
 * manual code cannot supply are simply absent.
 *
 * @module
 */

import { deriveManualCode, parseManualCode } from './manual-code.js'
import { decodePayload, PAYLOAD_PREFIX, PayloadError } from './payload.js'

/**
 * What a setup code turned out to contain.
 *
 * Everything except {@link manualCode} is optional because a manual pairing code does not
 * carry it. See the table in the module note.
 */
export interface DeviceCredential {
  /**
   * The `MT:` payload, verbatim, when the input was one.
   *
   * **A secret**: it encodes the setup passcode. Never log it and never send it anywhere.
   */
  readonly payload?: string
  /**
   * Always present: derived from the payload, or the typed code reduced to its digits.
   *
   * **A secret**, for the same reason.
   */
  readonly manualCode: string
  readonly vendorId?: number
  readonly productId?: number
  /** The full twelve bits. Absent for a manual code, which carries only the top four. */
  readonly discriminator?: number
}

/** Whitespace and hyphens, as codes are grouped on a printed label. */
const SEPARATORS = /[\s-]/g

/** Matches the payload scheme case-insensitively, so a typed `mt:` reaches the decoder. */
const PAYLOAD_SCHEME = /^mt:/i

/**
 * Reads a setup code in either supported form.
 *
 * @param text The code as pasted or typed, with surrounding whitespace and separators allowed.
 * @returns Whatever the code carried; see {@link DeviceCredential} for what each form omits.
 * @throws {PayloadError} If the text is empty, or is neither a Matter payload nor a manual
 *   pairing code, or is one of those and malformed. The message never echoes the input — it
 *   contains the setup passcode — which is the same rule {@link decodePayload} and
 *   {@link parseManualCode} already keep.
 */
export function readCredential(text: string): DeviceCredential {
  const trimmed = text.trim()

  if (trimmed === '') {
    throw new PayloadError(
      'emptySetupCode',
      'Enter the setup code printed on the device or its packaging.',
    )
  }

  // Case-insensitive on purpose: a lower-case `mt:` is a payload that was typed rather than
  // scanned, and `decodePayload` says exactly that. Deciding here that it is "not a payload"
  // would send the user off to count digits instead.
  if (PAYLOAD_SCHEME.test(trimmed)) {
    const payload = decodePayload(trimmed)
    return {
      payload: trimmed,
      manualCode: deriveManualCode({
        discriminator: payload.discriminator,
        passcode: payload.passcode,
        vendorId: payload.vendorId,
        productId: payload.productId,
      }),
      vendorId: payload.vendorId,
      productId: payload.productId,
      discriminator: payload.discriminator,
    }
  }

  const digits = trimmed.replace(SEPARATORS, '')
  if (/^\d+$/.test(digits)) {
    const code = parseManualCode(digits)
    // Conditional spreads rather than `vendorId: code.vendorId`: under
    // `exactOptionalPropertyTypes` an explicit `undefined` is not assignable to `vendorId?`,
    // and the point of that setting is that "absent" and "present but unknown" stay distinct.
    return {
      manualCode: digits,
      ...(code.vendorId === undefined ? {} : { vendorId: code.vendorId }),
      ...(code.productId === undefined ? {} : { productId: code.productId }),
    }
  }

  throw new PayloadError(
    'notASetupCode',
    `A setup code is either a Matter payload beginning with "${PAYLOAD_PREFIX}" or a manual pairing code of 11 or 21 digits; this is neither.`,
  )
}
