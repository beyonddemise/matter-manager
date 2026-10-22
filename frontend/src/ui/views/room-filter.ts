/**
 * The device list filtered to one room, as an address: `#/devices?room=Ground%20Floor%2FKitchen`.
 *
 * The Rooms page writes it and the device list reads it. Kept apart from both, so neither view
 * imports the other.
 *
 * @module
 */

/**
 * The room the address filters the list to: `#/devices?room=Ground%20Floor%2FKitchen`.
 *
 * `undefined` when there is no `room` parameter or it is blank. The router ignores the query
 * (`router/match.ts`), so the route stays `/devices` and only this view reads it.
 *
 * @param hash `location.hash`
 */
export function roomFromHash(hash: string): string | undefined {
  const at = hash.indexOf('?')
  if (at === -1) return undefined
  const room = new URLSearchParams(hash.slice(at + 1)).get('room')?.trim()
  return room === undefined || room === '' ? undefined : room
}

/** The address of the device list filtered to one room. What the Rooms page links to. */
export function devicesInRoomHref(path: string): string {
  return `#/devices?${new URLSearchParams({ room: path }).toString()}`
}
