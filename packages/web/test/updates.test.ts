import { describe, expect, it } from 'vitest'
import { applyUpdate, checkForUpdate, SKIP_WAITING, watchForUpdate } from '../src/updates.js'

/**
 * A worker that can change state and be posted to.
 *
 * The situation this module exists for cannot be produced in a browser test: it needs two
 * builds, one of them already installed. So the collaborators are fakes, and the module was
 * written to take them as arguments rather than reach for them.
 */
function fakeWorker() {
  const listeners: Array<() => void> = []
  const posted: unknown[] = []
  return {
    state: 'installing' as ServiceWorker['state'],
    posted,
    addEventListener: (_type: string, listener: () => void) => listeners.push(listener),
    postMessage: (message: unknown) => posted.push(message),
    /** Moves to a state and tells whoever is listening, as the platform does. */
    become(state: ServiceWorker['state']) {
      this.state = state
      for (const listener of [...listeners]) listener()
    },
  }
}

function fakeRegistration(worker?: ReturnType<typeof fakeWorker>) {
  const listeners = new Map<string, Set<() => void>>()
  return {
    installing: null as unknown,
    waiting: (worker ?? null) as unknown,
    updates: 0,
    addEventListener: (type: string, listener: () => void) => {
      const set = listeners.get(type) ?? new Set()
      set.add(listener)
      listeners.set(type, set)
    },
    removeEventListener: (type: string, listener: () => void) => {
      listeners.get(type)?.delete(listener)
    },
    update: async function update(this: { updates: number }) {
      this.updates += 1
    },
    /** Fires `updatefound` the way the platform does, after setting `installing`. */
    findUpdate(installing: ReturnType<typeof fakeWorker>) {
      this.installing = installing
      for (const listener of listeners.get('updatefound') ?? []) listener()
    },
  }
}

function fakeContainer() {
  const listeners = new Set<() => void>()
  return {
    addEventListener: (_type: string, listener: () => void) => listeners.add(listener),
    /** The new worker takes control. */
    changeController() {
      for (const listener of [...listeners]) listener()
    },
    listenerCount: () => listeners.size,
  }
}

const watch = (
  registration: ReturnType<typeof fakeRegistration>,
  controlled: boolean,
  onReady: (worker: ServiceWorker) => void,
) => watchForUpdate(registration as unknown as ServiceWorkerRegistration, controlled, onReady)

describe('noticing a new version', () => {
  it('reports one that installed while the page was open', async () => {
    const registration = fakeRegistration()
    let ready: ServiceWorker | undefined
    watch(registration, true, (worker) => {
      ready = worker
    })

    const installing = fakeWorker()
    registration.findUpdate(installing)
    installing.become('installed')

    expect(ready).toBe(installing as unknown as ServiceWorker)
  })

  it('reports one that has been waiting since a previous visit', async () => {
    // The case that otherwise never fires. An update installed yesterday is sitting in
    // `waiting` right now; without this the user is told only if a *further* version arrives
    // while they happen to be watching.
    const waiting = fakeWorker()
    const registration = fakeRegistration(waiting)
    let ready: ServiceWorker | undefined

    watch(registration, true, (worker) => {
      ready = worker
    })

    expect(ready).toBe(waiting as unknown as ServiceWorker)
  })

  it('says nothing on a first-ever install', async () => {
    // A worker reaches `installed` on a first visit too. Announcing "a new version is
    // available" to someone who has just arrived is an application talking about itself.
    const waiting = fakeWorker()
    const registration = fakeRegistration(waiting)
    let told = 0

    watch(registration, false, () => {
      told += 1
    })
    registration.findUpdate(fakeWorker())

    expect(told).toBe(0)
  })

  it('says nothing while the new worker is still installing', async () => {
    const registration = fakeRegistration()
    let told = 0
    watch(registration, true, () => {
      told += 1
    })

    const installing = fakeWorker()
    registration.findUpdate(installing)
    installing.become('installing')

    expect(told).toBe(0)
  })

  it('tells the user once, not once per state change', async () => {
    const registration = fakeRegistration()
    let told = 0
    watch(registration, true, () => {
      told += 1
    })

    const installing = fakeWorker()
    registration.findUpdate(installing)
    installing.become('installed')
    installing.become('installed')
    installing.become('activated')

    expect(told).toBe(1)
  })

  it('stops watching when asked', async () => {
    const registration = fakeRegistration()
    let told = 0
    const stop = watch(registration, true, () => {
      told += 1
    })

    stop()
    const installing = fakeWorker()
    registration.findUpdate(installing)
    installing.become('installed')

    expect(told).toBe(0)
  })
})

describe('taking the update', () => {
  const apply = (
    worker: ReturnType<typeof fakeWorker>,
    container: ReturnType<typeof fakeContainer>,
    reload: () => void,
    timeout: (run: () => void, ms: number) => unknown = () => 0,
  ) =>
    applyUpdate(
      worker as unknown as ServiceWorker,
      container as unknown as ServiceWorkerContainer,
      reload,
      timeout,
    )

  it('asks the waiting worker to take over', () => {
    const worker = fakeWorker()
    apply(worker, fakeContainer(), () => {})

    expect(worker.posted).toEqual([{ type: SKIP_WAITING }])
  })

  it('reloads once the new worker is in charge, and not before', () => {
    // Reloading immediately is a race the old worker usually wins, producing a reload that
    // changes nothing and a button that looks broken.
    const container = fakeContainer()
    let reloads = 0
    apply(fakeWorker(), container, () => {
      reloads += 1
    })

    expect(reloads).toBe(0)
    container.changeController()
    expect(reloads).toBe(1)
  })

  it('reloads anyway if the new worker never answers', () => {
    // "Never stuck on an old bundle with no way forward." If the message is lost or the worker
    // is discarded, a plain reload still gets the new version — the shell is fetched
    // network-first. A button that did nothing would be the only way forward, which is worse
    // than no button.
    let fallback: (() => void) | undefined
    let reloads = 0
    apply(
      fakeWorker(),
      fakeContainer(),
      () => {
        reloads += 1
      },
      (run) => {
        fallback = run
      },
    )

    expect(reloads).toBe(0)
    fallback?.()
    expect(reloads).toBe(1)
  })

  it('reloads exactly once, however many ways it is told to', () => {
    // A reload loop is a worse failure than the one being fixed: the application becomes
    // unusable rather than merely out of date.
    const container = fakeContainer()
    let fallback: (() => void) | undefined
    let reloads = 0
    apply(
      fakeWorker(),
      container,
      () => {
        reloads += 1
      },
      (run) => {
        fallback = run
      },
    )

    container.changeController()
    container.changeController()
    fallback?.()

    expect(reloads).toBe(1)
  })
})

describe('checking for a new version', () => {
  it('asks the browser to look', async () => {
    const registration = fakeRegistration()
    await checkForUpdate(registration as unknown as ServiceWorkerRegistration)
    expect(registration.updates).toBe(1)
  })

  it('is quiet when the check fails, which usually means offline', async () => {
    // Nothing to tell the user: they are running the version they have, which is correct.
    const registration = {
      update: async () => {
        throw new TypeError('Failed to fetch')
      },
    }

    await expect(
      checkForUpdate(registration as unknown as ServiceWorkerRegistration),
    ).resolves.toBeUndefined()
  })
})
