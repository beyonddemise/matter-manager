// Shown by Review and by nothing else, so imported here (#214): it travels in the add form's
// lazy chunk rather than in the entry chunk. `wa-card` is registered by the shell.
import '@awesome.me/webawesome-pro/dist/components/format-date/format-date.js'
import { msg } from '@lit/localize'
import { html, type TemplateResult } from 'lit'
import type { AddStep } from './add-device.js'

/**
 * What the person filled in on steps 1-3, exactly as the controls held it when Review was
 * entered: the same text `planNewDevice` will read on Save, not a normalised copy of it.
 */
export interface ReviewSummary {
  readonly credential: string
  readonly serial: string
  /** `YYYY-MM-DD`, as `<input type="date">` writes it. */
  readonly installedAt: string
  readonly room: string
  readonly spot: string
  readonly name: string
}

/** One label and its value, as the device page and the catalogue lines show a fact. */
function fact(label: string, value: TemplateResult | string, key: string): TemplateResult {
  return html`
    <div class="wa-stack wa-gap-3xs">
      <dt><small class="app-empty">${label}</small></dt>
      <dd data-review-value=${key}>${value}</dd>
    </div>
  `
}

/** A fact for an optional field: nothing at all when it was left empty, rather than a blank. */
function optionalFact(label: string, value: string, key: string): TemplateResult | '' {
  return value === '' ? '' : fact(label, value, key)
}

/**
 * The installation date, formatted for the person's locale.
 *
 * Pinned to UTC on both sides: the control's `YYYY-MM-DD` parses as UTC midnight, so formatting
 * it in the browser's own zone would show the day before to anyone west of Greenwich. A date
 * that cannot be read is shown as typed; Save is what says it is wrong, on Scan it.
 */
function installed(value: string): TemplateResult | string {
  return Number.isNaN(Date.parse(value))
    ? value
    : html`<wa-format-date
        date=${value}
        time-zone="UTC"
        year="numeric"
        month="long"
        day="numeric"
      ></wa-format-date>`
}

/**
 * One step's block: its name as a heading, what it holds, and an Edit that goes back to it.
 *
 * Edit names its step for assistive technology - three buttons all called "Edit" are
 * indistinguishable in a list of controls (WCAG 2.2 2.4.6) - while showing only the short word.
 * The heading takes focus without joining the tab order (`tabindex="-1"`): entering Review
 * focuses the first one, as Review has no control of its own to start on.
 */
function block(
  step: AddStep,
  heading: string,
  onEdit: (step: AddStep) => void,
  content: TemplateResult,
): TemplateResult {
  return html`
    <wa-card data-review=${step}>
      <h2 slot="header" tabindex="-1">${heading}</h2>
      <wa-button
        slot="header-actions"
        data-edit
        type="button"
        appearance="plain"
        size="small"
        @click=${() => onEdit(step)}
      >
        ${msg('Edit')}<span class="wa-visually-hidden">: ${heading}</span>
      </wa-button>
      ${content}
    </wa-card>
  `
}

/**
 * Review's read-only summary: one card per step, in step order, each with an Edit.
 *
 * A pure function of what it is given so that the form decides *when* values are read (on
 * entering Review) and this decides only how they look. `catalogLines` is the form's own
 * manufacturer / product rendering, passed in rather than rebuilt, so Review and Scan it can
 * never disagree about what the catalogue said; `''` when it has not answered.
 */
export function renderReview(
  summary: ReviewSummary,
  onEdit: (step: AddStep) => void,
  catalogLines: TemplateResult | '',
): TemplateResult {
  return html`
    <div class="wa-stack wa-gap-m">
      ${block(
        'scan',
        msg('Scan it'),
        onEdit,
        html`
          <div class="wa-stack wa-gap-m">
            <dl class="wa-cluster wa-gap-l app-facts">
              ${fact(msg('Setup code'), summary.credential, 'credential')}
              ${optionalFact(msg('Serial number'), summary.serial, 'serial')}
              ${fact(msg('Installed'), installed(summary.installedAt), 'installed-at')}
            </dl>
            ${catalogLines}
          </div>
        `,
      )}
      ${block(
        'place',
        msg('Place it'),
        onEdit,
        html`
          <dl class="wa-cluster wa-gap-l app-facts">
            ${fact(msg('Room'), summary.room, 'room')}
            ${optionalFact(msg('Spot'), summary.spot, 'spot')}
          </dl>
        `,
      )}
      ${block(
        'name',
        msg('Name it'),
        onEdit,
        html`
          <dl class="wa-cluster wa-gap-l app-facts">
            ${fact(msg('Name'), summary.name, 'name')}
          </dl>
        `,
      )}
    </div>
  `
}
