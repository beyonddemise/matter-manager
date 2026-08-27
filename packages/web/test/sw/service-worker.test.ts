import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const here = dirname(fileURLToPath(import.meta.url))
const source = readFileSync(join(here, '../../public/sw.js'), 'utf8')

/**
 * The service worker, running.
 *
 * The **actual shipped file** is read and evaluated, rather than a module imported alongside
 * it. That is the whole point: `public/sw.js` is copied verbatim into the build and is never
 * bundled, so anything importable next to it would be a second copy of the logic, free to
 * drift from the one that reaches users. A service worker that has drifted from its tests is
 * the worst case of all, because it sits in front of every request and outlives the page.
 *
 * Possible because it is a classic script with no imports or exports — which it has to be
 * anyway, since Safari has no module service workers.
 */

type Listener = (event: unknown) => void

interface Harness {
  readonly fire: (type: string, event: Record<string, unknown>) => void
  readonly caches: FakeCaches
  readonly requested: string[]
  /** What the last `respondWith` was given, or `undefined` when it was never called. */
  readonly responded: () => Promise<FakeResponse | undefined>
  readonly claimed: () => boolean
  /** How many times the worker has been asked to step aside for a new version. */
  readonly skipped: () => number
  readonly waited: Promise<unknown>[]
}

/** Enough of a Response for a cache to hold and a test to recognise. */
interface FakeResponse {
  readonly body: string
  readonly ok: boolean
  readonly status: number
  readonly type: string
  clone(): FakeResponse
}

const response = (body: string, extra: Partial<FakeResponse> = {}): FakeResponse => {
  const made: FakeResponse = {
    body,
    ok: true,
    status: 200,
    type: 'basic',
    ...extra,
    clone: () => made,
  }
  return made
}

/** A CacheStorage that is a Map, keyed by URL. */
class FakeCaches {
  readonly stores = new Map<string, Map<string, FakeResponse>>()

  constructor(private readonly fetch: (request: { url: string }) => Promise<FakeResponse>) {}

  async open(name: string) {
    const store = this.stores.get(name) ?? new Map<string, FakeResponse>()
    this.stores.set(name, store)
    return {
      // `cache.add` fetches and stores; the worker uses it with a Request, so the key is its url.
      add: async (request: { url: string }) => {
        store.set(new URL(request.url, 'https://example.test').pathname, await this.fetch(request))
      },
      put: async (key: string | { url: string }, value: FakeResponse) => {
        const url = typeof key === 'string' ? key : key.url
        store.set(new URL(url, 'https://example.test').pathname, value)
      },
    }
  }

  async keys() {
    return [...this.stores.keys()]
  }

  async delete(name: string) {
    return this.stores.delete(name)
  }

  async match(key: string | { url: string }) {
    const url = typeof key === 'string' ? key : key.url
    const path = new URL(url, 'https://example.test').pathname
    for (const store of this.stores.values()) {
      const hit = store.get(path)
      if (hit !== undefined) return hit
    }
    return undefined
  }
}

/**
 * Loads `sw.js` with a stubbed environment.
 *
 * @param network what `fetch` should do, so a test can be offline by throwing
 */
function load(network: (request: { url: string }) => Promise<FakeResponse>): Harness {
  const listeners = new Map<string, Listener>()
  const requested: string[] = []
  const waited: Promise<unknown>[] = []
  let claimed = false
  let skipped = 0
  let responded: Promise<FakeResponse> | undefined

  const self = {
    location: { origin: 'https://example.test' },
    clients: {
      claim: async () => {
        claimed = true
      },
    },
    skipWaiting: () => {
      skipped += 1
    },
    addEventListener: (type: string, listener: Listener) => listeners.set(type, listener),
  }

  const fetchStub = async (request: { url: string } | string) => {
    const url = typeof request === 'string' ? request : request.url
    requested.push(new URL(url, 'https://example.test').pathname)
    return network(typeof request === 'string' ? { url } : request)
  }

  const fakeCaches = new FakeCaches(fetchStub)

  /**
   * `Request` as the worker uses it: constructed once, for the shell precache.
   *
   * It keeps the init options rather than only the url, because the one option passed —
   * `cache: 'reload'` — is load-bearing, and a fake that dropped it would make the test
   * asserting it vacuous.
   */
  class FakeRequest {
    readonly url: string
    readonly cache: string | undefined
    constructor(url: string, init: { cache?: string } = {}) {
      this.url = new URL(url, 'https://example.test').toString()
      this.cache = init.cache
    }
  }

  // The source being evaluated is this repository's own `public/sw.js`, read from disk a few
  // lines above — not input from anywhere. Evaluating it is the point: see the note at the top
  // for why a second, importable copy of this logic would be worse than none.
  const run = new Function('self', 'caches', 'fetch', 'Request', 'URL', source)
  run(self, fakeCaches, fetchStub, FakeRequest, URL)

  return {
    fire(type, event) {
      const listener = listeners.get(type)
      if (listener === undefined) throw new Error(`sw.js registered no ${type} listener`)
      responded = undefined
      listener({
        ...event,
        waitUntil: (promise: Promise<unknown>) => waited.push(promise),
        respondWith: (promise: Promise<FakeResponse>) => {
          responded = promise
        },
      })
    },
    caches: fakeCaches,
    requested,
    responded: async () => (responded === undefined ? undefined : await responded),
    claimed: () => claimed,
    skipped: () => skipped,
    waited,
  }
}

