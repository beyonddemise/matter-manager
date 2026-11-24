#!/usr/bin/env node
/**
 * Measures what a hostile SVG can do when this application renders it, five ways, once under
 * the Content-Security-Policy the deployment serves and once with no policy at all.
 *
 * The control run is the point. The render modes are protected by different things: `<img>` by
 * a rule the browser enforces whatever the policy says, inline SVG by the policy alone, and
 * inline SVG after `sanitisePlan` (the way #143 renders a layout) by the sanitiser alone. Only
 * running each with and without the policy tells them apart.
 *
 * **Two proofs, each independent of the other** (spec 2026-11-24 "SVG layouts", *CSP and
 * probes*; ADR 0023):
 *
 * - **The policy's proof.** Under the deployed policy, no mode runs anything or reaches the
 *   second origin. This holds even for unsanitised inline SVG.
 * - **The sanitiser's proof.** With no policy at all, the sanitised mode runs nothing and
 *   reaches nothing. The policy is a file someone will edit one day; this row is what still
 *   holds when they do.
 *
 * Each proof is only worth something if the probe could have seen the opposite, so the control
 * run must also show unsanitised inline SVG **executing** and **reaching the second origin**,
 * and the sanitised mode must actually have rendered the plan. Silence from a probe that cannot
 * observe anything, or from a mode that rendered nothing, would prove nothing.
 *
 * The hostile SVG points at a **second local origin** rather than at an unresolvable host, and
 * that origin reports what it was actually asked for. An unreachable host fails DNS whether or
 * not anything blocked it, so "the request failed" would pass for the wrong reason. A different
 * port on 127.0.0.1 is a different origin as far as the policy is concerned, and it answers.
 *
 * `--bypass-sanitiser` is the probe's own self-test: the sanitised mode then renders the raw
 * input the same way, and the run must fail. Nothing calls it in CI; it is how the gate was
 * shown to be able to fail, and how anyone can show it again.
 *
 * Usage:  node scripts/probe-svg-rendering.mjs [--bypass-sanitiser]
 */
import { readFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'
import { build } from 'vite'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const bypass = process.argv.includes('--bypass-sanitiser')

const policy = (() => {
  const headers = readFileSync(join(root, 'public/_headers'), 'utf8')
  const line = headers.split('\n').find((l) => l.trim().startsWith('Content-Security-Policy:'))
  if (line === undefined) throw new Error('No Content-Security-Policy in public/_headers')
  return line.slice(line.indexOf(':') + 1).trim()
})()

/**
 * The application's own sanitiser, bundled for the probe page.
 *
 * Built from `src/ui/layouts/sanitise.ts` with the application's own bundler and its pinned
 * DOMPurify, rather than reimplemented here, so this row measures the code that ships and goes
 * red the day that code changes for the worse.
 */
const sanitiserBundle = await (async () => {
  const result = await build({
    configFile: false,
    root,
    logLevel: 'silent',
    build: {
      write: false,
      minify: false,
      lib: {
        entry: join(root, 'src/ui/layouts/sanitise.ts'),
        formats: ['iife'],
        name: 'PlanSanitiser',
      },
    },
  })
  const output = (Array.isArray(result) ? result[0] : result).output
  const chunk = output.find((file) => file.type === 'chunk')
  if (chunk === undefined) throw new Error('Building the sanitiser produced no script')
  return chunk.code
})()

const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
)

/**
 * Every trick #143 names, each flagging a distinct name if it runs, or requesting a distinct
 * path from the second origin if it fetches.
 */
const hostileSvg = (elsewhere) =>
  `<?xml-stylesheet href="${elsewhere}/stylesheet-pi.css"?>
<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="200" height="200"
     style="background-image: url(${elsewhere}/style-attribute.png)">
  <script>window.top.__fired.push('inline &lt;script&gt;')</script>
  <rect id="plan-shape" width="200" height="200" fill="#eee" onload="window.top.__fired.push('onload= attribute')"/>
  <image href="${elsewhere}/pixel.png" x="0" y="0" width="10" height="10"/>
  <image xlink:href="${elsewhere}/xlink-pixel.png" x="0" y="0" width="10" height="10"/>
  <use href="${elsewhere}/sprite.svg#icon"/>
  <use xlink:href="${elsewhere}/xlink-sprite.svg#icon"/>
  <filter id="f"><feImage href="${elsewhere}/fe-image.png"/></filter>
  <rect width="10" height="10" filter="url(#f)"/>
  <style>
    @import url("${elsewhere}/hostile.css");
    @font-face { font-family: probe; src: url(${elsewhere}/font.woff2) }
    text { font-family: probe }
    svg { cursor: url(${elsewhere}/cursor.png), auto }
    rect { mask-image: url(${elsewhere}/mask.png) }
    g { mask-image: image-set("${elsewhere}/image-set.png" 1x) }
  </style>
  <g><rect width="5" height="5"/></g>
  <foreignObject width="200" height="200">
    <body xmlns="http://www.w3.org/1999/xhtml">
      <img src="/does-not-exist" onerror="window.top.__fired.push('foreignObject onerror=')"/>
      <iframe src="${elsewhere}/frame"></iframe>
    </body>
  </foreignObject>
  <a xlink:href="javascript:window.top.__fired.push('javascript: xlink:href')"><text x="10" y="100">click</text></a>
  <a href="javascript:window.top.__fired.push('javascript: href')"><text x="10" y="150">click</text></a>
  <a><animate attributeName="href" to="javascript:window.top.__fired.push('animate rewriting href')"/>
    <text x="10" y="180">animated</text></a>
</svg>`

