/**
 * Matter onboarding payload: the contents of a device's commissioning QR code.
 *
 * The text form is `MT:` followed by a Base38-encoded, bit-packed struct. This module turns
 * that string into fields; {@link decodeBase38} handles the character encoding underneath.
 *
 * The struct is 88 bits, read as a little-endian bit stream in this order:
 *
 * | Field                  | Bits |
 * |------------------------|------|
 * | Version                | 3    |
 * | Vendor ID              | 16   |
 * | Product ID             | 16   |
 * | Custom flow            | 2    |
 * | Discovery capabilities | 8    |
 * | Discriminator          | 12   |
 * | Passcode               | 27   |
 * | Padding                | 4    |
 *
 * Because they share one stream, an off-by-one in any width shifts every later field. The
 * tests assert all of them together for that reason.
 *
 * @module
 */

import { Base38Error, decodeBase38 } from './base38.js'

/** How commissioning is expected to begin, from the 2-bit custom flow field. */
export type CustomFlow = 'standard' | 'userActionRequired' | 'custom' | 'reserved'

/** Which transports the device can be discovered on, from the 8-bit bitmask. */
export interface DiscoveryCapabilities {
  /** The device hosts a temporary Wi-Fi access point. */
  readonly softAp: boolean
  /** The device is discoverable over Bluetooth Low Energy. */
  readonly ble: boolean
  /** The device is already on an IP network. */
  readonly onNetwork: boolean
  /** The undecoded bitmask, so capabilities defined later are not lost. */
  readonly raw: number
}

/** The decoded contents of a Matter onboarding payload. */
export interface OnboardingPayload {
  readonly version: number
  readonly vendorId: number
  readonly productId: number
  readonly customFlow: CustomFlow
  readonly discovery: DiscoveryCapabilities
  readonly discriminator: number
  /** **Secret.** Never log this, and never send it to a third party. */
  readonly passcode: number
}

/** Thrown when a string is not a usable Matter onboarding payload. */
export class PayloadError extends Error {
  override readonly name = 'PayloadError'
}

/** Every Matter onboarding payload begins with this. */
export const PAYLOAD_PREFIX = 'MT:'

/** The packed struct occupies 88 bits, so exactly 11 bytes. */
const STRUCT_BYTES = 11

const CUSTOM_FLOWS: readonly CustomFlow[] = ['standard', 'userActionRequired', 'custom', 'reserved']

const DISCOVERY_SOFT_AP = 0b0000_0001
const DISCOVERY_BLE = 0b0000_0010
const DISCOVERY_ON_NETWORK = 0b0000_0100

/**
 * Reads `length` bits starting at `offset` from a little-endian bit stream.
 *
 * Uses BigInt because the passcode is 27 bits and lands at an offset that can push the
 * intermediate value past the range where JavaScript's bitwise operators are safe — they
 * coerce to 32-bit signed integers, which would silently corrupt the result rather than fail.
 */
function readBits(bytes: Uint8Array, offset: number, length: number): number {
  let value = 0n
  for (let i = 0; i < length; i++) {
    const bit = offset + i
    const byte = bytes[bit >> 3] as number
    if ((byte >> (bit & 7)) & 1) value |= 1n << BigInt(i)
  }
  return Number(value)
}

/**
 * Decodes a Matter onboarding payload into its fields.
 *
 * @param text The full payload, including the `MT:` prefix.
 * @returns Every field of the 88-bit struct.
 * @throws {PayloadError} If the prefix is missing, the body is not valid Base38, or it is
 *   too short to contain the struct. Never returns a partially populated result — a payload
 *   decoded halfway would describe a plausible device with the wrong passcode, which is a
 *   worse outcome than an error.
 */
export function decodePayload(text: string): OnboardingPayload {
  if (!text.startsWith(PAYLOAD_PREFIX)) {
    throw new PayloadError(
      `A Matter payload must begin with "${PAYLOAD_PREFIX}"; received ${JSON.stringify(
        text.slice(0, 8),
      )}.`,
    )
  }

  const body = text.slice(PAYLOAD_PREFIX.length)
  if (body.length === 0) {
    throw new PayloadError('The payload is empty: nothing follows the "MT:" prefix.')
  }

  let bytes: Uint8Array
  try {
    bytes = decodeBase38(body)
  } catch (cause) {
    if (cause instanceof Base38Error) {
      throw new PayloadError(`The payload body is not valid Base38: ${cause.message}`, { cause })
    }
    // Unreachable by construction - decodeBase38 throws only Base38Error - and deliberately
    // kept uncovered rather than removed. Wrapping everything would relabel a genuine bug
    // (a TypeError, say) as a malformed payload, sending the next person to inspect a QR
    // code that was fine.
    throw cause
  }

  if (bytes.length < STRUCT_BYTES) {
    throw new PayloadError(
      `The payload is too short: decoded ${bytes.length} bytes, but the struct needs ${STRUCT_BYTES} bytes.`,
    )
  }

  let offset = 0
  const take = (length: number): number => {
    const value = readBits(bytes, offset, length)
    offset += length
    return value
  }

  const version = take(3)
  const vendorId = take(16)
  const productId = take(16)
  const customFlow = CUSTOM_FLOWS[take(2)] as CustomFlow
  const raw = take(8)
  const discriminator = take(12)
  const passcode = take(27)

  return {
    version,
    vendorId,
    productId,
    customFlow,
    discovery: {
      softAp: (raw & DISCOVERY_SOFT_AP) !== 0,
      ble: (raw & DISCOVERY_BLE) !== 0,
      onNetwork: (raw & DISCOVERY_ON_NETWORK) !== 0,
      raw,
    },
    discriminator,
    passcode,
  }
}
