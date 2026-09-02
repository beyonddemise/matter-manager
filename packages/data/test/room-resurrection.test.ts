import { type DeletedRoom, resurrectedRooms } from '@matter-manager/core'
import { describe, expect, it } from 'vitest'
import { reconnect, replicas, syncOnce } from './support/memory-database.js'

/**
 * #125, through real replication rather than a stub.
 *
 * The scenario, exactly as the issue writes it: two people, both offline. One deletes a room;
 * the other renames it. Both reconnect. The rename wins — always — and the person who deleted
 * the room finds it back under a name they have never seen.
 *
 * This file proves the two halves the explanation depends on, and it uses the three-database
 * harness from #53 because a stub would let the test decide what replication does. The whole
 * question is what replication *actually* does, and it was contrary to what the code assumed
 * twice before (L32).
 */

const room = (id: string, path: string) => ({
  _id: id,
  type: 'room' as const,
  path,
  updatedAt: '2026-09-02T09:00:00.000Z',
})

/** Room deleted on device A, renamed on device B, both reconnecting. */
async function raced() {
  const three = replicas()
  const { deviceA, server, deviceB } = three

  await server.put(room('room:kitchen', 'Kitchen'))
  await syncOnce(deviceA, server)
  await syncOnce(deviceB, server)

  const onA = await deviceA.get('room:kitchen')
  await deviceA.remove(onA)

  const onB = (await deviceB.get('room:kitchen')) as { _id: string; _rev: string }
  await deviceB.put({ ...onB, path: 'Cocina', updatedAt: '2026-09-02T10:00:00.000Z' })

  await reconnect(three)
  return three
}

/** Every room device A can see, as the rooms view would read them. */
async function roomsOn(database: PouchDB.Database) {
  const result = await database.allDocs({ include_docs: true, startkey: 'room:', endkey: 'room:￰' })
  return result.rows.flatMap((row) => (row.doc === undefined ? [] : [row.doc as never]))
}

describe('a deletion that loses to a rename', () => {
  it('leaves the room alive on the device that deleted it', async () => {
    // The premise. If this were false there would be nothing to explain — and it is the fact
    // the issue had to establish against PouchDB rather than reason about.
    const { deviceA } = await raced()

    const back = (await deviceA.get('room:kitchen')) as { path: string }
    expect(back.path).toBe('Cocina')
  })

  it('is recognised by the device that deleted it', async () => {
    // The signal #125 asked for, end to end: the deleting device's own record plus the list it
    // reads anyway. No second read, no `open_revs`, nothing the merge could not be given.
    const { deviceA } = await raced()

    const remembered: DeletedRoom[] = [
      { roomId: 'room:kitchen', path: 'Kitchen', deletedAt: '2026-09-02T09:30:00.000Z' },
    ]
    const returned = resurrectedRooms(remembered, await roomsOn(deviceA))

    expect(returned).toHaveLength(1)
    expect(returned[0]?.deleted.path).toBe('Kitchen')
    expect(returned[0]?.room.path).toBe('Cocina')
  })

  it('is invisible to the device that renamed it', async () => {
    // The second scenario. Device B deleted nothing, so it has no record — and needs no rule
    // suppressing the message, because there is no input to produce one.
    const { deviceB } = await raced()

    expect(resurrectedRooms([], await roomsOn(deviceB))).toEqual([])
  })

  it('shows the rename standing on both devices', async () => {
    // Nothing here changes the outcome, and that is deliberate: the deletion still loses, no
    // device is orphaned, and making it win would need `open_revs: 'all'` on every read.
    const { deviceA, deviceB } = await raced()

    expect(((await deviceA.get('room:kitchen')) as { path: string }).path).toBe('Cocina')
    expect(((await deviceB.get('room:kitchen')) as { path: string }).path).toBe('Cocina')
  })
})
