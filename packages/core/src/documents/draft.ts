/**
 * What "add a device" and "edit a device" agree about.
 *
 * The two flows differ in exactly one input — the setup code, which only a new device carries —
 * and one output, `addedAt`. Everything else is the same decision made twice: the name must say
 * something, the room path must be well formed, the date must be a calendar date that exists,
 * and an existing room is matched rather than duplicated.
 *
 * Making it one decision is not tidiness. If the edit flow matched rooms by comparing paths
 * while the add flow matched by {@link roomPathKey}, then moving a device into
 * `ground floor / kitchen` would create a **second** `Ground Floor/Kitchen` — the duplicate
 * M1-5 and M2-5 exist to prevent, walking back in through the door nobody was watching.
 *
 * @module
 */

import {
  normaliseRoomPath,
  type RoomPathProblem,
  roomPathKey,
  roomPathProblem,
} from '../rooms/path.js'
import { documentId } from './ids.js'
import type { RoomDocument, Unsaved } from './types.js'

/** Which control the user has to go back to. A closed union, so a view cannot miss a case. */
export type DraftField = 'credential' | 'name' | 'room' | 'installedAt'

/**
 * A form that cannot become a device, and the field responsible.
 *
 * The field is the point. An error that can only say "something is wrong" makes the user hunt
 * across six controls, and this is a form where one of them contains a code they cannot read.
 */
export class DraftError extends Error {
  override readonly name = 'DraftError'
  readonly field: DraftField

  constructor(field: DraftField, message: string, options?: ErrorOptions) {
    super(message, options)
    this.field = field
  }
}

/**
 * The controls both forms have, as strings, exactly as the DOM reports them.
 *
 * `spot` and `serial` are optional here and *absent* rather than empty in the stored document;
 * see {@link optionalText}.
 */
export interface DeviceFields {
  readonly name: string
  /** A room path, typed or chosen. Matched against existing rooms by {@link roomPathKey}. */
  readonly room: string
  /** Free text the room name cannot carry: "ceiling, north end". */
  readonly spot?: string
  readonly serial?: string
  /** A calendar date, `YYYY-MM-DD`, as an `<input type="date">` reports it. */
  readonly installedAt: string
}

/** The two impure things adding a device needs, injected so `core` holds no ambient anything. */
export interface DraftClock {
  /** A fresh uuid per call; `crypto.randomUUID` at the impure boundary. */
  readonly uuid: () => string
  /** An ISO-8601 UTC timestamp, for `addedAt`. */
  readonly now: () => string
}

/** What each room-path problem means to someone looking at the field. */
const ROOM_PATH_MESSAGE: Readonly<Record<RoomPathProblem, string>> = {
  empty: 'A device needs a room. Type a name to create one, or pick an existing room.',
  emptySegment:
    'A room path is one or more non-empty names separated by "/", so "Ground Floor/Kitchen" works but a doubled or trailing "/" does not.',
}

/**
 * Whether a string is a calendar date that actually exists.
 *
 * The shape check alone is not enough: `2026-02-31` matches the pattern, and `new Date` rolls
 * it forward to 3 March rather than rejecting it, so a device would be filed under a date the
 * user never chose. Round-tripping through `toISOString` is what catches the roll.
 */
function isCalendarDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false
  const date = new Date(`${value}T00:00:00.000Z`)
  return !Number.isNaN(date.getTime()) && date.toISOString().startsWith(value)
}

/**
 * The device's name.
 *
 * @throws {DraftError} on `name` when it is blank.
 */
export function readName(value: string): string {
  const name = value.trim()
  if (name === '') {
    throw new DraftError('name', 'A device needs a name; that is what makes it findable later.')
  }
  return name
}

/**
 * The room path, normalised.
 *
 * @throws {DraftError} on `room`, with the message for the specific problem rather than a
 *   generic one — the two problems have different remedies.
 */
export function readRoomPath(value: string): string {
  const problem = roomPathProblem(value)
  if (problem !== null) throw new DraftError('room', ROOM_PATH_MESSAGE[problem])
  return normaliseRoomPath(value)
}

/**
 * The installation date.
 *
 * @throws {DraftError} on `installedAt` when it is not a date that exists.
 */
export function readInstalledAt(value: string): string {
  if (!isCalendarDate(value)) {
    throw new DraftError(
      'installedAt',
      'The installation date must be a real calendar date, written YYYY-MM-DD.',
    )
  }
  return value
}

/** An existing room reused, or a new one to write before the device that points at it. */
export interface RoomChoice {
  /** A full `room:<uuid>` id, ready to store in `DeviceDocument.roomId`. */
  readonly roomId: string
  /** Present only when the room does not exist yet. Write it first. */
  readonly room?: Unsaved<RoomDocument>
}

/**
 * Finds the room for a path, or plans a new one.
 *
 * By key, not by string: M1-5 already decided that `Ground Floor/Kitchen` and
 * `ground floor / kitchen` are the same room. Comparing paths directly here would be a second
 * answer to a question already answered, and the two would drift apart.
 *
 * @param path a normalised room path, from {@link readRoomPath}
 * @param rooms every room already in the project, passed in rather than read — this package
 *   does no I/O
 * @param uuid the uuid source, used only when the room is new
 */
export function chooseRoom(
  path: string,
  rooms: readonly RoomDocument[],
  uuid: () => string,
): RoomChoice {
  const key = roomPathKey(path)
  const existing = rooms.find((room) => roomPathKey(room.path) === key)
  if (existing !== undefined) return { roomId: existing._id }

  const roomId = documentId('room', uuid())
  return { roomId, room: { _id: roomId, type: 'room', path } }
}

/**
 * Optional free text: kept when it says something, absent when it is only whitespace.
 *
 * Returns a spreadable fragment rather than a string, because "absent" and "present and empty"
 * are different documents under `exactOptionalPropertyTypes` — and absent is the true one. An
 * empty string reads back as a spot that exists and says nothing.
 */
export function optionalText<K extends string>(
  key: K,
  value: string | undefined,
): { [P in K]?: string } {
  const text = value?.trim() ?? ''
  return text === '' ? {} : ({ [key]: text } as { [P in K]?: string })
}
