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

/**
 * What a step's check found, for its card: `true` when it passed, the message (already
 * translated) when it did not, absent when it has not been checked.
 */
export type StepStatus = Readonly<Partial<Record<AddStep, true | string>>>

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
 * A step that passed carries a check before its heading, one that failed the problem itself,
 * as the stepper marks them: shape and words as well as colour (WCAG 2.2 1.4.1).
 */
function block(
  step: AddStep,
  heading: string,
  onEdit: (step: AddStep) => void,
  status: true | string | undefined,
  content: TemplateResult,
): TemplateResult {
  return html`
    <wa-card data-review=${step} data-status=${status === true ? 'complete' : status === undefined ? 'unchecked' : 'problem'}>
      <!-- The heading is the wrapper's last child because the native styles give a heading with
           a following sibling a bottom margin: beside a sibling, it sat above Edit's centre line
           and made the header taller than its content. -->
      <div slot="header" class="wa-cluster wa-gap-xs wa-align-items-center">
        ${
          status === true
            ? html`<wa-icon name="circle-check" class="app-step-complete" label=${msg('Complete')}></wa-icon>`
            : status === undefined
              ? ''
              : html`<wa-icon name="triangle-exclamation" class="app-step-problem" label=${msg('Check this step')}></wa-icon>`
        }
        <h3 class="wa-heading-m">${heading}</h3>
      </div>
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
      <div class="wa-stack wa-gap-m">
        ${
          typeof status === 'string'
            ? html`
                <wa-callout variant="danger" data-review-problem>
                  <wa-icon slot="icon" name="triangle-exclamation"></wa-icon>
                  ${status}
                </wa-callout>
              `
            : ''
        }
        ${content}
      </div>
    </wa-card>
  `
}

/**
 * Review's read-only summary: one card per step, in step order, each with an Edit.
 *
 * A pure function of what it is given so that the form decides *when* values are read (on
 * entering Review) and this decides only how they look. `catalogLines` is the form's own
 * manufacturer / product rendering, passed in rather than rebuilt, so Review and Scan it can
 * never disagree about what the catalogue said; `''` when it has not answered. `status` is
 * what each step's check found, so a card shows the same verdict as its step in the stepper.
 */
export function renderReview(
  summary: ReviewSummary,
  status: StepStatus,
  onEdit: (step: AddStep) => void,
  catalogLines: TemplateResult | '',
): TemplateResult {
  return html`
    <div class="wa-stack wa-gap-m">
      ${block(
        'scan',
        msg('Scan'),
        onEdit,
        status.scan,
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
        msg('Place'),
        onEdit,
        status.place,
        html`
          <dl class="wa-cluster wa-gap-l app-facts">
            ${fact(msg('Room'), summary.room, 'room')}
            ${optionalFact(msg('Spot'), summary.spot, 'spot')}
          </dl>
        `,
      )}
      ${block(
        'name',
        msg('Name', {
          id: 'add-device.step.name',
          desc: 'Step label, a verb: give the device its name',
        }),
        onEdit,
        status.name,
        html`
          <dl class="wa-cluster wa-gap-l app-facts">
            ${fact(msg('Name'), summary.name, 'name')}
          </dl>
        `,
      )}
    </div>
  `
}
