import { describe, expect, it } from 'vitest'
import {
  canOwnAnother,
  DEFAULT_PLAN,
  exceedsLimit,
  isPlan,
  LAYOUTS,
  limitFor,
  PLAN_FEATURES,
  PLANS as PLANS_IN_ORDER,
  type Plan,
  PROJECT_LIMITS,
  planOf,
  planSyncs,
  plansAbove,
  SYNCED_PLANS,
  showsUpgrade,
  withinLimit,
} from '../../src/domain/plan.js'

const PLANS: readonly Plan[] = ['free', 'member', 'pro']

describe('the plan tables', () => {
  it('mirror the backend', () => {
    expect(PROJECT_LIMITS).toEqual({ free: 1, member: 5, pro: -1 })
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
  it('is the table entry when the server has not said', () => {
    expect(PLANS.map((p) => limitFor(p))).toEqual([1, 5, -1])
  })

  it('is what the server reported when it did, even -1 or 0', () => {
    expect(limitFor('free', 3)).toBe(3)
    expect(limitFor('member', -1)).toBe(-1)
    expect(limitFor('pro', 0)).toBe(0)
  })
})

describe('whether another project may be owned', () => {
  const owned = [0, 1, 4, 5, 6, 100]
  const expected: Record<Plan, boolean[]> = {
    free: [true, false, false, false, false, false],
    member: [true, true, true, false, false, false],
    pro: [true, true, true, true, true, true],
  }

  for (const plan of PLANS) {
    it.each(owned.map((n, i) => [n, expected[plan][i]]))(
      `${plan} owning %i may own another: %s`,
      (count, allowed) => {
        expect(canOwnAnother(plan, count as number)).toBe(allowed)
      },
    )
  }

  it('prefers the reported limit over the table', () => {
    expect(canOwnAnother('free', 1, 2)).toBe(true)
    expect(canOwnAnother('pro', 3, 3)).toBe(false)
    expect(canOwnAnother('member', 50, -1)).toBe(true)
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
    expect([...PLANS_IN_ORDER].sort()).toEqual(Object.keys(PROJECT_LIMITS).sort())
  })

  it.each([
    ['free', ['member', 'pro']],
    ['member', ['pro']],
    ['pro', []],
  ] satisfies [Plan, Plan[]][])('above %s: %j', (plan, above) => {
    expect(plansAbove(plan)).toEqual(above)
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
