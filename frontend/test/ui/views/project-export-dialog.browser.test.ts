import '@awesome.me/webawesome-pro/dist/components/button/button.js'
import '@awesome.me/webawesome-pro/dist/components/callout/callout.js'
import '@awesome.me/webawesome-pro/dist/components/checkbox/checkbox.js'
import '@awesome.me/webawesome-pro/dist/components/dialog/dialog.js'
import '@awesome.me/webawesome-pro/dist/components/icon/icon.js'
import '@awesome.me/webawesome-pro/dist/components/input/input.js'
import { fixture, html } from '@open-wc/testing-helpers'
import { describe, expect, it } from 'vitest'
import {
  ARCHIVE_PASSWORD_MIN_LENGTH,
  type ExportConfirmDetail,
  type ProjectExportDialog,
  passwordProblem,
} from '../../../src/ui/views/project-export-dialog.js'
import '../../../src/ui/views/project-export-dialog.js'

/**
 * The export dialog (#307): a plain export by default, or one sealed with a password typed
 * twice, at least {@link ARCHIVE_PASSWORD_MIN_LENGTH} characters long, beside the warning that
 * a lost password cannot be recovered.
 */

/** The dialog, open, and every event it sent. */
async function dialog(): Promise<{
  element: ProjectExportDialog
  confirmed: ExportConfirmDetail[]
  cancelled: number[]
}> {
  const confirmed: ExportConfirmDetail[] = []
  const cancelled: number[] = []
  const element = (await fixture(html`
    <project-export-dialog
      open
      .projectName=${'Hillside'}
      @export-confirm=${(event: CustomEvent<ExportConfirmDetail>) => confirmed.push(event.detail)}
      @export-cancel=${() => cancelled.push(1)}
    ></project-export-dialog>
  `)) as ProjectExportDialog
  await element.updateComplete
  return { element, confirmed, cancelled }
}

function find<T extends Element = HTMLElement>(element: Element, selector: string): T {
  const found = element.querySelector(selector)
  if (found === null) throw new Error(`Nothing matches ${selector}`)
  return found as T
}

const text = (element: Element | null): string =>
  element?.textContent?.replace(/\s+/g, ' ').trim() ?? ''

/** Types into a field the way a reader does: its value, then `input`. */
async function type(element: ProjectExportDialog, field: string, value: string): Promise<void> {
  const input = find<HTMLElement & { value: string }>(element, `[data-field="${field}"]`)
  input.value = value
  input.dispatchEvent(new Event('input', { bubbles: true }))
  await element.updateComplete
}

/** Ticks "Protect with a password". */
async function protect(element: ProjectExportDialog): Promise<void> {
  const box = find<HTMLElement & { checked: boolean }>(element, '[data-field="protect"]')
  box.checked = true
  box.dispatchEvent(new Event('change', { bubbles: true }))
  await element.updateComplete
}

const exportButton = (element: Element) =>
  find<HTMLElement & { disabled: boolean }>(element, '[data-confirm-export]')

const GOOD = 'twelve chars'

describe('the password rule', () => {
  it('needs the minimum length, then the same password twice', () => {
    expect(ARCHIVE_PASSWORD_MIN_LENGTH).toBe(12)
    expect(passwordProblem('', '')).toBe('tooShort')
    expect(passwordProblem('eleven char', 'eleven char')).toBe('tooShort')
    expect(passwordProblem(GOOD, 'twelve chars ')).toBe('mismatch')
    expect(passwordProblem(GOOD, GOOD)).toBeUndefined()
  })

  it('counts characters, not UTF-16 units', () => {
    // Eleven emoji are 22 UTF-16 units; a reader counts eleven.
    expect(passwordProblem('😀'.repeat(11), '😀'.repeat(11))).toBe('tooShort')
    expect(passwordProblem('ü'.repeat(12), 'ü'.repeat(12))).toBeUndefined()
  })
})

