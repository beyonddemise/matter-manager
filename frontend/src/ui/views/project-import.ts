import { msg, str, updateWhenLocaleChanges } from '@lit/localize'
import { html, LitElement, nothing, type TemplateResult } from 'lit'
import type { ArchiveProblem } from '../../domain/archive/project-archive.js'
import type { ZipProblem } from '../../domain/archive/zip.js'
import type { ImportResult } from '../archive/project-import.js'
import { writeCurrentProjectId } from '../current-project.js'
import { deviceCountText } from '../i18n/counts.js'
import { beginProjectAction } from '../project-busy.js'

/**
 * Importing a project from an export file, on the Account page.
 *
 * The file becomes a **new** local-only project and the open one; it is never merged into an
 * existing project. It runs as a project action (`project-busy.ts`), so the shell re-reads the
 * project index when it ends and opens the new project, rather than a refresh racing it and
 * resolving the new choice against a list that does not have it yet.
 *
 * @module
 */
export class ProjectImportSection extends LitElement {
  /** Light DOM, so Web Awesome's global utility classes reach this markup. See `app-shell.ts`. */
  protected override createRenderRoot(): HTMLElement {
    return this
  }

  static override properties = {
    importFile: { attribute: false },
    importing: { state: true },
    result: { state: true },
    problem: { state: true },
  }

  /** The import, injected by tests; the real one reads the zip and writes the databases. */
  declare importFile?: (file: Blob) => Promise<ImportResult>
  declare importing: boolean
  /** The last import that worked, until another is started. */
  declare result: ImportResult | undefined
  /** Why the last import did not happen, in words, until another is started. */
  declare problem: string | undefined

  constructor() {
    super()
    updateWhenLocaleChanges(this)
    this.importing = false
  }

  private async onFile(event: Event): Promise<void> {
    const input = event.target as HTMLInputElement
    const file = input.files?.[0]
    // Cleared at once, so choosing the same file again (after fixing it) fires `change` again.
    input.value = ''
    if (file === undefined || this.importing) return

    this.importing = true
    this.result = undefined
    this.problem = undefined
    const end = beginProjectAction()
    try {
      // Loaded when a file is chosen: the zip reader and the archive format stay out of the
      // bundle every visitor downloads (see `importProblemText` for the other half).
      const importFile =
        this.importFile ?? (await import('../archive/project-import.js')).importProjectFile
      // The file itself, not its bytes: the import checks its size before reading any of it.
      const result = await importFile(file)
      // Chosen before the action ends: the refresh that follows then opens it.
      writeCurrentProjectId(() => localStorage, result.entry.dbName)
      this.result = result
    } catch (error) {
      this.problem = importProblemText(error)
    } finally {
      end()
      this.importing = false
    }
  }

  override render(): TemplateResult {
    return html`
      <wa-card data-import-section>
        <div class="wa-stack wa-gap-m">
          <h2>${msg('Import a project')}</h2>
          <p class="app-empty">
            ${msg('Choose a project export (a .zip file). It becomes a new project on this device.')}
          </p>
          <div class="wa-cluster">
            <wa-button
              data-import
              appearance="outlined"
              ?loading=${this.importing}
              @click=${() => {
                ;(this.querySelector('input[type="file"]') as HTMLInputElement | null)?.click()
              }}
            >
              <wa-icon slot="start" name="file-import"></wa-icon>
              ${msg('Import a project')}
            </wa-button>
          </div>
          <!-- Hidden rather than absent: the button above opens it. The accept attribute only
               filters the picker; the file is still checked when it is read. -->
          <input
            type="file"
            accept=".zip,application/zip"
            hidden
            data-import-file
            @change=${(event: Event) => void this.onFile(event)}
          />
          ${this.renderOutcome()}
        </div>
      </wa-card>
    `
  }

  private renderOutcome(): TemplateResult | typeof nothing {
    if (this.problem !== undefined) {
      return html`<wa-callout variant="danger" data-import-problem>
        <wa-icon slot="icon" name="triangle-exclamation"></wa-icon>
        ${this.problem}
      </wa-callout>`
    }
    const result = this.result
    if (result === undefined) return nothing
    const count = deviceCountText(result.devices)
    return html`<wa-callout variant="success" data-import-result>
      <wa-icon slot="icon" name="circle-check"></wa-icon>
      <div class="wa-stack wa-gap-2xs">
        <span>${msg(str`Imported “${result.entry.name}” (${count}). It is now the open project.`)}</span>
        ${
          result.refiled === 0
            ? nothing
            : html`<span data-import-refiled>
                ${msg(str`Devices without a room were put in “Imported”: ${result.refiled}.`)}
              </span>`
        }
        <a href="#/devices">${msg('Show its devices')}</a>
      </div>
    </wa-callout>`
  }
}

/**
 * The `problem` of an error with the given class name, or `undefined`.
 *
 * By name rather than `instanceof`: importing `ZipError` and `ArchiveError` here would pull the
 * zip reader into the entry bundle, which is what loading the import lazily exists to avoid.
 * Both classes set `name`, and nothing else in the application throws one with these names.
 */
function problemOf<P extends string>(error: unknown, name: string): P | undefined {
  if (!(error instanceof Error) || error.name !== name) return undefined
  return (error as Error & { problem?: P }).problem
}

/** The file inside the archive an `ArchiveError` names, if any. */
const fileOf = (error: unknown): string | undefined =>
  error instanceof Error ? (error as Error & { file?: string }).file : undefined

/**
 * Why an import failed, in words the reader can act on. Every sentence ends by saying nothing
 * was imported, because the import is all or nothing and that is the question a failure raises.
 */
export function importProblemText(error: unknown): string {
  const zip = problemOf<ZipProblem>(error, 'ZipError')
  if (zip !== undefined) {
    switch (zip) {
      case 'notAZip':
        return msg('This file is not a zip file. Nothing was imported.')
      case 'tooLarge':
        return msg('This file is too large to import. Nothing was imported.')
      case 'corrupt':
        return msg('This file is damaged. Nothing was imported.')
      case 'unsupported':
        return msg('This zip uses a format the import cannot read. Nothing was imported.')
    }
  }
  const archive = problemOf<ArchiveProblem>(error, 'ArchiveError')
  if (archive !== undefined) {
    const file = fileOf(error)
    switch (archive) {
      case 'notAProject':
        return msg('This is not a Matter Manager project export. Nothing was imported.')
      case 'newerVersion':
        return msg(
          'This export was made by a newer version of Matter Manager. Reload to update, then try again. Nothing was imported.',
        )
      case 'badDevice':
        return file === undefined
          ? msg('A device in this export is not valid. Nothing was imported.')
          : msg(str`A device in this export is not valid (${file}). Nothing was imported.`)
    }
  }
  // Not logged: the file holds every setup code in the project.
  return msg('The project could not be saved on this device. Nothing was imported.')
}

customElements.define('project-import-section', ProjectImportSection)
