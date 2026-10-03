import { afterEach, describe, expect, it, vi } from 'vitest'
import { consoleSignInLog } from '../../src/auth/sign-in-log.js'

afterEach(() => vi.restoreAllMocks())

describe('consoleSignInLog', () => {
  it('writes one JSON line with the fields the spec names', () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    consoleSignInLog(() => new Date('2026-10-03T10:00:00Z'))({
      sub: 'google|1',
      email: 'ada@example.com',
      provider: 'google',
      hasRecord: false,
    })
    expect(log).toHaveBeenCalledOnce()
    expect(JSON.parse(String(log.mock.calls[0]?.[0]))).toEqual({
      level: 'info',
      msg: 'sign-in',
      at: '2026-10-03T10:00:00.000Z',
      sub: 'google|1',
      email: 'ada@example.com',
      provider: 'google',
      hasRecord: false,
    })
  })
})
