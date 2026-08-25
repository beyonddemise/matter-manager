import { describe, expect, it } from 'vitest'
import { applyScheme } from '../src/scheme.js'

describe('applyScheme', () => {
  it('sets exactly one scheme class', () => {
    const root = document.createElement('html')
    root.className = 'wa-theme-glossy wa-palette-anodized wa-light'

    applyScheme(root, 'dark')

    expect(root.classList.contains('wa-dark')).toBe(true)
    expect(root.classList.contains('wa-light')).toBe(false)
  })

  it('leaves the theme and palette classes alone', () => {
    const root = document.createElement('html')
    root.className = 'wa-theme-glossy wa-palette-anodized wa-light'

    applyScheme(root, 'dark')

    expect(root.classList.contains('wa-theme-glossy')).toBe(true)
    expect(root.classList.contains('wa-palette-anodized')).toBe(true)
  })

  it('is idempotent', () => {
    const root = document.createElement('html')
    applyScheme(root, 'dark')
    applyScheme(root, 'dark')
    expect([...root.classList].filter((c) => c === 'wa-dark')).toHaveLength(1)
  })
})