/**
 * A plan whose DTD declares an external entity. The sanitiser must refuse it outright: the
 * parser, not the renderer, is what a DOCTYPE attacks.
 */
const doctypeSvg = (elsewhere) => `<?xml version="1.0"?>
<!DOCTYPE svg [
  <!ENTITY external SYSTEM "${elsewhere}/entity.txt">
  <!ENTITY a "lollollollollollollollollollol">
  <!ENTITY b "&a;&a;&a;&a;&a;&a;&a;&a;&a;&a;">
]>
<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><text>&external;&b;</text></svg>`

const PAGE = `<!doctype html><html><head><meta charset="utf-8"><title>svg probe</title></head>
<body><div id="host"></div><div id="shadow"></div><div id="plan"></div>
<script src="/sanitiser.js"></script><script src="/probe.js"></script></body></html>`

const harness = (svg, doctype) => `
const svg = ${JSON.stringify(svg)}
const doctype = ${JSON.stringify(doctype)}
const bypass = ${JSON.stringify(bypass)}
window.__fired = []
window.__violations = []
document.addEventListener('securitypolicyviolation', (e) => {
  window.__violations.push(e.violatedDirective + ' <- ' + (e.blockedURI || '(inline)'))
})
const settle = (ms) => new Promise(r => setTimeout(r, ms))
const bytes = (text) => new TextEncoder().encode(text)

/** What the sanitised mode hands the shadow root: sanitisePlan's tree, or the raw parse. */
const planFor = (text) => {
  if (bypass) return { ok: true, svg: new DOMParser().parseFromString(text, 'image/svg+xml').documentElement }
  return PlanSanitiser.sanitisePlan(bytes(text))
}

window.__run = async (mode) => {
  window.__fired = []
  window.__violations = []
  let root
  const notes = []
  if (mode === 'img blob:') {
    const img = document.createElement('img')
    img.src = URL.createObjectURL(new Blob([svg], { type: 'image/svg+xml' }))
    document.body.append(img)
  } else if (mode === 'img data:') {
    const img = document.createElement('img')
    img.src = 'data:image/svg+xml;base64,' + btoa(unescape(encodeURIComponent(svg)))
    document.body.append(img)
  } else if (mode === 'inline in document') {
    root = document.getElementById('host'); root.innerHTML = svg
  } else if (mode === 'inline in shadow root') {
    const holder = document.getElementById('shadow')
    root = holder.shadowRoot ?? holder.attachShadow({ mode: 'open' })
    root.innerHTML = svg
  } else if (mode === 'inline after sanitisePlan') {
    // As the layout view renders a plan: nodes imported into a shadow root that holds nothing
    // else, never markup parsed as HTML.
    const holder = document.getElementById('plan')
    root = holder.shadowRoot ?? holder.attachShadow({ mode: 'open' })
    const result = planFor(svg)
    if (!result.ok) notes.push('the hostile plan was refused: ' + result.problem.kind)
    else root.append(document.importNode(result.svg, true))
    // The proof that this row rendered a plan at all, rather than staying quiet by showing nothing.
    const shape = root.querySelector('#plan-shape')
    notes.push(shape && shape.getBBox().width > 0 ? 'rendered' : 'did not render the plan')
    const refused = planFor(doctype)
    if (refused.ok) {
      root.append(document.importNode(refused.svg, true))
      notes.push('the DOCTYPE plan was not refused')
    }
  }
  await settle(900)
  // A javascript: href needs a click, and a hover is what fetches a cursor.
  for (const link of root?.querySelectorAll('a') ?? []) {
    link.dispatchEvent(new MouseEvent('click', { bubbles: true }))
  }
  root?.querySelector('svg')?.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }))
  await settle(400)
  return { fired: [...new Set(window.__fired)], violations: [...new Set(window.__violations)], notes }
}
`

const listen = (handler) =>
  new Promise((resolve) => {
    const server = createServer(handler)
    server.listen(0, '127.0.0.1', () =>
      resolve({ server, url: `http://127.0.0.1:${server.address().port}` }),
    )
  })

const SANITISED = 'inline after sanitisePlan'
const MODES = ['img blob:', 'img data:', 'inline in document', 'inline in shadow root', SANITISED]

/**
 * @param {boolean} withPolicy whether to serve the page under the deployment's CSP
 * @returns {Promise<Record<string, {fired: string[], violations: string[], received: string[], notes: string[]}>>}
 */
