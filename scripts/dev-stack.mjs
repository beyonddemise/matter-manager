#!/usr/bin/env node
/**
 * Brings up everything the application needs, in one command.
 *
 *   npm run dev:stack
 *
 * CouchDB in a container, the API on this machine, and Vite in front of both. Until now the
 * three were started by hand from three different places, and the credentials that tie them
 * together were pasted out of `.env.example` - which is a setup that works for whoever wrote it
 * and for nobody else.
 *
 * **The API runs on the host rather than in its image.** `packages/api/Dockerfile` exists and is
 * what production runs; using it here would mean rebuilding an image on every edit. CouchDB is
 * containerised because its *configuration* is what has to match production, and that is baked
 * into the image - replication and `validate_doc_update` behaviour differ between minor
 * versions, and those are the behaviours this project depends on most.
 *
 * **Keys are generated, not documented.** A README that says "run openssl" is a step people skip
 * and then debug. Two EC P-256 keys are written into `.env` on first run and left alone
 * afterwards. They are development keys for a database bound to loopback with a password
 * published in this repository; they are not secrets.
 *
 * Google sign-in is **not** configured, and cannot be from here: it needs a client somebody
 * creates in a console. Without it the API serves no `/auth` routes, which is deliberate - see
 * `packages/api/src/composition.ts`. Everything else works.
 */

import { spawn, spawnSync } from 'node:child_process'
import { generateKeyPairSync } from 'node:crypto'
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const envFile = join(root, '.env')
const compose = join(root, '.devcontainer/docker-compose.yml')

/** 5985 rather than CouchDB's default, so this cannot collide with another instance. */
const COUCHDB = 'http://localhost:5985'
const API_PORT = 3000
const WEB_PORT = 5173

const run = (command, args, options = {}) =>
  spawnSync(command, args, { cwd: root, stdio: 'inherit', ...options })

const step = (message) => console.log(`\n== ${message} ==`)

// --- CouchDB ------------------------------------------------------------------------------
step('CouchDB')
if (run('docker', ['info'], { stdio: 'ignore' }).status !== 0) {
  console.error('Docker is not running. Start it and try again - CouchDB runs in a container so')
  console.error('that its configuration matches production, which is where sync bugs come from.')
  process.exit(1)
}
if (run('docker', ['compose', '-f', compose, 'up', '-d', 'couchdb']).status !== 0) process.exit(1)

process.stdout.write('  waiting for it to answer')
let up = false
for (let attempt = 0; attempt < 60; attempt++) {
  if (spawnSync('curl', ['-fsS', `${COUCHDB}/_up`], { stdio: 'ignore' }).status === 0) {
    up = true
    break
  }
  process.stdout.write('.')
  // Synchronous on purpose: nothing may start until this answers, and a busy wait of a few
  // hundred milliseconds in a development script does not need an event loop.
  spawnSync('sleep', ['1'])
}
console.log(up ? ' up' : '')
if (!up) {
  console.error('CouchDB never became available. `docker compose logs couchdb` will say why.')
  process.exit(1)
}

// The system databases. CouchDB reports itself up without them and then fails the first write
// that touches `_users`, which reads as an application bug rather than a missing setup step.
for (const database of ['_users', '_replicator']) {
  spawnSync('curl', ['-fsS', '-u', 'admin:devonly', '-X', 'PUT', `${COUCHDB}/${database}`], {
    stdio: 'ignore',
  })
}

// --- Configuration --------------------------------------------------------------------------
step('Configuration')

/** A PEM-encoded EC P-256 private key, which is what ES256 signing needs. */
const newKey = () =>
  generateKeyPairSync('ec', { namedCurve: 'prime256v1' })
    .privateKey.export({ type: 'pkcs8', format: 'pem' })
    .trimEnd()

