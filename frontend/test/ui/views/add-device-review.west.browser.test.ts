import { fixture, html } from '@open-wc/testing-helpers'
import { describe, expect, it } from 'vitest'
import { renderReview } from '../../../src/ui/views/add-device-review.js'

/**
 * Review's installation date, west of Greenwich (#354).
 *
 * Runs in the `ui-west` project, whose pages are in `America/Los_Angeles`. `YYYY-MM-DD` parses
 * as UTC midnight, which in Los Angeles is still the previous evening, so a date formatted in the
 * page's own zone reads a day early. In the runner's UTC the two agree and no test can tell
 * them apart; here, dropping `time-zone="UTC"` from Review makes this fail.
 */
describe('Review, west of UTC', () => {
  it('runs where a date-only value would slip a day', () => {
    // Guards the premise: if the project ever stopped setting the zone, the test below would
    // pass for the wrong reason, as it does in UTC.
    expect(Intl.DateTimeFormat().resolvedOptions().timeZone).toBe('America/Los_Angeles')
    expect(new Date('2026-08-19').getDate()).toBe(18)
  })

  it('shows the installation date as the day that was picked', async () => {
    const summary = {
      credential: 'MT:Y.K9042C00KA0648G00',
      serial: '',
      installedAt: '2026-08-19',
      room: 'Hall',
      spot: '',
      name: 'Front door sensor',
    }
    const element = await fixture<HTMLElement>(
      html`<div>${renderReview(summary, {}, () => {}, '')}</div>`,
    )
    const date = element.querySelector('wa-format-date') as
      | (HTMLElement & { updateComplete: Promise<unknown> })
      | null
    expect(date).not.toBeNull()
    await date?.updateComplete

    // `en` and `{ year: 'numeric', month: 'long', day: 'numeric' }`, as Review asks for it.
    expect(date?.shadowRoot?.textContent?.trim()).toBe('August 19, 2026')
  })
})
