import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), '../../..')
const checker = join(packageRoot, 'scripts/check-i18n.mjs')

/**
 * Runs the unwrapped-string scan over a throwaway directory.
 *
 * A checker nobody has watched fail is a checker nobody knows works, and this one is a
 * hand-written scanner over markup rather than something borrowed and trusted (lesson L8).
 * Each case below plants exactly one thing and asserts the verdict flips.
 */
function scan(files: Record<string, string>): { code: number; output: string } {
  const directory = mkdtempSync(join(tmpdir(), 'check-i18n-test-'))
  try {
    for (const [name, contents] of Object.entries(files)) {
      writeFileSync(join(directory, name), contents)
    }
    const result = spawnSync('node', [checker, '--scan', directory], { encoding: 'utf8' })
    return { code: result.status ?? -1, output: `${result.stdout}${result.stderr}` }
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
}

// Written as template literals rather than plain strings so that the `${…}` they contain is
// a real escaped substitution marker in the fixture, not a suspicious-looking string literal.
const DEVICES_CALL = `\${msg('Devices')}`
const MENU_LABEL = `label=\${msg('Menu')}`

const WRAPPED = `
import { msg } from '@lit/localize'
import { html } from 'lit'
export const view = () => html\`
  <div class="wa-stack">
    <h1>\${msg('Devices')}</h1>
    <wa-icon name="bars" label=\${msg('Menu')}></wa-icon>
  </div>
\`
`

describe('the unwrapped-string scan', () => {
  it('passes markup whose every visible string goes through msg()', () => {
    const { code, output } = scan({ 'view.ts': WRAPPED })
    expect(output).toContain('ok')
    expect(code).toBe(0)
  })

  it('catches text typed straight into a template', () => {
    const { code, output } = scan({ 'view.ts': WRAPPED.replace(DEVICES_CALL, 'Devices') })
    expect(code).toBe(1)
    expect(output).toContain('view.ts')
    expect(output).toContain('Devices')
  })

  it('catches a user-visible attribute that is a plain literal', () => {
    const { code, output } = scan({
      'view.ts': WRAPPED.replace(MENU_LABEL, 'label="Menu"'),
    })
    expect(code).toBe(1)
    expect(output).toContain('label="Menu"')
  })

  it('catches text in a template nested inside a substitution', () => {
    // The scan walks every `html` backtick in the file rather than only the outermost, which
    // is the only reason a repeat block - the shape every list in this application uses - is
    // covered at all.
    const nested = `
      import { html } from 'lit'
      export const list = (items) => html\`<ul>\${items.map((i) => html\`<li>Room \${i}</li>\`)}</ul>\`
    `
    const { code, output } = scan({ 'list.ts': nested })
    expect(code).toBe(1)
    expect(output).toContain('Room')
  })

  it('does not mistake markup for prose', () => {
    // Tag names, class names, non-visible attributes, entities and punctuation are not text a
    // user reads. A checker that flagged them would be turned off within a week.
    const quiet = `
      import { html } from 'lit'
      export const view = (name) => html\`
        <!-- a comment mentioning Devices -->
        <div class="wa-stack wa-gap-l" data-drawer="close" aria-current="page">
          <a href="#/settings">\${name}</a>&nbsp;&mdash;&nbsp;(\${name})
        </div>
      \`
    `
    const { code, output } = scan({ 'view.ts': quiet })
    expect(output).toContain('ok')
    expect(code).toBe(0)
  })

  it('ignores plain strings that are not in a template', () => {
    // The endonym table in locale.ts is exactly this: user-visible text that must NOT be
    // translated, kept out of markup so the scan never sees it.
    const data = `export const LOCALE_NAMES = { en: 'English', de: 'Deutsch' }`
    const { code } = scan({ 'locale.ts': data })
    expect(code).toBe(0)
  })
})

// #283: `endOfSubstitution` walked a `${…}` skipping string and template literals but not
// comments, so an apostrophe inside a comment opened a phantom string. `endOfQuoted` paired
// it with the next `'` anywhere below, the substitution was declared to end at the next `}`
// after that, and real code was flattened into the template's "text".
//
// The shape mirrors the issue's evidence on #282: the false report named `renderEmptySlot`,
// a method that pull request never touched. Every string the fixture renders goes through
// msg(), so the only possible finding is the false one.
const cardWithComment = (comment: string) => `
import { msg } from '@lit/localize'
import { html } from 'lit'
export class Card {
  private editing = false
  protected render() {
    return html\`
      <section class="app-form">
        \${
          ${comment}
          this.editing ? msg('Editing') : msg('Reading')
        }
      </section>
    \`
    // The caller doesn't see this comment.
  }
  private renderEmptySlot() {
    return html\`<p>\${msg('Empty')}</p>\`
  }
}
`

describe('comments inside a substitution (#283)', () => {
  it('reads an apostrophe in a // comment as prose, not as an opening quote', () => {
    const { code, output } = scan({
      'card.ts': cardWithComment("// a form is not a heading's content"),
    })
    expect(output).not.toContain('renderEmptySlot')
    expect(output).toContain('ok')
    expect(code).toBe(0)
  })

  it('reads an apostrophe in a /* */ comment the same way', () => {
    const { code, output } = scan({
      'card.ts': cardWithComment("/* a form is not a heading's content */"),
    })
    expect(output).not.toContain('renderEmptySlot')
    expect(output).toContain('ok')
    expect(code).toBe(0)
  })

  it('still catches genuine unwrapped text after a comment', () => {
    // Guards the fix against over-consuming: a // skip that ran past its own line, or a
    // /* */ skip that ran past the terminator, would swallow this text and pass quietly.
    const view = `
import { msg } from '@lit/localize'
import { html } from 'lit'
export const view = (editing) => html\`
  <section>
    \${
      // a heading's note
      editing ? msg('Editing') : msg('Reading')
    }
    Forgotten text after the comment
  </section>
\`
`
    const { code, output } = scan({ 'view.ts': view })
    expect(code).toBe(1)
    expect(output).toContain('Forgotten')
  })

  it('reports an unterminated block comment instead of passing silently or hanging', () => {
    // A /* with no */ runs to the end of the file, so the template can never close. The
    // sound failure is a loud one: a template the scanner could not parse to its closing
    // backtick is reported, never silently dropped.
    const broken = `
import { msg } from '@lit/localize'
import { html } from 'lit'
export const view = () => html\`<p>\${
  /* an unterminated comment
  msg('Hello')
}</p>\`
`
    const { code, output } = scan({ 'broken.ts': broken })
    expect(code).toBe(1)
    expect(output).toContain('never closes')
  })
})

// Found while fixing #283: `endOfTemplate` advanced one character past what
// `endOfSubstitution` returned, which is already the index past the closing brace. When a
// substitution sits flush against its template's closing backtick — msg(str`Project ${name}`)
// does, in views/project-line.ts — the skipped character WAS that backtick, the walk swallowed
// code up to the next one, and the whole outer template silently vanished from the scan.
describe('a substitution flush against its closing backtick (#283)', () => {
  const line = (trailing: string) => `
import { msg, str } from '@lit/localize'
import { html } from 'lit'
export const line = (name) => html\`<p>
  \${msg(str\`Project \${name}\`, { desc: 'which project the page shows' })}${trailing}
</p>\`
`

  it('walks past it without derailing the template', () => {
    const { code, output } = scan({ 'line.ts': line('') })
    expect(output).toContain('ok')
    expect(code).toBe(0)
  })

  it('still sees unwrapped text after it', () => {
    // The guard that matters: a walk that overshoots the closing backtick swallows the rest
    // of the template, and everything in it stops being inspected.
    const { code, output } = scan({ 'line.ts': line('\n  Trailing unwrapped text') })
    expect(code).toBe(1)
    expect(output).toContain('Trailing')
    expect(output).not.toContain('never closes')
  })
})

describe('the checker itself', () => {
  it('reports every violation it finds, not just the first', () => {
    const twice = `
      import { html } from 'lit'
      export const a = () => html\`<p>First problem</p>\`
      export const b = () => html\`<p>Second problem</p>\`
    `
    const { output } = scan({ 'two.ts': twice })
    expect(output).toContain('First problem')
    expect(output).toContain('Second problem')
    expect(output).toContain('2 problem(s)')
  })
})
