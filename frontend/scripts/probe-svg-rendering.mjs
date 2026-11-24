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
 * - **The sanitiser's proof.** With no policy at all, the sanitised mode runs nothing, reaches
 *   nothing (on either origin), and its CSS stays inside its box. The policy is a file someone
 *   will edit one day; this row is what still holds when they do. CSS escaping its box is the
 *   sanitiser's alone to stop: `style-src 'unsafe-inline'` lets it through under the policy.
 *
 * **Every vector must be observable.** Each trick in the fixture names the effect or the path
 * that proves it worked, and the unsanitised control run must show every one of them. A vector
 * the probe cannot see is a vector whose absence from the sanitised row proves nothing, so it
 * fails the probe rather than passing silently. The tricks the browser defeats on its own in
 * every mode are left out, and listed in {@link NOT_OBSERVABLE} with the reason.
 *
 * The hostile SVG points at a **second local origin** rather than at an unresolvable host, and
 * that origin reports what it was actually asked for. An unreachable host fails DNS whether or
 * not anything blocked it, so "the request failed" would pass for the wrong reason.
 *
 * `--bypass-sanitiser` is the probe's self-test, and runs in CI: the sanitised mode then renders
 * the raw input the same way, and the run passes only if that row shows the attacks. A probe
 * that cannot tell a bypassed sanitiser from a working one is a probe that proves nothing.
 *
 * Usage:  node scripts/probe-svg-rendering.mjs [--bypass-sanitiser]
 */
import { readFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'
import { buildSanitiserBundle } from './sanitiser-bundle.mjs'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const bypass = process.argv.includes('--bypass-sanitiser')

const policy = (() => {
  const headers = readFileSync(join(root, 'public/_headers'), 'utf8')
  const line = headers.split('\n').find((l) => l.trim().startsWith('Content-Security-Policy:'))
  if (line === undefined) throw new Error('No Content-Security-Policy in public/_headers')
  return line.slice(line.indexOf(':') + 1).trim()
})()

const sanitiserBundle = await buildSanitiserBundle()

const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
)
const PNG_DATA = `data:image/png;base64,${PNG.toString('base64')}`

/** What the unsanitised control must show executing, or CSS doing outside its box. */
const EXPECTED_EFFECTS = [
  'image onload=',
  'foreignObject onerror=',
  'javascript: xlink:href',
  'javascript: href',
  'position: fixed escaped the plan box',
  ':host styled the page around the plan',
]

/** What the unsanitised control must request: second-origin paths, and `self:` strays. */
const EXPECTED_PATHS = [
  '/hostile.css',
  '/font.woff2',
  '/pixel.png',
  '/xlink-pixel.png',
  '/fe-image.png',
  '/frame',
  '/style-attribute.png',
  '/mask.png',
  '/image-set.png',
  '/escaped-mask.svg',
  '/escaped-clip.svg',
  '/escaped-fill.svg',
  '/attribute-image-set.png',
  'self:/%C2%85',
]

/**
 * Tricks left out of the fixture because no mode here can observe them, so their absence
 * would prove nothing. Each is covered by `test/ui/layouts/sanitise.browser.test.ts` instead.
 */
const NOT_OBSERVABLE = {
  '<script>': 'never runs when inserted by innerHTML or importNode, sanitised or not',
  'external <use>': 'the same-origin rule refuses it in every mode, with no policy report',
  'cursor: url()': 'fetched only on a real hover, which a synthetic event does not cause',
  '<?xml-stylesheet?>': 'outside the root element, so no mode here inserts it',
  '<animate> rewriting href': 'Chromium does not run the rewritten javascript: link',
}

