import { beforeEach, describe, expect, it, vi } from 'vitest'
import { refreshStore } from '../../src/auth/refresh-store.js'
import { forgetUsersDatabase } from '../../src/users/database.js'
import { recordEnsurer } from '../../src/users/ensure.js'
import { userRecords } from '../../src/users/records.js'
import { fakeCouch } from '../support/couch.js'

const ADA = { email: 'ada@example.com', sub: 'google|1' }

beforeEach(() => forgetUsersDatabase())

describe('recordEnsurer', () => {
  it('moves in-memory refresh entries onto the new record, so creating it signs nobody out', async () => {
    const { couch } = fakeCouch()
    const records = userRecords(couch)
    const refresh = refreshStore(records, () => 0)
    await refresh.remember(ADA.email, { hash: 'h', exp: 99, createdAt: 0 })

    await recordEnsurer(records, refresh)(ADA)

    expect(await records.hasRefresh(ADA.email, 'h', 0)).toBe(true)
    expect(await refresh.isLive(ADA.email, 'h')).toBe(true)
  })

  it('puts the entries back in memory when the write fails', async () => {
    const { couch } = fakeCouch()
    const records = userRecords(couch)
    const refresh = refreshStore(records, () => 0)
    await refresh.remember(ADA.email, { hash: 'h', exp: 99, createdAt: 0 })
    vi.spyOn(records, 'ensure').mockRejectedValueOnce(new Error('couch down'))

    await expect(recordEnsurer(records, refresh)(ADA)).rejects.toThrow('couch down')
    expect(await refresh.isLive(ADA.email, 'h')).toBe(true)
  })
})
