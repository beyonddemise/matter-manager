/**
 * How this service refuses.
 *
 * Every refusal in `openapi.yaml` is declared `application/problem+json`, because that is the
 * media type RFC 9457 problem details are served as. The handlers were sending them as
 * `application/json` — the contract said one thing and every handler did another, on every
 * 400, 401, 403, 404 and 500 in the service.
 *
 * That was cosmetic for as long as nothing read it. It stopped being cosmetic when `reason`
 * became the field the projects page branches on to tell a capacity refusal from a permission
 * one: a client that selects a parser by media type, or a proxy that decides what to buffer by
 * it, is now making a decision about a body whose type it has been told wrongly. And the
 * drift check validates these responses now, so the contract and the handlers have to agree.
 *
 * A helper rather than a `.type(...)` at every call site, and that is the whole point: there
 * are roughly thirty refusals across three route modules, and a header repeated thirty times
 * is a header that is missing from the thirty-first. Nothing enforces it — a forgotten
 * `.type()` produces a working response with the wrong label, which no test notices unless it
 * is looking — so the way to keep it right is for there to be one place it is written.
 *
 * @module
 */

import type { FastifyReply } from 'fastify'

/** RFC 9457. Not `application/json`; see the module note. */
export const PROBLEM_JSON = 'application/problem+json'

/**
 * An RFC 9457 problem detail, as the contract's `Problem` schema describes it.
 *
 * `status` is required here because {@link problem} takes the HTTP status *from the body*. See
 * there for why.
 */
export interface Problem {
  readonly title: string
  readonly status: number
  /** A stable name for *which* refusal this is, for a client that must branch on it. */
  readonly reason?: string
  readonly detail?: string
  readonly type?: string
}

/**
 * Answers a refusal, with the status code and the media type the contract declares.
 *
 * The status comes from the body rather than from a separate argument, so the header and the
 * `status` field cannot disagree. They could before — `reply.code(403).send({ status: 400 })`
 * compiles, and a client reading the body would then be told something different from a client
 * reading the status line. One value, written once.
 *
 * @param reply - The reply to answer on.
 * @param body - The problem detail, whose `status` becomes the HTTP status.
 */
export function problem(reply: FastifyReply, body: Problem): FastifyReply {
  return reply.code(body.status).type(PROBLEM_JSON).send(body)
}