/** Every trick, each flagging a distinct effect if it runs or a distinct path if it fetches. */
const hostileSvg = (elsewhere) =>
  `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="200" height="200"
     style="background-image: url(${elsewhere}/style-attribute.png)">
  <rect id="plan-shape" width="200" height="200" fill="#eee"/>
  <image href="${PNG_DATA}" width="1" height="1" onload="window.top.__fired.push('image onload=')"/>
  <image href="${elsewhere}/pixel.png" x="0" y="0" width="10" height="10"/>
  <image xlink:href="${elsewhere}/xlink-pixel.png" x="0" y="0" width="10" height="10"/>
  <image href="&#x85;#x" width="10" height="10"/>
  <filter id="f"><feImage href="${elsewhere}/fe-image.png"/></filter>
  <rect width="10" height="10" filter="url(#f)"/>
  <rect width="10" height="10" mask="\\75 rl(${elsewhere}/escaped-mask.svg#m)"/>
  <rect width="10" height="10" clip-path="u\\rl(${elsewhere}/escaped-clip.svg#c)"/>
  <rect width="10" height="10" fill="\\75 rl(${elsewhere}/escaped-fill.svg#p) red"/>
  <rect width="10" height="10" mask="image-set('${elsewhere}/attribute-image-set.png' 1x)"/>
  <style>
    @import url("${elsewhere}/hostile.css");
    @font-face { font-family: probe; src: url(${elsewhere}/font.woff2) }
    text { font-family: probe }
    ellipse { mask-image: url(${elsewhere}/mask.png) }
    g { mask-image: image-set("${elsewhere}/image-set.png" 1x) }
    svg { position: fixed; top: 0; left: 0; width: 100vw; height: 100vh; z-index: 2147483647 }
    :host { outline: 5px solid red }
  </style>
  <g><rect width="5" height="5"/></g>
  <ellipse rx="5" ry="5"/>
  <foreignObject width="200" height="200">
    <body xmlns="http://www.w3.org/1999/xhtml">
      <img src="/does-not-exist" onerror="window.top.__fired.push('foreignObject onerror=')"/>
      <iframe src="${elsewhere}/frame"></iframe>
    </body>
  </foreignObject>
  <a xlink:href="javascript:window.top.__fired.push('javascript: xlink:href')"><text x="10" y="100">click</text></a>
  <a href="javascript:window.top.__fired.push('javascript: href')"><text x="10" y="150">click</text></a>
</svg>`

/** A plan whose DTD declares an external entity. The sanitiser must refuse it outright. */
const doctypeSvg = (elsewhere) => `<?xml version="1.0"?>
<!DOCTYPE svg [
  <!ENTITY external SYSTEM "${elsewhere}/entity.txt">
  <!ENTITY a "lollollollollollollollollollol">
  <!ENTITY b "&a;&a;&a;&a;&a;&a;&a;&a;&a;&a;">
]>
<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><text>&external;&b;</text></svg>`

/**
 * Sixty-one `<use>` elements that expand to a million instances. Never rendered by the probe,
 * in any mode: rendering it is the attack (it hangs layout for minutes). The sanitiser must
 * refuse it, and with `--bypass-sanitiser` it is reported as not refused.
 */
