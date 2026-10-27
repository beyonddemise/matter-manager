import '@awesome.me/webawesome-pro/dist/components/button/button.js'
import '@awesome.me/webawesome-pro/dist/components/callout/callout.js'
import '@awesome.me/webawesome-pro/dist/components/card/card.js'
import '@awesome.me/webawesome-pro/dist/components/dialog/dialog.js'
import '@awesome.me/webawesome-pro/dist/components/icon/icon.js'
import '@awesome.me/webawesome-pro/dist/components/input/input.js'
import { fixture, html, waitUntil } from '@open-wc/testing-helpers'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ArchiveError } from '../../../src/domain/archive/project-archive.js'
import { ZipError } from '../../../src/domain/archive/zip.js'
import type { ImportResult } from '../../../src/ui/archive/project-import.js'
import { CURRENT_PROJECT_KEY, readCurrentProjectId } from '../../../src/ui/current-project.js'
import { onProjectActionsIdle, projectActionRunning } from '../../../src/ui/project-busy.js'
import {
  importProblemText,
  type ProjectImportSection,
} from '../../../src/ui/views/project-import.js'
import '../../../src/ui/views/project-import.js'

/**
 * The import on the Account page: the file becomes a new local project and the open one, run
 * as a project action so the shell re-reads the index once it ends. The import itself is
 * injected; reading and writing real databases is `archive/project-import.browser.test.ts`.
 */

const result = (over: Partial<ImportResult> = {}): ImportResult => ({
  entry: {
    dbName: 'project_local_imported',
    name: 'Hillside',
    createdAt: '2026-10-19T08:00:00.000Z',
  },
  devices: 3,
  refiled: 0,
  ...over,
})

/** The section, with `importFile` as its import. */
async function section(
  importFile: (file: Blob, password?: string) => Promise<ImportResult>,
): Promise<ProjectImportSection> {
  const element = (await fixture(
    html`<project-import-section .importFile=${importFile}></project-import-section>`,
  )) as ProjectImportSection
  await element.updateComplete
  return element
}

const fileInput = (element: Element) =>
  element.querySelector('input[data-import-file]') as HTMLInputElement

/** Chooses `bytes` as a file, the way the picker does: `files` set, then `change`. */
function choose(element: Element, bytes: Uint8Array = new Uint8Array([1, 2, 3])): void {
  const input = fileInput(element)
  const transfer = new DataTransfer()
  transfer.items.add(new File([bytes as BlobPart], 'export.zip', { type: 'application/zip' }))
  input.files = transfer.files
  input.dispatchEvent(new Event('change', { bubbles: true }))
}

/** Waits until the section has said how the import went. */
async function outcome(element: ProjectImportSection): Promise<void> {
  await waitUntil(
    () =>
      element.querySelector('[data-import-result], [data-import-problem]') !== null &&
      !element.importing,
    'the import never reported',
  )
  await element.updateComplete
}

const text = (element: Element | null): string =>
  element?.textContent?.replace(/\s+/g, ' ').trim() ?? ''

beforeEach(() => {
  localStorage.removeItem(CURRENT_PROJECT_KEY)
})

afterEach(() => {
  localStorage.removeItem(CURRENT_PROJECT_KEY)
})

describe('the import section', () => {
  it('offers a button and a hidden picker for zip files', async () => {
    const element = await section(async () => result())

    expect(element.querySelector('[data-import]')).not.toBeNull()
    const input = fileInput(element)
    expect(input.hidden).toBe(true)
    expect(input.accept).toContain('.zip')
  })

  it('opens the picker from the button', async () => {
    const element = await section(async () => result())
    let opened = false
    fileInput(element).addEventListener('click', (event) => {
      // Stopped, so no real picker opens in the test browser.
      event.preventDefault()
      opened = true
    })

    ;(element.querySelector('[data-import]') as HTMLElement).click()

    expect(opened).toBe(true)
  })
})

