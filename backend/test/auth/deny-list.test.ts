import { describe, expect, it } from 'vitest'
import { denyList } from '../../src/auth/deny-list.js'

describe('denyList', () => {
  it('denies a jti until its expiry and forgets it afterwards', () => {
    let t = 100
    const list = denyList(() => t)
    list.deny('a', 105)
    expect(list.denied('a')).toBe(true)
    t = 105
    expect(list.denied('a')).toBe(false)
  })

  it('prunes expired entries on insert, so it cannot grow without bound', () => {
    let t = 0
    const list = denyList(() => t)
    for (let i = 0; i < 1000; i += 1) list.deny(`old-${i}`, 10)
    t = 11
    list.deny('new', 20)
    expect(list.size()).toBe(1)
  })
})
