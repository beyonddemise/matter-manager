import { describe, expect, it } from 'vitest'
import { rateLimiter } from '../../src/security/rate-limit.js'

/** A clock in whole seconds that only moves when told to. */
function clock(start = 1_800_000_000) {
  let seconds = start
  return {
    now: () => seconds,
    advance: (by: number) => {
      seconds += by
    },
  }
}

describe('counting requests', () => {
  it('allows a client up to the limit', () => {
    const time = clock()
    const limiter = rateLimiter({ max: 3, windowSeconds: 60 }, time.now)

    expect([1, 2, 3].map(() => limiter.check('ada').allowed)).toEqual([true, true, true])
  })

  it('refuses the one after that', () => {
    const time = clock()
    const limiter = rateLimiter({ max: 3, windowSeconds: 60 }, time.now)
    for (const _ of [1, 2, 3]) limiter.check('ada')

    expect(limiter.check('ada').allowed).toBe(false)
  })

  it('counts each client separately', () => {
    // Otherwise one noisy client locks out everybody, which is the failure the limit was
    // supposed to prevent rather than cause.
    const time = clock()
    const limiter = rateLimiter({ max: 2, windowSeconds: 60 }, time.now)
    limiter.check('ada')
    limiter.check('ada')

    expect(limiter.check('grace').allowed).toBe(true)
  })

  it('says how many are left, so a caller can be told before it matters', () => {
    const time = clock()
    const limiter = rateLimiter({ max: 3, windowSeconds: 60 }, time.now)

    expect(limiter.check('ada').remaining).toBe(2)
    expect(limiter.check('ada').remaining).toBe(1)
    expect(limiter.check('ada').remaining).toBe(0)
  })

  it('never reports a negative remaining', () => {
    // It is a number a client reads. Going below zero says the limit was exceeded by an amount,
    // which is not information anybody is owed.
    const time = clock()
    const limiter = rateLimiter({ max: 1, windowSeconds: 60 }, time.now)
    limiter.check('ada')
    limiter.check('ada')

    expect(limiter.check('ada').remaining).toBe(0)
  })
})

describe('the window moving on', () => {
  it('lets the client through again once the window has passed', () => {
    const time = clock()
    const limiter = rateLimiter({ max: 1, windowSeconds: 60 }, time.now)
    limiter.check('ada')

    time.advance(60)

    expect(limiter.check('ada').allowed).toBe(true)
  })

  it('does not let them through a second early', () => {
    const time = clock()
    const limiter = rateLimiter({ max: 1, windowSeconds: 60 }, time.now)
    limiter.check('ada')

    time.advance(59)

    expect(limiter.check('ada').allowed).toBe(false)
  })

  it('says how long to wait', () => {
    // `Retry-After`. A refusal that does not say when to come back invites a client to retry
    // immediately and forever, which is more load than the requests it refused.
    const time = clock()
    const limiter = rateLimiter({ max: 1, windowSeconds: 60 }, time.now)
    limiter.check('ada')

    time.advance(20)

    expect(limiter.check('ada').retryAfterSeconds).toBe(40)
  })

  it('never says to wait zero seconds', () => {
    // `Retry-After: 0` reads as "try again now", and a client that does is refused again.
    const time = clock()
    const limiter = rateLimiter({ max: 1, windowSeconds: 60 }, time.now)
    limiter.check('ada')

    time.advance(59.5)

    expect(limiter.check('ada').retryAfterSeconds).toBeGreaterThan(0)
  })

  it('does not extend the window with every refused attempt', () => {
    // A limiter that restarts its window on a *rejected* request lets a client that keeps
    // hammering lock itself out forever, and the client that gives up politely gets back in
    // first. The window belongs to the traffic that was allowed.
    const time = clock()
    const limiter = rateLimiter({ max: 1, windowSeconds: 60 }, time.now)
    limiter.check('ada')

    time.advance(30)
    limiter.check('ada')
    time.advance(30)

    expect(limiter.check('ada').allowed).toBe(true)
  })
})

describe('what it costs to remember', () => {
  it('forgets a client whose window has expired', () => {
    // An entry per address, kept forever, is a memory leak with a public trigger.
    const time = clock()
    const limiter = rateLimiter({ max: 5, windowSeconds: 60 }, time.now)
    for (let index = 0; index < 100; index += 1) limiter.check(`client-${index}`)
    expect(limiter.size()).toBe(100)

    time.advance(61)
    limiter.check('one-more')

    expect(limiter.size()).toBe(1)
  })

  it('does not hold a client to a window that passed between sweeps', () => {
    // The sweep runs at most once per window, so an expired entry can still be sitting in the
    // map when its owner comes back. Reading it as live would refuse somebody whose window had
    // in fact passed — a lockout produced by the housekeeping schedule rather than by anything
    // the client did. Each entry therefore carries its own expiry and the sweep is only tidying.
    const time = clock()
    const limiter = rateLimiter({ max: 1, windowSeconds: 60 }, time.now)
    limiter.check('warm-up') // t+0: the first check always sweeps, so the schedule starts here

    time.advance(1)
    limiter.check('ada') // window runs from t+1 to t+61

    time.advance(59)
    limiter.check('somebody-else') // t+60: a sweep falls due, and ada is not yet stale

    time.advance(2) // t+62: ada has expired, and no sweep is due until t+120

    expect(limiter.check('ada').allowed).toBe(true)
  })

  it('keeps clients that are still inside their window', () => {
    // The sweep has to be a sweep, not a periodic amnesty — a limiter that forgets everybody
    // every so often has a hole in it exactly that often.
    const time = clock()
    const limiter = rateLimiter({ max: 1, windowSeconds: 60 }, time.now)
    limiter.check('ada')

    time.advance(30)
    limiter.check('grace')

    expect(limiter.check('ada').allowed).toBe(false)
  })

  it('refuses rather than growing without bound', () => {
    // Under a flood from many addresses the map cannot hold them all. These are sign-in
    // endpoints, so refusing is the conservative answer: a service that has run out of room to
    // account for a client should not be minting tokens for it. The alternative — evicting
    // somebody to make space — is a bypass anyone can trigger by making enough noise.
    const time = clock()
    const limiter = rateLimiter({ max: 5, windowSeconds: 60, maxClients: 3 }, time.now)
    limiter.check('a')
    limiter.check('b')
    limiter.check('c')

    expect(limiter.check('d').allowed).toBe(false)
  })

  it('still serves the clients it already knows when it is full', () => {
    // The refusal above is for *new* clients. Someone already counted is not collateral.
    const time = clock()
    const limiter = rateLimiter({ max: 5, windowSeconds: 60, maxClients: 3 }, time.now)
    limiter.check('a')
    limiter.check('b')
    limiter.check('c')
    limiter.check('d')

    expect(limiter.check('a').allowed).toBe(true)
  })

  it('takes new clients again once there is room', () => {
    const time = clock()
    const limiter = rateLimiter({ max: 5, windowSeconds: 60, maxClients: 3 }, time.now)
    limiter.check('a')
    limiter.check('b')
    limiter.check('c')

    time.advance(61)

    expect(limiter.check('d').allowed).toBe(true)
  })
})