/** A request as the worker sees one. */
const request = (url: string, extra: Record<string, unknown> = {}) => ({
  url: new URL(url, 'https://example.test').toString(),
  method: 'GET',
  mode: 'no-cors',
  ...extra,
})

const navigation = (url = '/') => request(url, { mode: 'navigate' })

/** A network that answers everything. */
const online = async (target: { url: string }) => response(`fresh ${new URL(target.url).pathname}`)
/** A network that answers nothing, which is what offline is. */
const offline = async () => {
  throw new TypeError('Failed to fetch')
}

describe('installing', () => {
  it('precaches the shell, so the application opens with no connectivity', async () => {
    const sw = load(online)
    sw.fire('install', {})
    await Promise.all(sw.waited)

    expect(await sw.caches.match('/')).toBeDefined()
  })

  it('fetches the shell past the HTTP cache', async () => {
    // A new worker precaching a shell the HTTP cache is still holding from the previous deploy
    // would install itself around an old bundle on purpose. The deployment sends `no-cache`
    // for this document, and this makes the worker independent of that having been got right.
    const sw = load(async (target) => {
      expect((target as { cache?: string }).cache).toBe('reload')
      return response('shell')
    })
    sw.fire('install', {})
    await Promise.all(sw.waited)

    expect(sw.requested).toContain('/')
  })
})

describe('activating', () => {
  it('takes control of pages already open', async () => {
    // Without this the worker is active but governs nothing until the next navigation, so
    // someone who goes offline straight after their first visit gets nothing.
    const sw = load(online)
    sw.fire('activate', {})
    await Promise.all(sw.waited)

    expect(sw.claimed()).toBe(true)
  })

  it('deletes caches from an older version of these rules', async () => {
    const sw = load(online)
    sw.caches.stores.set('matter-manager-v0', new Map())
    sw.caches.stores.set('matter-manager-v1', new Map())

    sw.fire('activate', {})
    await Promise.all(sw.waited)

    expect(await sw.caches.keys()).toEqual(['matter-manager-v1'])
  })
})

describe('the shell', () => {
  it('comes from the network when there is one', async () => {
    // Network-first, and this is what keeps a returning visitor off yesterday's build:
    // cache-first here would serve old HTML naming an old bundle that is still validly
    // cached, so the application would be permanently correct and permanently out of date.
    const sw = load(online)

    sw.fire('fetch', { request: navigation() })

    expect((await sw.responded())?.body).toBe('fresh /')
  })

  it('prefers the network even when a cached shell is sitting right there', async () => {
    // The one that matters, and the one an empty-cache test cannot make. With a cached shell
    // present and the network up, cache-first would serve yesterday's HTML — which names
    // yesterday's fingerprinted bundle, still validly cached — so the application would be
    // permanently correct and permanently out of date, with no way for the user to notice.
    const sw = load(online)
    sw.caches.stores.set('matter-manager-v1', new Map([['/', response('yesterday')]]))

    sw.fire('fetch', { request: navigation() })

    expect((await sw.responded())?.body).toBe('fresh /')
  })

  it('comes from the cache when there is not', async () => {
    const sw = load(offline)
    sw.caches.stores.set('matter-manager-v1', new Map([['/', response('cached shell')]]))

    sw.fire('fetch', { request: navigation() })

    expect((await sw.responded())?.body).toBe('cached shell')
  })

  it('is answered from the cache for a deep route too', async () => {
    // Hash routing means every route is the same document, but a bookmarked path or a future
    // history-API route is still a navigation, and stranding it would be a blank page.
    const sw = load(offline)
    sw.caches.stores.set('matter-manager-v1', new Map([['/', response('cached shell')]]))

    sw.fire('fetch', { request: navigation('/devices/some-uuid') })

    expect((await sw.responded())?.body).toBe('cached shell')
  })

  it('is kept up to date by each successful navigation', async () => {
    const sw = load(online)

    sw.fire('fetch', { request: navigation() })
    await sw.responded()

    expect((await sw.caches.match('/'))?.body).toBe('fresh /')
  })

  it('fails as it would have failed, when there is neither network nor cache', async () => {
    // A first-ever visit while offline. There is nothing to serve, and inventing a response
    // would replace the browser's own offline page with a blank one of ours.
    const sw = load(offline)

    sw.fire('fetch', { request: navigation() })

    await expect(sw.responded()).rejects.toThrow()
  })
})