async function measure(withPolicy) {
  /** Paths the second origin was actually asked for, which is the only proof that counts. */
  let received = []
  const other = await listen((req, res) => {
    const path = req.url.split('?')[0]
    received.push(path)
    if (path.endsWith('.png')) return res.writeHead(200, { 'content-type': 'image/png' }).end(PNG)
    if (path.endsWith('.css'))
      return res.writeHead(200, { 'content-type': 'text/css' }).end('body { outline: 1px solid }')
    if (path.endsWith('.svg'))
      return res
        .writeHead(200, { 'content-type': 'image/svg+xml' })
        .end(
          '<svg xmlns="http://www.w3.org/2000/svg"><g id="icon"><rect width="5" height="5"/></g></svg>',
        )
    return res.writeHead(200, { 'content-type': 'text/html' }).end('<!doctype html>frame')
  })

  const script = harness(hostileSvg(other.url), doctypeSvg(other.url))
  const page = await listen((req, res) => {
    const url = req.url.split('?')[0]
    const send = (body, type) => {
      const headers = { 'content-type': type }
      if (withPolicy) headers['content-security-policy'] = policy
      res.writeHead(200, headers).end(body)
    }
    if (url === '/probe.js') return send(script, 'text/javascript')
    if (url === '/sanitiser.js') return send(sanitiserBundle, 'text/javascript')
    if (url === '/does-not-exist') return res.writeHead(404).end()
    return send(PAGE, 'text/html')
  })

  const browser = await chromium.launch()
  const results = {}
  try {
    for (const mode of MODES) {
      received = []
      const tab = await browser.newPage()
      await tab.goto(page.url, { waitUntil: 'load' })
      const r = await tab.evaluate((m) => window.__run(m), mode)
      await tab.close()
      results[mode] = { ...r, received: [...new Set(received)] }
    }
  } finally {
    await browser.close()
    page.server.close()
    other.server.close()
  }
  return results
}

const report = (title, results) => {
  console.log(`\n=== ${title} ===`)
  for (const [mode, r] of Object.entries(results)) {
    console.log(`\n  ${mode}`)
    console.log(`    script executed   : ${r.fired.length ? r.fired.join(', ') : '(none)'}`)
    console.log(
      `    other origin got  : ${r.received.length ? r.received.join(', ') : '(nothing)'}`,
    )
    console.log(
      `    csp violations    : ${r.violations.length ? r.violations.join('\n                        ') : '(none)'}`,
    )
    if (r.notes.length) console.log(`    notes             : ${r.notes.join('; ')}`)
  }
}

console.log('POLICY:', policy)
if (bypass) console.log('SELF-TEST: --bypass-sanitiser, so this run must fail')
const underPolicy = await measure(true)
report('under the deployment policy', underPolicy)
const noPolicy = await measure(false)
report('control: no Content-Security-Policy at all', noPolicy)

const failures = []

// The policy's proof: under the deployed policy, nothing an SVG carries runs or leaves the
// origin, in any mode.
for (const [mode, r] of Object.entries(underPolicy)) {
  for (const fired of r.fired) failures.push(`policy, ${mode}: executed ${fired}`)
  for (const path of r.received)
    failures.push(`policy, ${mode}: reached the other origin for ${path}`)
}

// The sanitiser's proof: with no policy at all, the sanitised plan runs nothing and reaches
// nothing, and was actually rendered, and the DOCTYPE plan was refused.
for (const [run, results] of [
  ['policy', underPolicy],
  ['no policy', noPolicy],
]) {
  const r = results[SANITISED]
  for (const fired of r.fired) failures.push(`${run}, ${SANITISED}: executed ${fired}`)
  for (const path of r.received)
    failures.push(`${run}, ${SANITISED}: reached the other origin for ${path}`)
  for (const note of r.notes.filter((n) => n !== 'rendered'))
    failures.push(`${run}, ${SANITISED}: ${note}`)
}

// The controls: unsanitised inline SVG with no policy must be seen both to execute and to
// fetch. Without them, "nothing ran" and "nothing was fetched" above would be equally true of
// a probe that could observe neither.
const unsanitised = [noPolicy['inline in document'], noPolicy['inline in shadow root']]
if (!unsanitised.some((r) => r.fired.length > 0))
  failures.push(
    'unsanitised inline SVG executed nothing even with no policy - the probe cannot observe execution, so its silence proves nothing',
  )
if (!Object.values(noPolicy).some((r) => r.received.length > 0))
  failures.push(
    'the second origin was never reached even with no policy - the probe cannot observe a request, so its silence proves nothing',
  )

if (failures.length > 0) {
  console.error('\nA hostile SVG got through:')
  for (const f of failures) console.error(`  - ${f}`)
  process.exit(1)
}
console.log(
  '\nok: under the deployed policy nothing executed or left the origin, and with no policy at all the sanitised plan rendered with nothing executed and nothing fetched',
)
