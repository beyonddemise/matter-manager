/**
 * The HTTP service.
 *
 * `buildServer` returns an unlistening Fastify instance, which is what makes every route
 * testable through `.inject()` — no port, no teardown, no waiting for a socket. `main.ts` is
 * the only thing that listens.
 *
 * **Routes are typed from `openapi/matter-manager.yaml`** (ADR 0015): `src/generated/openapi.ts`
 * is produced from the contract by `openapi-typescript`, and a handler that returns a shape the
 * contract does not declare is a compile error. What a compiler cannot check — that the routes
 * registered here are exactly the operations the contract describes — is M4-2's CI check, and
 * ADR 0015 is explicit that it is the other half of this decision rather than optional.
 *
 * @module
 */

import Fastify, { type FastifyInstance } from 'fastify'
import { type AuthDependencies, registerAuthRoutes } from './auth/routes.js'
import type { paths } from './generated/openapi.js'
import { redactionOptions } from './logging.js'
import { type ProfileDependencies, registerProfileRoutes } from './profile/routes.js'
import { type ProjectDependencies, registerProjectRoutes } from './projects/routes.js'
import { registerSecurity, type SecurityOptions } from './security/register.js'

/** The response body for an operation, straight from the contract. */
type Response<
  P extends keyof paths,
  M extends keyof paths[P],
  S extends number,
> = paths[P][M] extends {
  responses: Record<S, { content: { 'application/json': infer Body } }>
}
  ? Body
  : never

/** How much the service says, and where. */
export interface ServerOptions {
  /** `false` in tests, so a suite does not print a request log per case. */
  readonly logger?: boolean
  /**
   * Everything sign-in needs.
   *
   * Optional, and that is not laziness: without a Google client id there is no sign-in to
   * offer, and a service that registered the routes anyway would answer them with a
   * misconfiguration error at the moment a user pressed the button. Absent means absent — and
   * the contract-drift check treats the routes as unimplemented, which is true.
   */
  readonly auth?: AuthDependencies
  /**
   * The profile store, when there is one.
   *
   * Separate from `auth` because they need different things — sign-in needs a provider, the
   * profile needs CouchDB — and a deployment can have one configured and not the other while it
   * is being brought up.
   */
  readonly profile?: ProfileDependencies
  /**
   * Project provisioning and listing.
   *
   * Separate from `profile` for the same reason `profile` is separate from `auth`: they need
   * different things, and a deployment can have one configured and not the other while it is
   * being brought up. Absent means the routes are absent, which the contract-drift check reads
   * as unimplemented — which is true.
   */
  readonly projects?: ProjectDependencies
  /**
   * Rate limits, cross-origin access and the headers on every response.
   *
   * Not optional in effect: the headers and the limits apply whether or not this is given. What
   * it configures is which origins may make a cross-origin request, and the answer when nobody
   * says is **none** — a deployment that forgot should refuse the application rather than admit
   * the internet.
   */
  readonly security?: SecurityOptions
  /**
   * Whether `X-Forwarded-*` may be believed.
   *
   * Defaults to `TRUST_PROXY=true` in the environment. An option as well as a variable because
   * it decides two things worth testing directly — which address the rate limiter counts, and
   * whether a connection is treated as encrypted — and a test that had to set an environment
   * variable to reach them would be a test that leaked into the next one.
   */
  readonly trustProxy?: boolean
}

/**
 * Builds the service.
 *
 * Does not listen. See the module note.
 */
/** One route as Fastify registered it. Used by the contract-drift check. */
export interface RegisteredRoute {
  readonly method: string
  readonly url: string
}

/** A server that can say what it registered. */
export type Server = FastifyInstance & { readonly registeredRoutes: () => RegisteredRoute[] }

/**
 * Creates an unlistening HTTP server with configured security, health, and optional service routes.
 *
 * @param options - Server configuration and optional route dependencies
 * @returns The configured server instance
 */
export function buildServer(options: ServerOptions = {}): Server {
  const app = Fastify({
    logger:
      options.logger === false
        ? false
        : {
            // Structured, and redacting from the first commit rather than after an incident —
            // see `logging.ts` for what is on the list and why the Matter fields are on it.
            ...redactionOptions(),
            // A request id per line, so a report of "it failed" can be traced to the request
            // that failed rather than to the minute it happened in.
            level: process.env.LOG_LEVEL ?? 'info',
          },
    // Fastify's default is to trust no proxy. Behind one, that makes every client address the
    // proxy's — and the rate limiter would then see every request as coming from one client, so
    // the first twenty sign-in attempts from anywhere would lock out everybody else.
    //
    // The other way round is worse: believing `X-Forwarded-For` from a client that is *not*
    // behind a trusted proxy lets anyone claim any address, which turns the limit off. Hence a
    // deployment has to say so, and the default is to trust nothing.
    trustProxy: options.trustProxy ?? process.env.TRUST_PROXY === 'true',
    // A body larger than this is not a request this service has: its largest legitimate body
    // is a membership list. The default is a megabyte, which is a megabyte of parsing offered
    // to anyone who asks.
    bodyLimit: 64 * 1024,
  })

  /**
   * What was registered, for the contract-drift check (#39).
   *
   * Collected through `onRoute` rather than parsed out of `printRoutes()`. The printed tree is
   * for humans and its shape is not a contract — a check built on it would be a check that
   * breaks when Fastify changes its box-drawing characters, and worse, one that could silently
   * stop matching anything and report no drift at all.
   *
   * The hook is added before any route, which is the only reason it sees them.
   */
  const routes: RegisteredRoute[] = []
  app.addHook('onRoute', (route) => {
    const methods = Array.isArray(route.method) ? route.method : [route.method]
    // Fastify registers a HEAD alongside every GET by default. It is not an operation anyone
    // wrote, and a contract that had to declare one for every GET would be a contract
    // describing Fastify rather than this service.
    for (const method of methods) {
      if (method !== 'HEAD') routes.push({ method, url: route.url })
    }
  })

  // Before any route, so that every response carries the headers and no endpoint can be added
  // outside the limits by being registered first.
  registerSecurity(app, options.security ?? {})

  /**
   * Liveness.
   *
   * Deliberately says nothing but `ok`. A health endpoint that reports version, uptime or
   * dependency status is an unauthenticated endpoint that describes the deployment, and this
   * one is reachable by anyone. It also does **not** check CouchDB: liveness answers "should
   * this process be restarted", and a restart does not fix a database that is down — it turns
   * a degraded service into no service.
   */
  app.get('/healthz', async (): Promise<Response<'/healthz', 'get', 200>> => {
    return { status: 'ok' }
  })

  if (options.auth !== undefined) registerAuthRoutes(app, options.auth)
  if (options.profile !== undefined) registerProfileRoutes(app, options.profile)
  if (options.projects !== undefined) registerProjectRoutes(app, options.projects)

  return Object.assign(app, { registeredRoutes: () => [...routes] })
}
