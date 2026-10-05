import { describe, expect, it } from 'vitest'
import { renderSyncStatus, syncStatusOf } from '../../src/ui/shell-status.js'

/**
 * The status bar's reading of the open project. The shell's own tests show it in place; these
 * pin the mapping itself, every replication state included, so a new state cannot slip through
 * as "synced".
 */
describe('syncStatusOf', () => {
  it('says local for a project only on this device, whatever replication says', () => {
    expect(syncStatusOf({ location: 'local' })).toBe('local')
    expect(syncStatusOf({ location: 'local', syncState: 'idle' })).toBe('local')
  })

  it('says synced only when the copy is caught up', () => {
    expect(syncStatusOf({ location: 'synced', syncState: 'idle' })).toBe('synced')
  })

  it.each(['active', 'offline', 'stopped', undefined] as const)(
    'says pending while the copy is %s',
    (syncState) => {
      expect(
        syncStatusOf({ location: 'synced', ...(syncState === undefined ? {} : { syncState }) }),
      ).toBe('pending')
    },
  )

  it('says denied when the server refuses the copy', () => {
    expect(syncStatusOf({ location: 'synced', syncState: 'denied' })).toBe('denied')
  })
})

describe('renderSyncStatus', () => {
  it('renders nothing before the projects have been read', () => {
    expect(renderSyncStatus(undefined)).toBe('')
  })
})
