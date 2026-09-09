/**
 * The pure domain: authorisation, membership, invitations and ownership transfer.
 *
 * No I/O, no network, no database. Everything here is a function of its arguments, which is
 * why it is also where almost all the logic that can be *wrong* lives — and why it tests in
 * milliseconds with no fixtures. Code that needs CouchDB or a Fastify request belongs in the
 * sibling directories, which are free to import this; this must never import them.
 *
 * Previously `@matter-manager/core`, shared with the browser. It was not actually shared: the
 * browser imported none of these symbols and this imported none of the browser's. See
 * `docs/adr/0004-typescript-backend-openapi-contract.md`.
 *
 * A barrel rather than an explicit export list, because there is exactly one consumer — this
 * package — and `tsc` proves every name resolves. The explicit list core kept existed because
 * three packages consumed it across a build boundary, and nothing typechecked the entry point
 * itself.
 *
 * @module
 */

export * from './can.js'
export * from './invitation.js'
export * from './membership.js'
export * from './ownership.js'
export * from './transfer.js'
