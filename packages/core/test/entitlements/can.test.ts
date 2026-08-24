import { describe, expect, it } from 'vitest'
import {
  ACTIONS,
  type Action,
  ALLOW,
  can,
  evaluate,
  POLICIES,
  type Policy,
  type Principal,
} from '../../src/entitlements/can.js'

const owner: Principal = { sub: 'auth0|owner', plan: 'free' }
const project = { id: 'project:6ba7b810-9dad-11d1-80b4-00c04fd430c8' }

describe('can', () => {
  it.each(ACTIONS.map((action) => [action]))('permits %s today', (action) => {
    expect(can(owner, action, project)).toBe(true)
  })

  it('permits actions that have no project, such as creating one', () => {
    expect(can(owner, 'project.create')).toBe(true)
  })

  /**
   * Found by mutation: replacing the whole of `can` with `return true` broke no test, because
   * every declared action is permitted today and a bypass is indistinguishable from a
   * consultation that says yes.
   *
   * That is precisely the failure ADR 0009 exists to prevent — a seam that is present but not
   * consulted — and it would stay invisible until M8 wrote a real policy that nothing ever
   * called. An unknown action is the one question whose answer can only come from the table,
   * so it is what pins the wiring.
   */
  it('goes through the policy table rather than answering by itself', () => {
    const unknown = 'device.teleport' as Action
    expect(can(owner, unknown, project)).toBe(false)
  })

  it('answers every declared action without throwing', () => {
    // Totality matters more than the answer: a call site that throws is worse than one that
    // returns the wrong verdict, because it takes the feature down rather than gating it.
    for (const action of ACTIONS) {
      expect(() => can(owner, action, project)).not.toThrow()
    }
  })
})

/**
 * The tests above pass against `const can = () => true`, which is exactly what this module
 * looks like today — and would keep passing on the day M8 writes a real policy that is never
 * consulted. That failure is silent and expensive: every gated action reports permitted, and
 * the symptom is revenue rather than an exception.
 *
 * So the wiring is tested separately from the verdict, by evaluating against a table that
 * says no. If `evaluate` ignored its policies, these fail.
 */
