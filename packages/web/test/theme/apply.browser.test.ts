import { describe, expect, it } from 'vitest'
import { applyLook, loadAndApplyLook } from '../../src/theme.js'

/**
 * In the browser project rather than beside the preference tests, because this is the half that
 * touches a real `classList`. The preference logic next door is pure and runs in Node.
 */
describe('putting the look on the document', () => {
  const element = () => {
    const root = document.createElement('html')
    root.className = 'wa-theme-glossy wa-palette-anodized wa-light'
    return root
  }

  it('replaces the previous theme rather than stacking on it', () => {
    const root = element()
    applyLook(root, 'mellow', 'vogue')
    expect([...root.classList]).toContain('wa-theme-mellow')
    expect([...root.classList]).not.toContain('wa-theme-glossy')
  })

  it('replaces the previous palette', () => {
    const root = element()
    applyLook(root, 'mellow', 'vogue')
    expect([...root.classList]).toContain('wa-palette-vogue')
    expect([...root.classList]).not.toContain('wa-palette-anodized')
  })

  it('leaves the scheme alone, because it is not this function to decide', () => {
    // `scheme.ts` owns wa-light/wa-dark. Clearing them here would turn choosing a palette into
    // silently changing the user's light/dark preference.
    const root = element()
    applyLook(root, 'mellow', 'vogue')
    expect([...root.classList]).toContain('wa-light')
  })

  it('clears a theme class it was never told about', () => {
    // The previous pair is not passed in, and reading it back from the element would make the
    // result depend on what somebody else wrote there.
    const root = element()
    root.classList.add('wa-theme-brutalist', 'wa-palette-bright')
    applyLook(root, 'mellow', 'vogue')
    const applied = [...root.classList].filter(
      (name) => name.startsWith('wa-theme-') || name.startsWith('wa-palette-'),
    )
    expect(applied.sort()).toEqual(['wa-palette-vogue', 'wa-theme-mellow'])
  })

  it('applies the look when nothing has overtaken it', async () => {
    // The positive control, and it earns its place: a guard that refused *everything* would
    // pass the test below and never apply a look at all.
    const root = element()
    await loadAndApplyLook(root, 'mellow', 'vogue', async () => {})
    expect(root.classList.contains('wa-theme-mellow')).toBe(true)
  })

  it('does not let an older request overwrite a newer look', async () => {
    // The case review named: `main.ts` applies the stored look at startup, and that load is
    // slow enough that somebody can reach Settings and choose differently while it is in
    // flight. A token counting only one caller's changes leaves the other outside it.

    const root = element()
    const pending: Array<() => void> = []
    const loader = () => new Promise<void>((resolve) => pending.push(resolve))

    const startup = loadAndApplyLook(root, 'mellow', 'vogue', loader)
    const selection = loadAndApplyLook(root, 'premium', 'bright', loader)
    pending[1]?.()
    await selection
    pending[0]?.()
    await startup

    expect(root.classList.contains('wa-theme-premium')).toBe(true)
    expect(root.classList.contains('wa-palette-bright')).toBe(true)
    expect(root.classList.contains('wa-theme-mellow')).toBe(false)
  })
})
