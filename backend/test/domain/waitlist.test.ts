import { describe, expect, it } from 'vitest'
import { hasAtLeast, isWaitlistPlan, type Plan } from '../../src/domain/index.js'

describe('plan order', () => {
  it.each([
    ['free', 'member', false],
    ['free', 'pro', false],
    ['member', 'free', true],
    ['member', 'member', true],
    ['member', 'pro', false],
    ['pro', 'member', true],
    ['pro', 'pro', true],
  ] satisfies [Plan, Plan, boolean][])('%s has at least %s: %s', (held, wanted, expected) => {
    expect(hasAtLeast(held, wanted)).toBe(expected)
  })
})

describe('what can be waited for', () => {
  it.each([['member'], ['pro']])('accepts %s', (value) => {
    expect(isWaitlistPlan(value)).toBe(true)
  })

  it.each([
    ['free'],
    ['gold'],
    [''],
    ['Pro'],
    // Own properties only: these resolve through the prototype of a plain object.
    ['constructor'],
    ['toString'],
    [null],
    [undefined],
    [2],
  ])('refuses %s', (value) => {
    expect(isWaitlistPlan(value)).toBe(false)
  })
})