describe('evaluate consults the policy table', () => {
  const DENY: Policy = () => false
  const denyAll = Object.fromEntries(ACTIONS.map((action) => [action, DENY])) as Record<
    Action,
    Policy
  >

  it.each(ACTIONS.map((action) => [action]))('refuses %s when its policy refuses', (action) => {
    expect(evaluate(denyAll, owner, action, project)).toBe(false)
  })

  it('consults the policy for the action asked about, not some other one', () => {
    // A lookup that ignored `action` — returning the first policy, say — would pass a table
    // that is uniformly deny or uniformly allow. This one is mixed.
    const mixed = { ...denyAll, 'pdf.export': ALLOW } as Record<Action, Policy>

    expect(evaluate(mixed, owner, 'pdf.export', project)).toBe(true)
    expect(evaluate(mixed, owner, 'project.create', project)).toBe(false)
  })

  it('passes the principal and project through to the policy', () => {
    // M8's policies decide on the plan and on what is already in the project. If the
    // arguments do not arrive, those policies cannot be written without changing this seam -
    // which is the one thing it exists to avoid.
    const seen: Array<{ principal: Principal; project?: { id: string } }> = []
    const recording: Policy = (principal, target) => {
      seen.push({ principal, ...(target === undefined ? {} : { project: target }) })
      return true
    }
    const table = Object.fromEntries(ACTIONS.map((a) => [a, recording])) as Record<Action, Policy>

    evaluate(table, owner, 'device.create', project)

    expect(seen).toEqual([{ principal: owner, project }])
  })

  /**
   * A lookup walks the prototype chain, so these names resolve to real functions on
   * `Object.prototype` and pass a `typeof` check. `'constructor'` then returns a truthy
   * object and `if (can(...))` permits it; `'valueOf'` throws instead, taking the gate down
   * rather than opening it. Both are reachable from any untyped caller — the API boundary, a
   * stale persisted value, a query parameter.
   */
  it.each([
    ['constructor'],
    ['toString'],
    ['valueOf'],
    ['hasOwnProperty'],
    ['__proto__'],
    ['isPrototypeOf'],
  ])('refuses the inherited property %s instead of invoking it', (name) => {
    const action = name as Action
    expect(() => evaluate(POLICIES, owner, action, project)).not.toThrow()
    expect(evaluate(POLICIES, owner, action, project)).toBe(false)
    expect(can(owner, action, project)).toBe(false)
  })

  it.each([
    ['a string', 'yes'],
    ['null', null],
    ['a number', 1],
    ['an object', {}],
  ])('refuses an own entry that is %s rather than calling it', (_label, value) => {
    // Found by mutation: the own-property guard alone lets this through to be invoked, which
    // throws rather than refusing. A gate that throws takes the feature down instead of
    // closing it, so the wrong shape has to be a refusal.
    const broken = { ...POLICIES, 'pdf.export': value as unknown as Policy }
    expect(() => evaluate(broken, owner, 'pdf.export', project)).not.toThrow()
    expect(evaluate(broken, owner, 'pdf.export', project)).toBe(false)
  })

  it('refuses a policy that returns a truthy value which is not true', () => {
    // Only an explicit `true` permits. A gate should fail closed on every unexpected value,
    // and a policy returning a non-boolean is exactly that.
    const sloppy = { ...POLICIES, 'pdf.export': (() => 'yes') as unknown as Policy }
    expect(evaluate(sloppy, owner, 'pdf.export', project)).toBe(false)
  })

  /**
   * `Object.hasOwn` converts its second argument to a property key, and an object with no
   * prototype has no `toString` to convert with — so the guard meant to refuse an unknown
   * action raises `TypeError` before it can refuse anything. Reachable from any untyped
   * caller that forwards a parsed JSON body.
   */
  it.each([
    ['an object with no prototype', Object.create(null)],
    ['a symbol', Symbol('nope')],
    ['a number', 7],
    ['null', null],
    ['undefined', undefined],
  ])('refuses %s as an action instead of throwing', (_label, value) => {
    const action = value as unknown as Action
    expect(() => evaluate(POLICIES, owner, action, project)).not.toThrow()
    expect(evaluate(POLICIES, owner, action, project)).toBe(false)
    expect(() => can(owner, action, project)).not.toThrow()
    expect(can(owner, action, project)).toBe(false)
  })

  /**
   * A policy that throws is a bug, but propagating it takes the gate down and with it the
   * feature — the same failure as `valueOf`, arriving from the policy side. Denying keeps the
   * application running and makes the bug visible to whoever tries the action.
   */
  it('denies when a policy throws rather than letting the gate fall over', () => {
    const exploding = {
      ...POLICIES,
      'pdf.export': (() => {
        throw new Error('policy bug')
      }) as Policy,
    }
    expect(() => evaluate(exploding, owner, 'pdf.export', project)).not.toThrow()
    expect(evaluate(exploding, owner, 'pdf.export', project)).toBe(false)
  })

  /**
   * The attack the own-property check exists for, and the reason it is not redundant with the
   * strict `=== true` result check.
   *
   * A polluted prototype supplies a policy returning exactly `true`, so every downstream guard
   * is satisfied — the value is callable, it does not throw, and it returns the one value that
   * permits. Only refusing to look up the prototype chain in the first place stops it.
   */
  it('refuses an action reachable only through a polluted Object.prototype', () => {
    const injected = 'data.export'
    try {
      ;(Object.prototype as Record<string, unknown>)[injected] = () => true

      expect(evaluate(POLICIES, owner, injected as Action, project)).toBe(false)
      expect(can(owner, injected as Action, project)).toBe(false)
    } finally {
      delete (Object.prototype as Record<string, unknown>)[injected]
    }
  })

  it('leaves Object.prototype as it found it', () => {
    // Guards the test above: if the cleanup failed, later runs would see a polluted prototype
    // and the assertion would be measuring the wrong thing.
    expect('data.export' in Object.prototype).toBe(false)
  })

  /**
   * Why the string check is not redundant with the own-property check.
   *
   * Every other non-string action is refused either way — `Object.hasOwn` throws on a
   * null-prototype object and the catch denies, and a number or `null` is simply not an own
   * key. A symbol is different: it is a legal property key, so if one is present in the table
   * it *is* an own property, and without the string check it would be looked up and invoked.
   * `Action` is a union of strings, so a symbol action is never legitimate.
   */
  it('refuses a symbol action even when the table has that symbol as an own key', () => {
    const sneaky = Symbol('sneaky')
    const table = { ...POLICIES, [sneaky]: ALLOW } as Record<Action, Policy>

    expect(evaluate(table, owner, sneaky as unknown as Action, project)).toBe(false)
  })

  it('denies when the policy table itself throws on inspection', () => {
    // A proxy can throw from getOwnPropertyDescriptor, which is what Object.hasOwn calls. The
    // guard meant to keep the gate closed then escapes the catch and takes it down instead -
    // the same failure as valueOf and as a throwing policy, arriving from a third direction.
    const hostile = new Proxy({} as Record<Action, Policy>, {
      getOwnPropertyDescriptor() {
        throw new Error('hostile table')
      },
      has() {
        throw new Error('hostile table')
      },
    })

    expect(() => evaluate(hostile, owner, 'pdf.export', project)).not.toThrow()
    expect(evaluate(hostile, owner, 'pdf.export', project)).toBe(false)
  })

  it('reports an unknown action as refused rather than permitted', () => {
    // Reachable only from untyped callers - the API boundary, a stale persisted value. The
    // safe direction for an unrecognised action is to refuse it; permitting by default is how
    // a typo becomes a bypass.
    const unknown = 'device.teleport' as Action
    expect(evaluate(POLICIES, owner, unknown, project)).toBe(false)
  })
})