describe('fingerprinted assets', () => {
  it('are served from the cache without asking the network', async () => {
    const sw = load(online)
    sw.caches.stores.set(
      'matter-manager-v1',
      new Map([['/assets/index-abc.js', response('cached bundle')]]),
    )

    sw.fire('fetch', { request: request('/assets/index-abc.js') })

    expect((await sw.responded())?.body).toBe('cached bundle')
    expect(sw.requested).toEqual([])
  })

  it('are kept the first time they are fetched', async () => {
    const sw = load(online)

    sw.fire('fetch', { request: request('/assets/index-abc.js') })
    await sw.responded()

    expect((await sw.caches.match('/assets/index-abc.js'))?.body).toBe('fresh /assets/index-abc.js')
  })

  it('are not cached when the response is not a real success', async () => {
    // A 404 or a 500 stored under a fingerprinted URL is served forever: the URL can never be
    // reconsidered, because a changed file would have a different name.
    const sw = load(async () => response('not found', { ok: false, status: 404 }))

    sw.fire('fetch', { request: request('/assets/index-abc.js') })
    await sw.responded()

    expect(await sw.caches.match('/assets/index-abc.js')).toBeUndefined()
  })

  it('are not cached when the response is opaque', async () => {
    // An opaque response has no readable status - `ok` is false and `status` is 0 - so it may
    // be a failure wearing a success, permanently.
    const sw = load(async () => response('opaque', { ok: false, status: 0, type: 'opaque' }))

    sw.fire('fetch', { request: request('/assets/index-abc.js') })
    await sw.responded()

    expect(await sw.caches.match('/assets/index-abc.js')).toBeUndefined()
  })
})

describe('what the worker refuses to touch', () => {
  /** Not calling `respondWith` leaves the request exactly as it would have been. */
  const untouched = async (harness: Harness) => expect(await harness.responded()).toBeUndefined()

  it('leaves replication alone', async () => {
    // The clause that is not stylistic. A cached `_changes` response corrupts sync in a way
    // that is close to undiagnosable: the protocol reasons about stale sequence data and
    // concludes, correctly given what it was told, that it is up to date. The loss shows up
    // days later on a different device.
    const sw = load(online)

    sw.fire('fetch', { request: request('https://couch.example.com/project_x/_changes?since=42') })

    await untouched(sw)
  })

  it.each([
    ['_bulk_docs', 'https://couch.example.com/project_x/_bulk_docs'],
    ['_revs_diff', 'https://couch.example.com/project_x/_revs_diff'],
    ['a document read', 'https://couch.example.com/project_x/device:abc'],
  ])('leaves %s alone', async (_case, url) => {
    const sw = load(online)
    sw.fire('fetch', { request: request(url) })
    await untouched(sw)
  })

  it('leaves a cross-origin asset alone even when the path looks like ours', async () => {
    // A CDN, a font host, an image on someone else's origin. Without the origin check this
    // would be cached under our own cache name and served back for as long as it lived there —
    // and an opaque cross-origin response cannot even be inspected to see whether it worked.
    const sw = load(online)

    sw.fire('fetch', { request: request('https://cdn.example.com/assets/index-abc.js') })

    await untouched(sw)
  })

  it('leaves a navigation to the API alone', async () => {
    // Not a hypothetical: a link or an address bar pointed at an API URL is a navigation, and
    // without this rule it would be answered with the cached application shell. The user would
    // see the catalogue where they asked for data, and offline they would see it every time.
    const sw = load(online)

    sw.fire('fetch', { request: navigation('/api/projects') })

    await untouched(sw)
  })

  it('leaves the API alone even though it is same-origin', async () => {
    // M4 has not happened yet. The rule is written now so that the API cannot arrive into a
    // worker that was already caching it.
    const sw = load(online)

    sw.fire('fetch', { request: request('/api/projects') })

    await untouched(sw)
  })

  it.each([['POST'], ['PUT'], ['DELETE']])('leaves a %s alone', async (method) => {
    const sw = load(online)
    sw.fire('fetch', { request: request('/assets/index-abc.js', { method }) })
    await untouched(sw)
  })

  it('leaves anything it was not asked about alone', async () => {
    // Silence by default. A worker that caches whatever it sees caches things nobody thought
    // about, and the first anyone hears of it is a user who cannot get a fix.
    const sw = load(online)

    sw.fire('fetch', { request: request('/some/future/thing.json') })

    await untouched(sw)
  })
})

describe('stepping aside for a new version', () => {
  it('does so when the page asks', () => {
    const sw = load(online)

    sw.fire('message', { data: { type: 'matter-manager:skip-waiting' } })

    expect(sw.skipped()).toBe(1)
  })

  it('does not do so on install', () => {
    // The difference between an update the user took and one that happened to them. A worker
    // that skips waiting by itself replaces the code behind a page that is already running,
    // which is how a half-filled form meets a bundle that disagrees with it.
    const sw = load(online)

    sw.fire('install', {})

    expect(sw.skipped()).toBe(0)
  })

  it.each([
    ['a message with no data', undefined],
    ['a message that is not the one', { type: 'something-else' }],
    ['a bare string', 'skip-waiting'],
  ])('ignores %s', (_case, data) => {
    // A service worker receives messages from every client in its scope. "Any message means
    // activate" is an instruction from anything that can reach postMessage.
    const sw = load(online)

    sw.fire('message', { data })

    expect(sw.skipped()).toBe(0)
  })
})