if (!existsSync(envFile)) {
  writeFileSync(
    envFile,
    `# Written by scripts/dev-stack.mjs on first run. Safe to edit; safe to delete.
#
# Development values for a CouchDB bound to loopback with a password published in this
# repository. They are not secrets. .env is gitignored all the same, because the day one of
# these files holds something real should not be the day the habit starts.
COUCHDB_URL=${COUCHDB}
COUCHDB_ADMIN_USER=admin
COUCHDB_ADMIN_PASSWORD=devonly
PORT=${API_PORT}
HOST=127.0.0.1
LOG_LEVEL=info
APP_ORIGIN=http://localhost:${WEB_PORT}
TRUST_PROXY=false

# Where the Vite proxy forwards /api and /db. Production has no equivalent: Pages Functions
# serve both paths from the application's own origin, so nothing there needs a hostname.
DEV_API_TARGET=http://localhost:${API_PORT}
DEV_COUCHDB_TARGET=${COUCHDB}

# ES256 on EC P-256, and two different keys. CouchDB is given the public half of the first, so
# anything signed with it is a database credential - which is why the session cookie gets its
# own. See .env.example for the full reasoning.
JWT_KEY_ID=dev
JWT_PRIVATE_KEY="${newKey()}"
JWT_SESSION_PRIVATE_KEY="${newKey()}"

# Google sign-in needs a client created in a console, so it is not filled in here. Without all
# three the API serves no /auth routes at all, deliberately. See docs/GOOGLE-SIGN-IN.md.
GOOGLE_CLIENT_ID=
GOOGLE_CLIENT_SECRET=
GOOGLE_REDIRECT_URI=http://localhost:${API_PORT}/auth/google/callback
`,
  )
  console.log('  wrote .env, with freshly generated development keys')
} else {
  // An .env written before this script existed has the CouchDB settings and not the proxy
  // targets. Appending what is missing beats failing, and beats overwriting what is there.
  const existing = readFileSync(envFile, 'utf8')
  const missing = ['DEV_API_TARGET', 'DEV_COUCHDB_TARGET'].filter(
    (name) => !existing.includes(`${name}=`),
  )
  if (missing.length > 0) {
    // Only what is actually absent. Writing both would append a second `DEV_API_TARGET` to a
    // file that already had a custom one, and `loadEnv` takes the later of two - so the helpful
    // top-up would quietly point the proxy back at the default.
    const targets = {
      DEV_API_TARGET: `http://localhost:${API_PORT}`,
      DEV_COUCHDB_TARGET: COUCHDB,
    }
    appendFileSync(
      envFile,
      `\n# Added by scripts/dev-stack.mjs: where the Vite proxy forwards /api and /db.\n` +
        `${missing.map((name) => `${name}=${targets[name]}`).join('\n')}\n`,
    )
    console.log(`  added ${missing.join(' and ')} to .env`)
  } else {
    console.log('  .env already present, left alone')
  }
}

// --- Build, then run ------------------------------------------------------------------------
step('Building the workspace')
// The API runs its emitted JavaScript and Vite resolves core and data through their emitted
// declarations, so this has to happen first. Without it the first run of either fails in a way
// that reads like a missing dependency rather than a missing build step.
if (run('npm', ['run', 'typecheck']).status !== 0) process.exit(1)

step('Running')
console.log(`  API    http://localhost:${API_PORT}`)
console.log(`  Web    http://localhost:${WEB_PORT}   (/api and /db are proxied there)`)
console.log(`  Couch  ${COUCHDB}`)
console.log('  Ctrl-C stops the API and the web server; CouchDB keeps your data and keeps')
console.log('  running. `npm run dev:stack:down` stops it too.\n')

const children = [
  spawn('node', ['--watch', '--env-file=.env', 'packages/api/dist/src/main.js'], {
    cwd: root,
    stdio: 'inherit',
  }),
  spawn('npm', ['--workspace', '@matter-manager/web', 'run', 'dev'], {
    cwd: root,
    stdio: 'inherit',
  }),
]

/** Stops both children exactly once, whatever ended the session. */
let stopping = false
const stop = () => {
  if (stopping) return
  stopping = true
  for (const child of children) child.kill('SIGTERM')
}

for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, stop)
// If either half dies the other is useless, and leaving it running hides which one failed.
//
// The exit code is carried out with it. Without this the parent exits 0 after an API that never
// started, so `npm run dev:stack` reports success for a stack that is not running - and the one
// place that gets read is a script or a CI job, which is exactly where nobody is watching the
// logs. The first failure wins; a child killed by our own SIGTERM reports a null code and so
// leaves this alone, which is what makes an ordinary Ctrl-C still exit 0.
for (const child of children) {
  child.on('exit', (code) => {
    if (code && process.exitCode === undefined) process.exitCode = code
    stop()
  })
}