describe('the declared actions', () => {
  it('has a policy for every action and no others', () => {
    expect(Object.keys(POLICIES).sort()).toEqual([...ACTIONS].sort())
  })

  it('lists each action exactly once', () => {
    expect(new Set(ACTIONS).size).toBe(ACTIONS.length)
  })

  it('covers the actions ADR 0009 names as gated', () => {
    // The ADR names these four specifically. Losing one silently would leave a gated action
    // with nowhere to ask permission, which is the retrofit problem the seam prevents.
    expect(ACTIONS).toContain('project.create')
    expect(ACTIONS).toContain('project.invite')
    expect(ACTIONS).toContain('pdf.export')
    expect(ACTIONS).toContain('device.attachPhoto')
  })

  it('permits everything today, as ADR 0009 requires', () => {
    // `every` on an empty array is true, so an empty table would satisfy this on its own.
    // Asserting the count first is what stops that reading as a pass.
    expect(Object.values(POLICIES)).toHaveLength(ACTIONS.length)
    expect(Object.values(POLICIES).every((policy) => policy(owner, project))).toBe(true)
  })
})

/**
 * The compile-time half of the story, and the reason the policy table is declared with
 * `satisfies`. These assertions are checked by `tsc` during `npm run verify`, not by vitest —
 * a `@ts-expect-error` that stops being an error is itself an error, so the guarantee fails
 * loudly the moment it stops holding.
 */
describe('the policy table is complete at compile time', () => {
  it('rejects a table that is missing an action', () => {
    const incomplete = {
      'project.create': ALLOW,
      // @ts-expect-error every action needs an explicit policy; this table omits most of them
    } satisfies Record<Action, Policy>

    expect(Object.keys(incomplete)).toHaveLength(1)
  })

  it('rejects a table naming an action that does not exist', () => {
    const invented = {
      ...POLICIES,
      // @ts-expect-error 'device.teleport' is not an Action
      'device.teleport': ALLOW,
    } satisfies Record<Action, Policy>

    expect(Object.keys(invented).length).toBeGreaterThan(ACTIONS.length)
  })
})
