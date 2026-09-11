import { expect, it } from 'vitest'

it('runs in a real browser with a DOM and custom element support', () => {
  const element = document.createElement('div')
  element.textContent = 'hello'
  document.body.append(element)

  expect(document.body.contains(element)).toBe(true)
  expect(typeof customElements.define).toBe('function')
  expect(typeof window.matchMedia).toBe('function')

  element.remove()
})
