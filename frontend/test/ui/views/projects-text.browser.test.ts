import { afterEach, describe, expect, it } from 'vitest'
import { activateLocale } from '../../../src/ui/i18n/localization.js'
import {
  locationText,
  openRefusalText,
  overLimitText,
  type Reason,
  reasonText,
} from '../../../src/ui/views/projects-text.js'

/**
 * The projects page's sentences, without the page: every reason has one, and each reads in the
 * interface's language.
 */

/** Every reason the model and the API can give. Listed by hand, as an independent reading. */
const REASONS: readonly Reason[] = [
  'signed-out',
  'offline',
  'stale',
  'plan',
  'limit',
  'role',
  'read-only',
  'offline-server',
  'unreachable',
  'not-signed-in',
  'not-entitled',
  'plan-no-sync',
  'project-limit-reached',
  'not-a-manager',
  'refused',
  'failed',
  'not-found',
]

afterEach(async () => {
  await activateLocale('en')
})

describe('reasons as sentences', () => {
  it.each(REASONS)('says something for %s', (reason) => {
    expect(reasonText(reason)).not.toBe('')
  })

  it('says nothing for an action that does not apply', () => {
    expect(reasonText('not-applicable')).toBe('')
  })

  it('gives the predicted and the reported refusal the same words', () => {
    expect(reasonText('limit')).toBe(reasonText('project-limit-reached'))
    expect(reasonText('plan')).toBe(reasonText('plan-no-sync'))
    expect(reasonText('role')).toBe(reasonText('not-a-manager'))
    expect(reasonText('signed-out')).toBe(reasonText('not-signed-in'))
  })

  it('names the controller’s wording for the common ones', () => {
    expect(reasonText('offline')).toBe('Needs a connection')
    expect(reasonText('signed-out')).toBe('Sign in to sync')
    expect(reasonText('limit')).toBe('Your plan has no room for another project')
    expect(reasonText('stale')).toBe('Waiting for the project list')
  })

  it('says a project that cannot be opened offline is not here, not merely delayed', () => {
    expect(openRefusalText('offline')).toBe('Not available offline')
    expect(openRefusalText('stale')).toBe(reasonText('stale'))
  })

  it('names every location', () => {
    expect([locationText('local'), locationText('server'), locationText('synced')]).toEqual([
      'On this device',
      'On the server',
      'Synchronized',
    ])
  })

  it('counts over the limit without a broken plural', () => {
    const said = overLimitText(1, 2)
    expect(said).toContain('Projects your plan allows: 1')
    expect(said).toContain('Projects you own: 2')
  })

  it('says all of it in German', async () => {
    await activateLocale('de')
    expect(reasonText('offline')).toBe('Benötigt eine Verbindung')
    expect(openRefusalText('offline')).toBe('Offline nicht verfügbar')
    expect(locationText('synced')).toBe('Synchronisiert')
    expect(overLimitText(1, 2)).toContain('Ihr Tarif')
  })
})