const useBombSvg = () => {
  let defs = '<g id="l0"><rect width="1" height="1"/></g>'
  for (let level = 1; level <= 6; level += 1) {
    const uses = Array.from({ length: 10 }, (_, i) => `<use href="#l${level - 1}" x="${i}"/>`)
    defs += `<g id="l${level}">${uses.join('')}</g>`
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><defs>${defs}</defs><use href="#l6"/></svg>`
}

const PAGE = `<!doctype html><html><head><meta charset="utf-8"><title>svg probe</title></head>
<body><div id="host"></div><div id="shadow"></div><div id="plan"></div>
<script src="/sanitiser.js"></script><script src="/probe.js"></script></body></html>`

/** Paths the page's own origin is expected to serve. Anything else is a stray request. */
const PAGE_PATHS = new Set(['/', '/probe.js', '/sanitiser.js', '/does-not-exist', '/favicon.ico'])

const harness = (svg, doctype, bomb) => `
const svg = ${JSON.stringify(svg)}
const doctype = ${JSON.stringify(doctype)}
const bomb = ${JSON.stringify(bomb)}
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
  let holder
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
    holder = root = document.getElementById('host'); root.innerHTML = svg
  } else if (mode === 'inline in shadow root') {
    holder = document.getElementById('shadow')
    root = holder.shadowRoot ?? holder.attachShadow({ mode: 'open' })
    root.innerHTML = svg
  } else if (mode === 'imported into shadow root, unsanitised') {
    // The sanitised mode's exact method without the sanitiser: parsed as XML, imported as
    // nodes. The other two inline modes parse as HTML, which reads some tricks differently
    // (HTML maps &#x85; to U+2026), so only this control is like for like.
    holder = document.getElementById('plan')
    root = holder.shadowRoot ?? holder.attachShadow({ mode: 'open' })
    root.append(document.importNode(new DOMParser().parseFromString(svg, 'image/svg+xml').documentElement, true))
  } else if (mode === 'inline after sanitisePlan') {
    // As the layout view renders a plan: nodes imported into a shadow root that holds nothing
    // else, never markup parsed as HTML.
    holder = document.getElementById('plan')
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
    const bombed = planFor(bomb)
    if (bombed.ok) notes.push('the <use> bomb was not refused')
  }
  await settle(900)
  // A javascript: href needs a click.
  for (const link of root?.querySelectorAll('a') ?? []) {
    link.dispatchEvent(new MouseEvent('click', { bubbles: true }))
  }
  // CSS that left its box: the plan positioned over the page, or the page restyled from inside.
  const plan = root?.querySelector('svg')
  if (plan && getComputedStyle(plan).position !== 'static') window.__fired.push('position: fixed escaped the plan box')
  if (holder && getComputedStyle(holder).outlineStyle !== 'none') window.__fired.push(':host styled the page around the plan')
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
const UNSANITISED = [
  'inline in document',
  'inline in shadow root',
  'imported into shadow root, unsanitised',
]
const MODES = ['img blob:', 'img data:', ...UNSANITISED, SANITISED]

/** The effects a policy can stop. CSS escaping its box is not one: inline style is allowed. */
const policyStops = (effect) => !EXPECTED_EFFECTS.slice(4).includes(effect)

/**
 * @param {boolean} withPolicy whether to serve the page under the deployment's CSP
 * @returns {Promise<Record<string, {fired: string[], violations: string[], received: string[], strays: string[], notes: string[]}>>}
 */
async function measure(withPolicy) {
  /** Paths the second origin was actually asked for, which is the only proof that counts. */
  let received = []
  /** Paths the page's own origin was asked for that it does not serve. */
  let strays = []
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
          '<svg xmlns="http://www.w3.org/2000/svg"><mask id="m"/><clipPath id="c"/><g id="p"/></svg>',
        )
    return res.writeHead(200, { 'content-type': 'text/html' }).end('<!doctype html>frame')
  })

  const script = harness(hostileSvg(other.url), doctypeSvg(other.url), useBombSvg())
  const page = await listen((req, res) => {
    const url = req.url.split('?')[0]
    if (!PAGE_PATHS.has(url)) strays.push(`self:${url}`)
    const send = (body, type) => {
      const headers = { 'content-type': type }
      if (withPolicy) headers['content-security-policy'] = policy
      res.writeHead(200, headers).end(body)
    }
    if (url === '/probe.js') return send(script, 'text/javascript')
    if (url === '/sanitiser.js') return send(sanitiserBundle, 'text/javascript')
    if (url !== '/') return res.writeHead(404).end()
    return send(PAGE, 'text/html')
  })

  const browser = await chromium.launch()
  const results = {}
  try {
    for (const mode of MODES) {
      received = []
      strays = []
      const tab = await browser.newPage()
      await tab.goto(page.url, { waitUntil: 'load' })
      const r = await tab.evaluate((m) => window.__run(m), mode)
      await tab.close()
      results[mode] = { ...r, received: [...new Set(received)], strays: [...new Set(strays)] }
    }
  } finally {
    await browser.close()
    page.server.close()
    other.server.close()
  }
  return results
}

const list = (items) => (items.length ? items.join(', ') : '(none)')

