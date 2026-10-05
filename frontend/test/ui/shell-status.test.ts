import { describe, expect, it } from 'vitest'
import {
  announcementFor,
  renderSyncStatus,
  type StatusSnapshot,
  syncStatusOf,
} from '../../src/ui/shell-status.js'

/**
 * The status bar's reading of the open project. The shell's own tests show it in place; these
 * pin the mapping itself, every replication state included, so a new state cannot slip through
 * as "synced".
 */
describe('syncStatusOf', () => {
  it('says local for a project only on this device, whatever replication says', () => {
    expect(syncStatusOf({ location: 'local' }, true)).toBe('local')
    expect(syncStatusOf({ location: 'local', syncState: 'idle' }, true)).toBe('local')
    expect(syncStatusOf({ location: 'local' }, false)).toBe('local')
  })

  it('says synced only when the copy is caught up', () => {
    expect(syncStatusOf({ location: 'synced', syncState: 'idle' }, true)).toBe('synced')
  })

  it('says paused for a synchronized copy while nobody is signed in', () => {
    expect(syncStatusOf({ location: 'synced' }, false)).toBe('paused')
    expect(syncStatusOf({ location: 'synced', syncState: 'idle' }, false)).toBe('paused')
  })

  it.each(['active', 'offline', 'stopped', undefined] as const)(
    'says pending while the copy is %s',
    (syncState) => {
      expect(
        syncStatusOf(
          { location: 'synced', ...(syncState === undefined ? {} : { syncState }) },
          true,
        ),
      ).toBe('pending')
    },
  )

  it('says denied when the server refuses the copy', () => {
    expect(syncStatusOf({ location: 'synced', syncState: 'denied' }, true)).toBe('denied')
  })
})

describe('renderSyncStatus', () => {
  it('renders nothing before the projects have been read', () => {
    expect(renderSyncStatus(undefined)).toBe('')
  })
})

describe('announcementFor', () => {
  const at = (online: boolean, status?: 'pending' | 'synced' | 'denied'): StatusSnapshot => ({
    online,
    sync: status === undefined ? undefined : { status, name: 'Beta' },
  })

  it('says nothing for the first render: nothing has changed yet', () => {
    expect(announcementFor(undefined, at(false, 'denied'))).toBeUndefined()
  })

  it('says the network coming and going', () => {
    expect(announcementFor(at(true, 'synced'), at(false, 'synced'))).toBe('Offline')
    expect(announcementFor(at(false, 'synced'), at(true, 'synced'))).toBe('Online')
  })

  it('stays quiet while a copy trades pending and synced', () => {
    expect(announcementFor(at(true, 'pending'), at(true, 'synced'))).toBeUndefined()
    expect(announcementFor(at(true, 'synced'), at(true, 'pending'))).toBeUndefined()
  })

  it('says a refusal starting and ending, with the project it is about', () => {
    expect(announcementFor(at(true, 'synced'), at(true, 'denied'))).toBe(
      'Beta: No permission to sync',
    )
    expect(announcementFor(at(true, 'denied'), at(true, 'synced'))).toBe('Beta: Synced')
  })

  it('says both when both change at once', () => {
    expect(announcementFor(at(true, 'synced'), at(false, 'denied'))).toBe(
      'Offline. Beta: No permission to sync',
    )
  })

  it('leaves out an empty name', () => {
    const unnamed: StatusSnapshot = { online: true, sync: { status: 'denied', name: '' } }
    expect(announcementFor(at(true, 'synced'), unnamed)).toBe('No permission to sync')
  })
})
