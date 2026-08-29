import { beforeEach, describe, expect, it, vi } from 'vitest'
import { readStorageReport, requestPersistence, STORAGE_ASKED_KEY } from '../src/storage.js'

/**
 * #112: nothing asked the browser to keep this data, so everything the application holds sat in
 * best-effort storage — evictable under pressure, LRU across origins, and the user never told.
 *
 * Every case here is reached through a stub. That is not a convenience: a real browser cannot be
 * made to *refuse* persistence, and refusal is the state most users on most engines will be in.
 * Testing only what a real `navigator.storage` does would leave the common path uncovered.
 */

/** A `StorageManager` that answers however a test needs it to. */
const storageManager = (answers: {
  persisted?: boolean
  persist?: boolean | (() => Promise<boolean>)
  estimate?: { usage?: number; quota?: number }
}) => ({
  persisted: vi.fn(async () => answers.persisted ?? false),
  persist: vi.fn(async () =>
    typeof answers.persist === 'function' ? answers.persist() : (answers.persist ?? false),
  ),
  estimate: vi.fn(async () => answers.estimate ?? {}),
})

/** A `localStorage` stand-in that starts empty. */
const memoryStorage = () => {
  const held = new Map<string, string>()
  return {
    getItem: (key: string) => held.get(key) ?? null,
    setItem: (key: string, value: string) => void held.set(key, value),
    held,
  }
}

let local: ReturnType<typeof memoryStorage>

beforeEach(() => {
  local = memoryStorage()
})

describe('asking the browser to keep this data', () => {
  it('asks, when nothing has been asked before', async () => {
    const storage = storageManager({ persist: true })
    expect(
      await requestPersistence(
        () => storage,
        () => local,
      ),
    ).toBe('persisted')
    expect(storage.persist).toHaveBeenCalledOnce()
  })

  it('treats a refusal as an ordinary state rather than an error', async () => {
    // What most users on most browsers will get. It must not throw, and must not become a
    // warning the user cannot act on.
    const storage = storageManager({ persist: false })
    expect(
      await requestPersistence(
        () => storage,
        () => local,
      ),
    ).toBe('best-effort')
  })

  it('does not ask twice', async () => {
    const storage = storageManager({ persist: false })
    await requestPersistence(
      () => storage,
      () => local,
    )
    await requestPersistence(
      () => storage,
      () => local,
    )
    // Firefox puts a permission dialogue in front of somebody. Asking on every load would be
    // the application nagging for something the user already declined.
    expect(storage.persist).toHaveBeenCalledOnce()
  })

  it('records that it asked before the answer arrives, not after', async () => {
    // Firefox does not settle `persist()` until the user answers. A flag written afterwards
    // means somebody who ignores the prompt and reloads is asked again, and again - which is
    // L31's "a flag set after an await is a race", in the form the user actually meets.
    let answer: (granted: boolean) => void = () => {}
    const storage = storageManager({
      persist: () =>
        new Promise<boolean>((resolve) => {
          answer = resolve
        }),
    })

    const pending = requestPersistence(
      () => storage,
      () => local,
    )
    await Promise.resolve()
    expect(local.held.get(STORAGE_ASKED_KEY)).toBeDefined()

    answer(false)
    await pending
  })

  it('never asks when the browser has already granted it', async () => {
    const storage = storageManager({ persisted: true, persist: true })
    expect(
      await requestPersistence(
        () => storage,
        () => local,
      ),
    ).toBe('persisted')
    expect(storage.persist).not.toHaveBeenCalled()
  })

  it('says the browser never answered, rather than guessing, when there is no Storage API', async () => {
    // Reporting `best-effort` here would be stating a fact the browser has not stated.
    expect(
      await requestPersistence(
        () => undefined,
        () => local,
      ),
    ).toBe('unknown')
  })

  it('survives an origin that refuses storage outright', async () => {
    // Safari in private browsing throws on the property access itself, which is why the
    // supplier is invoked inside the guard - the same reasoning as `preferences.ts`.
    const throwing = () => {
      throw new DOMException('denied', 'SecurityError')
    }
    expect(await requestPersistence(throwing, () => local)).toBe('unknown')
  })

  it('does not claim best-effort when it could not even ask', async () => {
    // A `persisted()` that throws leaves the standing genuinely unknown. Saying `best-effort`
    // would state a fact the browser never stated - the same reason `unknown` exists at all.
    const storage = {
      persisted: vi.fn(async () => {
        throw new Error('no')
      }),
      persist: vi.fn(async () => true),
      estimate: vi.fn(async () => ({})),
    }
    expect(
      await requestPersistence(
        () => storage,
        () => local,
      ),
    ).toBe('unknown')
    expect(storage.persist).not.toHaveBeenCalled()
  })

  it('survives a persist() that rejects', async () => {
    const storage = {
      persisted: vi.fn(async () => false),
      persist: vi.fn(async () => {
        throw new Error('no')
      }),
      estimate: vi.fn(async () => ({})),
    }
    expect(
      await requestPersistence(
        () => storage,
        () => local,
      ),
    ).toBe('best-effort')
  })
})

describe('what the interface can tell the user', () => {
  it('reports persistence and what is stored', async () => {
    const storage = storageManager({ persisted: true, estimate: { usage: 2048, quota: 4096 } })
    expect(await readStorageReport(() => storage)).toEqual({
      persistence: 'persisted',
      usage: 2048,
      quota: 4096,
    })
  })

  it('reports best-effort without inventing figures the browser withheld', async () => {
    const storage = storageManager({ persisted: false, estimate: {} })
    expect(await readStorageReport(() => storage)).toEqual({ persistence: 'best-effort' })
  })

  it('preserves persistence when the storage estimate rejects', async () => {
    const storage = {
      ...storageManager({ persisted: true }),
      estimate: vi.fn(async () => {
        throw new Error('unavailable')
      }),
    }
    expect(await readStorageReport(() => storage)).toEqual({ persistence: 'persisted' })
  })

  it('asks nothing of the user: reading never prompts', async () => {
    const storage = storageManager({ persisted: false })
    await readStorageReport(() => storage)
    // `persisted()` and `estimate()` are read-only. A status display that could raise a
    // permission dialogue would be a surprise in the one place the user went to avoid one.
    expect(storage.persist).not.toHaveBeenCalled()
  })

  it('reports unknown where there is no Storage API', async () => {
    expect(await readStorageReport(() => undefined)).toEqual({ persistence: 'unknown' })
  })
})