describe('importing a file', () => {
  it('hands the chosen file to the import', async () => {
    const received: Uint8Array[] = []
    const element = await section(async (file) => {
      received.push(new Uint8Array(await file.arrayBuffer()))
      return result()
    })

    choose(element, new Uint8Array([80, 75, 5, 6]))
    await outcome(element)

    expect(received.map((bytes) => [...bytes])).toEqual([[80, 75, 5, 6]])
  })

  it('makes the new project the open one', async () => {
    const element = await section(async () => result())

    choose(element)
    await outcome(element)

    expect(readCurrentProjectId(() => localStorage)).toBe('project_local_imported')
  })

  it('runs as a project action, choosing the project before the action ends', async () => {
    // The shell re-reads the index when the action ends; the choice must already be there, or
    // that refresh resolves it against a list without the new project.
    let release: ((value: ImportResult) => void) | undefined
    const element = await section(
      () =>
        new Promise<ImportResult>((resolve) => {
          release = resolve
        }),
    )
    let chosenWhenIdle: string | undefined
    const stop = onProjectActionsIdle(() => {
      chosenWhenIdle = readCurrentProjectId(() => localStorage)
    })
    try {
      choose(element)
      // The action begins before the file is read; the import is called once it has been.
      await waitUntil(() => release !== undefined, 'the import was never called')
      expect(projectActionRunning()).toBe(true)
      await element.updateComplete
      expect(element.importing).toBe(true)

      release?.(result())
      await outcome(element)

      expect(projectActionRunning()).toBe(false)
      expect(chosenWhenIdle).toBe('project_local_imported')
    } finally {
      stop()
    }
  })

  it('says what was imported, and links to its devices', async () => {
    const element = await section(async () => result())

    choose(element)
    await outcome(element)

    const said = element.querySelector('[data-import-result]')
    expect(text(said)).toContain('Imported “Hillside” (3 devices). It is now the open project.')
    expect(said?.querySelector('a')?.getAttribute('href')).toBe('#/devices')
    expect(element.querySelector('[data-import-refiled]')).toBeNull()
  })

  it('counts a single device in the singular', async () => {
    const element = await section(async () => result({ devices: 1 }))

    choose(element)
    await outcome(element)

    expect(text(element.querySelector('[data-import-result]'))).toContain('(1 device)')
  })

  it('says how many devices without a room were filed under Imported', async () => {
    const element = await section(async () => result({ refiled: 2 }))

    choose(element)
    await outcome(element)

    expect(text(element.querySelector('[data-import-refiled]'))).toBe(
      'Devices without a room were put in “Imported”: 2.',
    )
  })

  it('clears the picker, so the same file can be chosen again', async () => {
    let calls = 0
    const element = await section(async () => {
      calls += 1
      return result()
    })

    choose(element)
    expect(fileInput(element).value).toBe('')
    await outcome(element)
    choose(element)
    await waitUntil(() => calls === 2, 'the same file was not imported again')
    await outcome(element)
  })

  it('ignores a second file while the first is importing', async () => {
    let calls = 0
    let release: ((value: ImportResult) => void) | undefined
    const element = await section(() => {
      calls += 1
      return new Promise<ImportResult>((resolve) => {
        release = resolve
      })
    })

    choose(element)
    await waitUntil(() => release !== undefined, 'the import was never called')
    choose(element)
    // Long enough for the second file to have been read and imported, had it been taken.
    await new Promise((resolve) => setTimeout(resolve, 100))
    release?.(result())
    await outcome(element)

    expect(calls).toBe(1)
  })

  it('does nothing when the picker closes with no file', async () => {
    let calls = 0
    const element = await section(async () => {
      calls += 1
      return result()
    })

    fileInput(element).dispatchEvent(new Event('change', { bubbles: true }))
    await element.updateComplete

    expect(calls).toBe(0)
    expect(projectActionRunning()).toBe(false)
  })
})

describe('an import that fails', () => {
  it('says why, chooses no project, and ends the project action', async () => {
    const element = await section(async () => {
      throw new ZipError('notAZip', 'no end record')
    })

    choose(element)
    await outcome(element)

    expect(text(element.querySelector('[data-import-problem]'))).toBe(
      'This file is not a zip file. Nothing was imported.',
    )
    expect(element.querySelector('[data-import-result]')).toBeNull()
    expect(localStorage.getItem(CURRENT_PROJECT_KEY)).toBeNull()
    expect(projectActionRunning()).toBe(false)
  })

  it('clears the last success when the next import fails', async () => {
    let fail = false
    const element = await section(async () => {
      if (fail) throw new ArchiveError('notAProject', 'no manifest')
      return result()
    })

    choose(element)
    await outcome(element)
    fail = true
    choose(element)
    await waitUntil(
      () => element.querySelector('[data-import-problem]') !== null,
      'the failure was never said',
    )

    expect(element.querySelector('[data-import-result]')).toBeNull()
  })
})

