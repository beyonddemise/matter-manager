#!/usr/bin/env node
/**
 * The entry point: the only place that listens on a port.
 *
 * Everything else is in `server.ts`, which returns an instance that never binds — so the whole
 * route surface is testable through `.inject()` and this file stays small enough that nothing
 * hides in it.
 *
 * @module
 */

import { serverOptions } from './composition.js'
import { buildServer } from './server.js'

const port = Number(process.env.PORT ?? 3000)
// `0.0.0.0` rather than the default `localhost`: in a container, binding to loopback means the
// service is unreachable from outside it, which presents as a health check that never passes
// and a process that looks perfectly healthy from inside.
const host = process.env.HOST ?? '0.0.0.0'

// Everything that can be wrong with the configuration is discovered here, before anything
// listens — a bad origin, a signing key that is not an EC key, missing design documents. That
// is the point: the alternative is a service that starts, looks healthy, and fails at the
// moment somebody presses a button, which reads as a broken application rather than an
// incomplete deployment. See `composition.ts`.
const app = buildServer(serverOptions(process.env))

/**
 * Stops accepting connections, finishes what is in flight, and exits.
 *
 * Without this a deploy kills the process mid-request. For this service that is not a dropped
 * page — it is a half-finished project provisioning, where the database exists and its
 * `_security` does not.
 */
async function shutdown(signal: string): Promise<void> {
  app.log.info({ signal }, 'shutting down')
  try {
    await app.close()
    process.exit(0)
  } catch (error) {
    app.log.error({ err: error }, 'shutdown failed')
    process.exit(1)
  }
}

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => void shutdown(signal))
}

try {
  await app.listen({ port, host })
} catch (error) {
  app.log.error({ err: error }, 'failed to start')
  process.exit(1)
}