const report = (title, results) => {
  console.log(`\n=== ${title} ===`)
  for (const [mode, r] of Object.entries(results)) {
    console.log(`\n  ${mode}`)
    console.log(`    executed or escaped : ${list(r.fired)}`)
    console.log(`    other origin got    : ${list(r.received)}`)
    console.log(`    own origin strays   : ${list(r.strays)}`)
    console.log(`    csp violations      : ${list(r.violations)}`)
    if (r.notes.length) console.log(`    notes               : ${r.notes.join('; ')}`)
  }
}

/** Everything wrong with a row that must be clean. */
const breaches = (r) => [
  ...r.fired.map((f) => `executed or escaped: ${f}`),
  ...r.received.map((p) => `reached the other origin for ${p}`),
  ...r.strays.map((p) => `requested ${p.slice('self:'.length)} from its own origin`),
  ...r.notes.filter((n) => n !== 'rendered'),
]

console.log('POLICY:', policy)
if (bypass) console.log('SELF-TEST: --bypass-sanitiser, so the sanitised row must show the attacks')
console.log('Not in the fixture, because no mode can observe them:')
for (const [trick, why] of Object.entries(NOT_OBSERVABLE)) console.log(`  ${trick}: ${why}`)
const underPolicy = await measure(true)
report('under the deployment policy', underPolicy)
const noPolicy = await measure(false)
report('control: no Content-Security-Policy at all', noPolicy)

const failures = []

// The controls: every vector must be seen working in unsanitised inline SVG with no policy.
// Without this, "nothing ran" and "nothing was fetched" below would be equally true of a vector
// the probe cannot observe.
const seen = new Set(
  UNSANITISED.flatMap((mode) => [
    ...noPolicy[mode].fired,
    ...noPolicy[mode].received,
    ...noPolicy[mode].strays,
  ]),
)
for (const vector of [...EXPECTED_EFFECTS, ...EXPECTED_PATHS])
  if (!seen.has(vector))
    failures.push(
      `the unsanitised control never showed "${vector}" - the probe cannot observe that vector, so its absence proves nothing`,
    )

// The policy's proof: under the deployed policy, nothing runs and nothing leaves the origin,
// in any mode.
for (const [mode, r] of Object.entries(underPolicy)) {
  for (const fired of r.fired.filter(policyStops))
    failures.push(`policy, ${mode}: executed ${fired}`)
  for (const path of r.received)
    failures.push(`policy, ${mode}: reached the other origin for ${path}`)
}

// The sanitiser's proof: in both runs, and above all with no policy, the sanitised plan
// rendered with nothing run, nothing fetched and nothing out of its box, and both hostile
// documents were refused.
const sanitiserBreaches = [
  ['policy', underPolicy],
  ['no policy', noPolicy],
].flatMap(([run, results]) => breaches(results[SANITISED]).map((b) => `${run}, ${SANITISED}: ${b}`))

if (bypass) {
  // The self-test passes only if the bypassed row is seen to fail, in every way it can.
  const r = noPolicy[SANITISED]
  const missing = [
    r.fired.length === 0 && 'nothing executed',
    r.received.length === 0 && 'nothing reached the other origin',
    !r.notes.includes('the DOCTYPE plan was not refused') && 'the DOCTYPE plan still refused',
    !r.notes.includes('the <use> bomb was not refused') && 'the <use> bomb still refused',
  ].filter(Boolean)
  for (const m of missing) failures.push(`bypassing the sanitiser went unnoticed: ${m}`)
  if (failures.length > 0) {
    console.error('\nThe self-test failed: the probe could not tell a bypassed sanitiser apart.')
    for (const f of failures) console.error(`  - ${f}`)
    process.exit(1)
  }
  console.log(
    `\nok: with the sanitiser bypassed the probe saw ${sanitiserBreaches.length} breaches`,
  )
  process.exit(0)
}

failures.push(...sanitiserBreaches)
if (failures.length > 0) {
  console.error('\nA hostile SVG got through:')
  for (const f of failures) console.error(`  - ${f}`)
  process.exit(1)
}
console.log(
  '\nok: under the deployed policy nothing executed or left the origin, and with no policy at all the sanitised plan rendered with nothing executed, nothing fetched and nothing out of its box',
)