describe('an export sealed with a password (#307)', () => {
  const PASSWORD = 'a long enough password'

  /** An import that wants {@link PASSWORD}, and records every password it was handed. */
  function sealedImport() {
    const tried: (string | undefined)[] = []
    const importFile = async (_file: Blob, password?: string): Promise<ImportResult> => {
      tried.push(password)
      if (password === undefined) throw new ZipError('needsPassword', 'x')
      if (password !== PASSWORD) throw new ZipError('wrongPassword', 'x')
      return result()
    }
    return { tried, importFile }
  }

  /** Waits until the section is asking for a password and not importing. */
  async function asked(element: ProjectImportSection): Promise<void> {
    await waitUntil(
      () => element.querySelector('[data-password-dialog][open]') !== null && !element.importing,
      'the password was never asked for',
    )
    await element.updateComplete
  }

  /** Types a password into the prompt and presses Import. */
  async function answer(element: ProjectImportSection, password: string): Promise<void> {
    const input = element.querySelector('[data-field="import-password"]') as HTMLElement & {
      value: string
    }
    input.value = password
    input.dispatchEvent(new Event('input', { bubbles: true }))
    await element.updateComplete
    ;(element.querySelector('[data-import-password]') as HTMLElement).click()
  }

  it('asks for the password, then imports with it', async () => {
    const { tried, importFile } = sealedImport()
    const element = await section(importFile)

    choose(element)
    await asked(element)

    // Asking is not failing: nothing is said to have gone wrong.
    expect(element.querySelector('[data-import-problem]')).toBeNull()
    expect(text(element.querySelector('[data-password-dialog]'))).toContain(
      'This export is protected with a password.',
    )
    await answer(element, PASSWORD)
    await outcome(element)

    expect(tried).toEqual([undefined, PASSWORD])
    expect(element.querySelector('[data-import-result]')).not.toBeNull()
    expect(element.querySelector('[data-password-dialog][open]')).toBeNull()
    expect(readCurrentProjectId(() => localStorage)).toBe('project_local_imported')
    expect(projectActionRunning()).toBe(false)
  })

  it('says a wrong password is wrong, and asks again', async () => {
    const { tried, importFile } = sealedImport()
    const element = await section(importFile)

    choose(element)
    await asked(element)
    await answer(element, 'not the password')
    await waitUntil(
      () => element.querySelector('[data-password-wrong]') !== null && !element.importing,
      'the wrong password was never said',
    )

    expect(text(element.querySelector('[data-password-wrong]'))).toBe(
      'This password does not open the file.',
    )
    // Announced, and focus back in the emptied field rather than on a disabled button.
    expect(element.querySelector('[data-password-wrong]')?.getAttribute('role')).toBe('alert')
    await waitUntil(
      () => document.activeElement === element.querySelector('[data-field="import-password"]'),
      'focus did not return to the password field',
    )
    expect(element.querySelector('[data-password-dialog][open]')).not.toBeNull()
    await answer(element, PASSWORD)
    await outcome(element)

    expect(tried).toEqual([undefined, 'not the password', PASSWORD])
  })

  it('imports nothing when the prompt is cancelled', async () => {
    const { tried, importFile } = sealedImport()
    const element = await section(importFile)

    choose(element)
    await asked(element)
    ;(element.querySelector('[data-cancel-password]') as HTMLElement).click()
    await element.updateComplete

    expect(element.asking).toBeUndefined()
    // The dialog animates closed before it drops its `open` attribute.
    await waitUntil(
      () => element.querySelector('[data-password-dialog][open]') === null,
      'the prompt never closed',
    )
    expect(element.querySelector('[data-import-result]')).toBeNull()
    expect(tried).toEqual([undefined])
    expect(localStorage.getItem(CURRENT_PROJECT_KEY)).toBeNull()
  })

  it('takes Enter in the password field as Import', async () => {
    const { tried, importFile } = sealedImport()
    const element = await section(importFile)

    choose(element)
    await asked(element)
    const input = element.querySelector('[data-field="import-password"]') as HTMLElement & {
      value: string
    }
    input.value = PASSWORD
    input.dispatchEvent(new Event('input', { bubbles: true }))
    await element.updateComplete
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
    await outcome(element)

    expect(tried).toEqual([undefined, PASSWORD])
  })

  it('treats the dialog closing itself (Escape) as Cancel', async () => {
    const { importFile } = sealedImport()
    const element = await section(importFile)

    choose(element)
    await asked(element)
    const prompt = element.querySelector('[data-password-dialog]') as HTMLElement
    // A field's hide event bubbling up is not the dialog closing.
    element
      .querySelector('[data-field="import-password"]')
      ?.dispatchEvent(new Event('wa-after-hide', { bubbles: true }))
    expect(element.asking).toBeDefined()
    prompt.dispatchEvent(new Event('wa-after-hide'))

    expect(element.asking).toBeUndefined()
  })

  it('cannot be closed while the password is being tried', async () => {
    let release: ((value: ImportResult) => void) | undefined
    const element = await section((_file, password) => {
      if (password === undefined) return Promise.reject(new ZipError('needsPassword', 'x'))
      return new Promise<ImportResult>((resolve) => {
        release = resolve
      })
    })
    choose(element)
    await asked(element)
    await answer(element, PASSWORD)
    await waitUntil(() => release !== undefined, 'the password was never tried')
    const prompt = element.querySelector('[data-password-dialog]') as HTMLElement

    const hide = new Event('wa-hide', { cancelable: true })
    prompt.dispatchEvent(hide)

    expect(hide.defaultPrevented).toBe(true)
    release?.(result())
    await outcome(element)
    const after = new Event('wa-hide', { cancelable: true })
    prompt.dispatchEvent(after)
    expect(after.defaultPrevented).toBe(false)
  })

  it('never asks for a plain export', async () => {
    const tried: (string | undefined)[] = []
    const element = await section(async (_file, password) => {
      tried.push(password)
      return result()
    })

    choose(element)
    await outcome(element)

    expect(tried).toEqual([undefined])
    expect(element.querySelector('[data-password-dialog][open]')).toBeNull()
  })

  it('keeps the file it asked about, not one chosen later', async () => {
    const files: number[] = []
    const element = await section(async (file, password) => {
      files.push(file.size)
      if (password === undefined) throw new ZipError('needsPassword', 'x')
      return result()
    })

    choose(element, new Uint8Array([1, 2, 3, 4, 5]))
    await asked(element)
    await answer(element, PASSWORD)
    await outcome(element)

    expect(files).toEqual([5, 5])
  })
})

