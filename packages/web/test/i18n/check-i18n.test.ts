import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '../../../..')
const checker = join(repoRoot, 'scripts/check-i18n.mjs')

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
