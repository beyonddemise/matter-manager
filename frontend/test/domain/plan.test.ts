import { describe, expect, it } from 'vitest'
import {
  allowsMore,
  canOwnAnother,
  DEFAULT_PLAN,
  exceedsLimit,
  isLegacyLimit,
  isPlan,
  isWaitlistPlan,
  LAYOUTS,
  limitFor,
  PLAN_FEATURES,
  PLANS as PLANS_IN_ORDER,
  type Plan,
  planOf,
  planSyncs,
  plansAbove,
  SYNCED_PLANS,
  showsUpgrade,
  tierOf,
  UNHEARD_PROJECT_LIMIT,
  withinLimit,
} from '../../src/domain/plan.js'

const PLANS: readonly Plan[] = ['free', 'member', 'pro']

describe('the plan tables', () => {
  it('mirror the backend', () => {
    expect(SYNCED_PLANS).toEqual({ free: false, member: true, pro: true })
  })

  it.each([
    [0, 1, true],
    [1, 1, false],
    [4, 5, true],
    [5, 5, false],
    [0, 0, false],
    // -1 is tested before comparing: `0 >= -1` would make the unlimited plan unable to start.
    [0, -1, true],
    [1000, -1, true],
  ])('withinLimit(%i owned, limit %i) is %s', (owned, limit, expected) => {
    expect(withinLimit(owned, limit)).toBe(expected)
  })

  it('knows its plans and nothing else', () => {
    for (const plan of PLANS) expect(isPlan(plan)).toBe(true)
    for (const other of ['gold', '', undefined, null, 3, 'FREE']) expect(isPlan(other)).toBe(false)
  })

  it('reads anything unknown as free', () => {
    expect(planOf('pro')).toBe('pro')
    expect(planOf('platinum')).toBe('free')
    expect(planOf(undefined)).toBe('free')
  })

  it('assumes the plan that grants least when nothing is known', () => {
    expect(DEFAULT_PLAN).toBe('free')
    expect(planOf(undefined)).toBe(DEFAULT_PLAN)
  })

  it('asks the plan which layout, upgrade offer and sync it has', () => {
    expect(PLANS.map((p) => LAYOUTS[p])).toEqual(['free', 'member', 'pro'])
    expect(PLANS.map(showsUpgrade)).toEqual([true, true, false])
    expect(PLANS.map(planSyncs)).toEqual([false, true, true])
  })
})

describe('the limit the page uses', () => {
  it('is one project when the server has not said, whatever the plan (ADR 0020)', () => {
    expect(limitFor()).toBe(1)
    expect(UNHEARD_PROJECT_LIMIT).toBe(1)
  })

  it('is what the server reported when it did, even -1 or 0', () => {
    expect(limitFor(3)).toBe(3)
    expect(limitFor(-1)).toBe(-1)
    expect(limitFor(0)).toBe(0)
  })
})

describe('whether another project may be owned', () => {
  it.each([
    [0, undefined, true],
    [1, undefined, false],
    [2, 3, true],
    [3, 3, false],
    [4, 5, true],
    [5, 5, false],
    [50, -1, true],
  ])('owning %i with limit %s may own another: %s', (owned, reported, allowed) => {
    expect(canOwnAnother(owned, reported)).toBe(allowed)
  })
})

describe('a legacy limit', () => {
  it.each([
    [5, 3, true],
    [3, 3, false],
    [3, 5, false],
    [-1, 5, true],
    [-1, 0, true],
    [5, -1, false],
    [-1, -1, false],
    [0, 0, false],
  ])('limit %i allows more than %i: %s', (a, b, expected) => {
    expect(allowsMore(a, b)).toBe(expected)
  })

  it('is an account limit above the plan limit, and unknown without the plan limit', () => {
    expect(isLegacyLimit(5, 3)).toBe(true)
    expect(isLegacyLimit(-1, 25)).toBe(true)
    expect(isLegacyLimit(3, 3)).toBe(false)
    expect(isLegacyLimit(5, undefined)).toBe(false)
  })
})

describe('whether an account owns more than its limit', () => {
  it.each([
    [1, 1, false],
    [2, 1, true],
    [6, 5, true],
    [5, 5, false],
    [0, 0, false],
    [1, 0, true],
    // Unlimited is never exceeded: `1000 > -1` would put every pro account over its limit.
    [1000, -1, false],
  ])('exceedsLimit(%i owned, limit %i) is %s', (owned, limit, expected) => {
    expect(exceedsLimit(owned, limit)).toBe(expected)
  })
})

describe('the plans in order', () => {
  it('lists every plan once, lowest first', () => {
    expect(PLANS_IN_ORDER).toEqual(['free', 'member', 'pro'])
    // Every plan the tables know, and no other: a fourth plan added to the tables but not here
    // would be missing from the comparison.
    expect([...PLANS_IN_ORDER].sort()).toEqual(Object.keys(SYNCED_PLANS).sort())
  })

  it.each([
    ['free', ['member', 'pro']],
    ['member', ['pro']],
    ['pro', []],
  ] satisfies [Plan, Plan[]][])('above %s: %j', (plan, above) => {
    expect(plansAbove(plan)).toEqual(above)
  })

  it.each([
    ['free', false],
    ['member', true],
    ['pro', true],
    ['gold', false],
    ['', false],
    [undefined, false],
    [null, false],
    [2, false],
  ])('can wait for %j: %s', (value, expected) => {
    expect(isWaitlistPlan(value)).toBe(expected)
  })

  it('compares client name, transfer and price per plan', () => {
    expect(PLAN_FEATURES).toEqual({
      free: { clientName: false, transfer: false, price: 'free' },
      member: { clientName: false, transfer: false, price: 'tba' },
      pro: { clientName: true, transfer: true, price: 'tba' },
    })
  })

  it('cannot be changed from outside', () => {
    expect(Object.isFrozen(PLANS_IN_ORDER)).toBe(true)
    expect(Object.isFrozen(PLAN_FEATURES)).toBe(true)
  })
})

describe('the marketing names the plan matrix uses', () => {
  it.each([
    ['free', 'free'],
    ['home', 'member'],
    ['member', 'member'],
    ['pro', 'pro'],
  ] satisfies [string, Plan][])('%s is the %s tier', (key, tier) => {
    expect(tierOf(key)).toBe(tier)
  })

  it('answers undefined for a marketing name this build does not know', () => {
    // Not an error: the dialog shows such a column without "Your plan" or waitlist actions, so
    // a fourth marketing plan displays before this build learns its tier.
    expect(tierOf('enterprise')).toBeUndefined()
  })

  it.each(['constructor', 'toString', '__proto__', 'hasOwnProperty'])(
    'never answers %s off the prototype chain',
    (key) => {
      // The key is server data; a bare record lookup would answer with a function.
      expect(tierOf(key)).toBeUndefined()
    },
  )
})