describe('what a failed import says', () => {
  it.each([
    [new ZipError('notAZip', 'x'), 'This file is not a zip file. Nothing was imported.'],
    [new ZipError('tooLarge', 'x'), 'This file is too large to import. Nothing was imported.'],
    [new ZipError('corrupt', 'x'), 'This file is damaged. Nothing was imported.'],
    [
      new ZipError('unsupported', 'x'),
      'This zip uses a format the import cannot read. Nothing was imported.',
    ],
    // Normally asked in the prompt rather than said; these are what stands when they are said.
    [
      new ZipError('needsPassword', 'x'),
      'This export is protected with a password. Nothing was imported.',
    ],
    [
      new ZipError('wrongPassword', 'x'),
      'This password does not open the file. Nothing was imported.',
    ],
    [
      new ArchiveError('notAProject', 'x'),
      'This is not a Matter Manager project export. Nothing was imported.',
    ],
    [
      new ArchiveError('newerVersion', 'x'),
      'This export was made by a newer version of Matter Manager. Reload to update, then try again. Nothing was imported.',
    ],
    [
      new ArchiveError('badDevice', 'x', 'devices/abc.json'),
      'A device in this export is not valid (devices/abc.json). Nothing was imported.',
    ],
    [
      new Error('QuotaExceededError'),
      'The project could not be saved on this device. Nothing was imported.',
    ],
    ['not even an error', 'The project could not be saved on this device. Nothing was imported.'],
  ])('%s', (error, expected) => {
    expect(importProblemText(error)).toBe(expected)
  })

  it('names no file for a bad device it cannot place', () => {
    expect(importProblemText(new ArchiveError('badDevice', 'x'))).toBe(
      'A device in this export is not valid. Nothing was imported.',
    )
  })
})
