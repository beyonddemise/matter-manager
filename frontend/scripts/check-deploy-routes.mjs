#!/usr/bin/env node
/**
 * Guards the file that decides whether the forwarders run at all.
 *
 * `_routes.json` tells Cloudflare which paths invoke a Pages Function. Everything it does not
 * include is served from the CDN as a static asset - and a single-page application serves the
 * app shell for any path it does not recognise. So a `/api/*` missing from `include` does not
 * produce a 404. It produces **200, with `<!doctype html>`**, which is what
 * `https://matter-manager-app.pages.dev/api/healthz` answered on 2026-09-28 and the reason
 * this directory exists.
 *
 * That is the whole argument for a checker rather than a comment: every other way of noticing
 * requires somebody to look at a response body that has a 200 next to it.
 *
 * Usage:  node scripts/check-deploy-routes.mjs [--scan <directory>]
 *
 * `--scan` points at a directory containing a `_routes.json`, so the checker can be exercised
 * over fixtures. Without it, the real one under `public`. Same argument as
 * `check-deploy-headers.mjs`, deliberately - two checkers with two ways to be pointed
 * somewhere is one more thing to remember.
 */

import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')

const scanIndex = process.argv.indexOf('--scan')
const directory = scanIndex === -1 ? join(root, 'public') : process.argv[scanIndex + 1]

if (directory === undefined) {
  console.error('--scan needs a directory.')
  process.exit(1)
}

/**
 * Every prefix that must reach a Function, and the directory that serves it.
 *
 * The two halves are checked against each other: a route file with no `include` is dead code,
 * and an `include` with no route file invokes a Function that does not exist. Both are silent.
 */
const FORWARDED = [
  { prefix: '/api', route: 'functions/api/[[path]].ts', why: 'sign-in and every API call' },
  { prefix: '/db', route: 'functions/db/[[path]].ts', why: 'replication' },
]

const problems = []
const file = join(directory, '_routes.json')

if (!existsSync(file)) {
  // Not "nothing to check". Without this file wrangler generates one from the functions tree,
  // which is usually right and is not what was reviewed - and if the functions tree is also
  // missing, the deployment is static assets alone with nothing anywhere turning red.
  console.error(`No _routes.json in ${directory}. Nothing pins which paths invoke a Function.`)
  process.exit(1)
}

let routes
try {
  routes = JSON.parse(readFileSync(file, 'utf8'))
} catch (error) {
  console.error(`${file} is not valid JSON: ${error.message}`)
  process.exit(1)
}

// Cloudflare rejects anything else, and rejects it at deploy time - which is the good case.
// Checked here so the message names the file rather than arriving as an API error.
if (routes.version !== 1) {
  problems.push({
    where: '_routes.json',
    what: `version is ${JSON.stringify(routes.version)}, and Cloudflare accepts only 1`,
    detail: 'The deploy would be rejected.',
  })
}

const include = Array.isArray(routes.include) ? routes.include : []
const exclude = Array.isArray(routes.exclude) ? routes.exclude : []

if (!Array.isArray(routes.include)) {
  problems.push({
    where: '_routes.json',
    what: 'include is not an array',
    detail:
      'With nothing included, no request invokes a Function and every path serves the app shell.',
  })
}

/** Whether a Cloudflare route pattern covers everything beneath a prefix. */
function covers(pattern, prefix) {
  return pattern === '/*' || pattern === `${prefix}/*` || pattern === `${prefix}*`
}

for (const { prefix, route, why } of FORWARDED) {
  if (!include.some((pattern) => covers(pattern, prefix))) {
    problems.push({
      where: prefix,
      what: 'no include pattern covers it',
      detail:
        `${why} would be served by the CDN instead of by ${route}, and the single-page ` +
        'fallback answers 200 with the app shell rather than 404. Nothing about the ' +
        'deployment looks wrong.',
    })
  }

  // Cloudflare evaluates `exclude` first, so an entry here silently wins over `include`.
  if (exclude.some((pattern) => covers(pattern, prefix))) {
    problems.push({
      where: prefix,
      what: 'an exclude pattern covers it',
      detail: `exclude is evaluated before include, so ${route} would never run.`,
    })
  }

  // Only for the real tree: a fixture directory has no functions/ beside it.
  if (scanIndex === -1 && !existsSync(join(root, route))) {
    problems.push({
      where: route,
      what: 'is included in _routes.json but does not exist',
      detail: 'The path would invoke a Function that was never written, and fall through.',
    })
  }
}

if (problems.length === 0) {
  console.log('deploy routes: ok (/api and /db reach their Functions, nothing excludes them)')
  process.exit(0)
}

console.error(`${file} would deploy an application whose forwarders never run:\n`)
for (const problem of problems) {
  console.error(`  ${problem.where}: ${problem.what}`)
  console.error(`    ${problem.detail}\n`)
}
console.error('See docs/superpowers/specs/2026-09-29-pages-functions-proxy-design.md.')
process.exit(1)
