import { describe, expect, it } from 'vitest'
import { registerServiceWorker, SERVICE_WORKER_URL } from '../src/register-sw.js'

/** A `navigator.serviceWorker` that records what it was asked to register. */
function container(register: ServiceWorkerContainer['register']) {
  return { register } as unknown as ServiceWorkerContainer
}

const registration = {} as ServiceWorkerRegistration

describe('registering the service worker', () => {
  it('registers the worker at the root scope', async () => {
    // Root scope, not the default. The default is the directory the script is served from,
    // which here is also the root — so this would pass either way today and would stop being
    // true the moment the worker moved. Written down so it cannot move by accident.
    let asked: [string, RegistrationOptions | undefined] | undefined
    await registerServiceWorker(
      container(async (url, options) => {
        asked = [String(url), options]
        return registration
      }),
    )

    expect(asked?.[0]).toBe(SERVICE_WORKER_URL)
    expect(asked?.[1]?.scope).toBe('/')
  })

  it('hands back the registration, which M2b-4 will need', async () => {
    const result = await registerServiceWorker(container(async () => registration))
    expect(result).toBe(registration)
  })

  it('does nothing where service workers do not exist', async () => {
    // Firefox private windows, an insecure origin, an older browser. The API is absent rather
    // than failing when used, so this is the shape the check has to take.
    expect(await registerServiceWorker(undefined)).toBeUndefined()
  })

  it('carries on when registration is refused', async () => {
    // The application works exactly as it did before, minus the offline case. Throwing here
    // would take down a page over a feature the user did not ask for.
    const result = await registerServiceWorker(
      container(async () => {
        throw new DOMException('blocked', 'SecurityError')
      }),
    )

    expect(result).toBeUndefined()
  })
})