describe('a plain export', () => {
  it('is the default, says the codes are in plain text, and exports without a password', async () => {
    const { element, confirmed } = await dialog()

    expect(find(element, '[data-plaintext-warning]').getAttribute('variant')).toBe('warning')
    expect(text(find(element, '[data-plaintext-warning]'))).toContain(
      'the setup codes are in plain text',
    )
    expect(element.querySelector('[data-field="password"]')).toBeNull()
    expect(exportButton(element).disabled).toBe(false)

    exportButton(element).click()

    expect(confirmed).toEqual([{}])
  })

  it('backs out with Cancel, forgetting what was typed', async () => {
    const { element, confirmed, cancelled } = await dialog()
    await protect(element)
    await type(element, 'password', GOOD)

    find(element, '[data-cancel-export]').click()

    expect(cancelled).toHaveLength(1)
    expect(confirmed).toEqual([])
    expect([element.protect, element.password]).toEqual([false, ''])
  })

  it('backs out when the dialog itself closes (Escape, the close button)', async () => {
    const { element, cancelled } = await dialog()

    find(element, '[data-export-dialog]').dispatchEvent(new Event('wa-after-hide'))
    // A field's own hide event bubbling up is not the dialog closing.
    find(element, '[data-field="protect"]').dispatchEvent(
      new Event('wa-after-hide', { bubbles: true }),
    )

    expect(cancelled).toHaveLength(1)
  })
})

describe('an export with a password', () => {
  it('asks for the password twice and says a lost one cannot be recovered', async () => {
    const { element } = await dialog()

    await protect(element)

    expect(element.querySelector('[data-field="password"]')).not.toBeNull()
    expect(element.querySelector('[data-field="confirm-password"]')).not.toBeNull()
    expect(text(find(element, '[data-unrecoverable]'))).toContain(
      'If the password is lost, the file cannot be opened. Nobody can recover it',
    )
    expect(element.querySelector('[data-plaintext-warning]')).toBeNull()
    // Nothing typed yet: nothing to export.
    expect(exportButton(element).disabled).toBe(true)
  })

  it('refuses a password shorter than the floor, and says why', async () => {
    const { element, confirmed } = await dialog()
    await protect(element)

    await type(element, 'password', 'eleven char')
    await type(element, 'confirm-password', 'eleven char')

    expect(exportButton(element).disabled).toBe(true)
    expect(text(find(element, '[data-password-problem]'))).toBe(
      'The password needs at least 12 characters.',
    )
    exportButton(element).click()
    expect(confirmed).toEqual([])
  })

  it('refuses a confirmation that differs, and says so', async () => {
    const { element, confirmed } = await dialog()
    await protect(element)

    await type(element, 'password', GOOD)
    await type(element, 'confirm-password', 'twelve charz')

    expect(exportButton(element).disabled).toBe(true)
    expect(text(find(element, '[data-password-problem]'))).toBe(
      'The two passwords are not the same.',
    )
    exportButton(element).click()
    expect(confirmed).toEqual([])
  })

  it('says the password must be repeated, rather than leaving Export disabled unexplained', async () => {
    const { element } = await dialog()
    await protect(element)

    await type(element, 'password', GOOD)

    expect(exportButton(element).disabled).toBe(true)
    expect(text(find(element, '[data-password-problem]'))).toBe('Repeat the password to export.')
  })

  it('takes Enter in the repeated password as Export, once it may export', async () => {
    const { element, confirmed } = await dialog()
    await protect(element)
    const enter = () =>
      find(element, '[data-field="confirm-password"]').dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }),
      )

    await type(element, 'password', GOOD)
    await type(element, 'confirm-password', 'twelve charz')
    enter()
    expect(confirmed).toEqual([])

    await type(element, 'confirm-password', GOOD)
    enter()
    expect(confirmed).toEqual([{ password: GOOD }])
  })

  it('renders no fields while closed', async () => {
    const { element } = await dialog()
    element.open = false
    await element.updateComplete

    expect(element.querySelector('[data-field="protect"]')).toBeNull()
  })

  it('exports with the password once both match', async () => {
    const { element, confirmed } = await dialog()
    await protect(element)

    await type(element, 'password', GOOD)
    await type(element, 'confirm-password', GOOD)

    expect(exportButton(element).disabled).toBe(false)
    expect(text(find(element, '[data-password-problem]'))).toBe('')
    exportButton(element).click()
    expect(confirmed).toEqual([{ password: GOOD }])
  })

  it('forgets the password once it has been handed over, and starts plain when opened again', async () => {
    const { element } = await dialog()
    await protect(element)
    await type(element, 'password', GOOD)
    await type(element, 'confirm-password', GOOD)
    exportButton(element).click()

    element.open = false
    await element.updateComplete
    element.open = true
    await element.updateComplete

    expect(element.protect).toBe(false)
    expect(element.password).toBe('')
    expect(element.confirmation).toBe('')
    expect(element.querySelector('[data-field="password"]')).toBeNull()
  })

  it('waits while the page is busy', async () => {
    const { element, confirmed } = await dialog()
    element.busy = true
    await element.updateComplete

    expect(exportButton(element).disabled).toBe(true)
    exportButton(element).click()
    expect(confirmed).toEqual([])
  })
})
