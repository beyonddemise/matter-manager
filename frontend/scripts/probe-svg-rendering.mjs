#!/usr/bin/env node
/**
 * Measures what a hostile SVG can do when this application renders it, in eight modes, once
 * under the Content-Security-Policy the deployment serves and once with no policy at all.
 *
 * The control run is the point. The modes are protected by different things: `<img>` by a rule
 * the browser enforces whatever the policy says, inline SVG by the policy alone, inline SVG
 * after `sanitisePlan` by the sanitiser alone, and the plan holder (`PLAN_HOLDER_CSS`, which
 * PR 6's `<mm-plan-canvas>` uses) by containment alone. Running each with and without the
 * policy, and with and without the holder, tells them apart.
 *
 * **Three proofs, each independent of the others** (spec 2026-11-24 "SVG layouts", *CSP and
 * probes*; ADR 0023):
 *
 * - **The policy's proof.** Under the deployed policy, no mode runs anything or reaches the
 *   second origin. This holds even for unsanitised inline SVG.
 * - **The sanitiser's proof.** With no policy and no holder, the sanitised plan runs nothing,
 *   requests nothing from either origin, and stays inside its box. The policy is a file someone
 *   will edit one day; this row is what still holds when they do. Layout escapes are the
 *   sanitiser's and the holder's to stop: `style-src 'unsafe-inline'` lets them through.
 * - **The holder's proof.** With no policy and no sanitiser, a plan in the holder still stays
 *   inside its box: its geometry is measured, not its styles.
 *
 * **Staying in the box is measured as geometry.** The plan's bounding box must lie within its
 * holder's, and `elementFromPoint` just outside the holder must not hit the plan. A style that
 * moves the plan is caught by what it does, whatever property or selector it used.
 *
 * **Every vector must be observable.** Each trick names the effect or the path that proves it
 * worked, and the like-for-like control (the sanitised mode's exact method, minus the
 * sanitiser) must show every one of them. A vector the probe cannot see is a vector whose
 * absence from the sanitised row proves nothing, so it fails the probe. The few tricks no mode
 * can observe are listed in {@link NOT_OBSERVABLE} with the reason.
 *
 * The hostile SVG points at a **second local origin** rather than at an unresolvable host, and
 * that origin reports what it was actually asked for. An unreachable host fails DNS whether or
 * not anything blocked it, so "the request failed" would pass for the wrong reason.
 *
 * `--bypass-sanitiser` is the probe's self-test, and runs in CI: the sanitised modes then render
 * the raw input the same way, and the run passes only if the probe sees the attacks. A probe
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

/** What the control must show executing. */
const EXPECTED_EFFECTS = [
  'image onload=',
  'foreignObject onerror=',
  'javascript: xlink:href',
  'javascript: href',
]

/** What the control must request: second-origin paths, and `self:` strays on its own origin. */
const EXPECTED_PATHS = [
  '/hostile.css',
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
  '/cursor.png',
  '/animate.png',
  '/set.png',
  'self:/sprite.svg',
  'self:/%C2%85',
  'self:/%C2%85data:image/png;base64,AAAA',
  'self:/da%C2%85ta:image/png;base64,AAAA',
]

/**
 * Tricks left out of the fixture because no mode here can observe them, so their absence
 * would prove nothing. Each is covered by `test/ui/layouts/sanitise.browser.test.ts` instead.
 */
const NOT_OBSERVABLE = {
  '<script>': 'never runs when inserted by innerHTML or importNode, sanitised or not',
  'cross-origin <use>': 'the same-origin rule refuses it in every mode, with no policy report',
  '<?xml-stylesheet?>': 'outside the root element, so no mode here inserts it',
  '@font-face': 'Chromium ignores it inside a shadow root, which is where a plan renders',
  '<animate> rewriting href to javascript:': 'Chromium does not run the rewritten link',
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
  <image href="&#x85;data:image/png;base64,AAAA" width="10" height="10"/>
  <image href="da&#x85;ta:image/png;base64,AAAA" width="10" height="10"/>
  <image width="10" height="10"><animate attributeName="href" to="${elsewhere}/animate.png" dur="1s" fill="freeze"/></image>
  <image width="10" height="10"><set attributeName="href" to="${elsewhere}/set.png"/></image>
  <use href="sprite.svg#icon"/>
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
    #plan-shape { cursor: url(${elsewhere}/cursor.png), auto }
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

const huge = '<rect x="-100000" y="-100000" width="200000" height="200000" fill="lime"/>'
const box = (attributes, inner) =>
  `<svg xmlns="http://www.w3.org/2000/svg" width="200" height="200" ${attributes}><rect width="200" height="200" fill="#eee"/>${inner}</svg>`

/**
 * Ways for a plan to leave its box, each rendered on its own so each is observed on its own.
 * `holderStops` is false where containment is not the defence: a `:host` rule restyles the
 * holder itself, which only the sanitiser can refuse.
 */
const GEOMETRY = [
  {
    name: 'position: fixed in a stylesheet',
    svg: box(
      '',
      '<style>svg { position: fixed; top: 0; left: 0; width: 100vw; height: 100vh; z-index: 2147483647 }</style>',
    ),
  },
  {
    name: 'position: fixed on the root',
    svg: box('style="position: fixed; inset: 0; width: 100vw; height: 100vh"', ''),
  },
  { name: 'overflow="visible" on the root', svg: box('overflow="visible"', huge) },
  {
    name: 'overflow: visible in a stylesheet',
    svg: box('', `<style>svg { overflow: visible }</style>${huge}`),
  },
  { name: 'transform="scale(50)" on the root', svg: box('transform="scale(50)"', '') },
  {
    name: 'transform: scale(50) in a stylesheet',
    svg: box('', '<style>svg { transform: scale(50) }</style>'),
  },
  {
    name: ':host restyling the holder',
    svg: box('', '<style>:host { outline: 5px solid red }</style>'),
    holderStops: false,
  },
]

/** A plan whose DTD declares an external entity. The sanitiser must refuse it outright. */
const doctypeSvg = (elsewhere) => `<?xml version="1.0"?>
<!DOCTYPE svg [
  <!ENTITY external SYSTEM "${elsewhere}/entity.txt">
  <!ENTITY a "lollollollollollollollollollol">
  <!ENTITY b "&a;&a;&a;&a;&a;&a;&a;&a;&a;&a;">
]>
<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><text>&external;&b;</text></svg>`

/**
 * Sixty-one `<use>` elements that expand to a million instances, with each reference spelled
 * by `spell`. Never rendered by the probe, in any mode: rendering it is the attack (it hangs
 * layout for minutes). The sanitiser must refuse it; with `--bypass-sanitiser` it is not.
 */
const useBombSvg = (spell) => {
  let defs = '<g id="l0"><rect width="1" height="1"/></g>'
  for (let level = 1; level <= 6; level += 1) {
    const uses = Array.from(
      { length: 10 },
      (_, i) => `<use href="#${spell(`l${level - 1}`)}" x="${i}"/>`,
    )
    defs += `<g id="l${level}">${uses.join('')}</g>`
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><defs>${defs}</defs><use href="#${spell('l6')}"/></svg>`
}

const BOMBS = {
  'the <use> bomb': useBombSvg((id) => id),
  'the percent-encoded <use> bomb': useBombSvg((id) => id.replace('l', '%6C')),
}

const PAGE = `<!doctype html><html><head><meta charset="utf-8"><title>svg probe</title>
<style>
  body { margin: 0 }
  #host, #shadow, #plan { position: absolute; left: 300px; top: 300px; width: 200px; height: 200px }
  .geometry { position: absolute; left: 700px; top: 300px; width: 200px; height: 200px }
</style></head>
<body><div id="host"></div><div id="shadow"></div><div id="plan"></div>
<script src="/sanitiser.js"></script><script src="/probe.js"></script></body></html>`

/** Paths the page's own origin is expected to serve. Anything else is a stray request. */
const PAGE_PATHS = new Set(['/', '/probe.js', '/sanitiser.js', '/does-not-exist', '/favicon.ico'])

const CONTROL = 'imported into shadow root, unsanitised'
const HOLDER_ONLY = 'imported into the plan holder, unsanitised'
const SANITISED = 'inline after sanitisePlan'
const SANITISED_HELD = 'inline after sanitisePlan, in the plan holder'
const MODES = [
  'img blob:',
  'img data:',
  'inline in document',
  'inline in shadow root',
  CONTROL,
  HOLDER_ONLY,
  SANITISED,
  SANITISED_HELD,
]

const harness = (svg, doctype) => `
const svg = ${JSON.stringify(svg)}
const doctype = ${JSON.stringify(doctype)}
const geometry = ${JSON.stringify(GEOMETRY)}
const bombs = ${JSON.stringify(BOMBS)}
const bypass = ${JSON.stringify(bypass)}
const CONTROL = ${JSON.stringify(CONTROL)}
const HOLDER_ONLY = ${JSON.stringify(HOLDER_ONLY)}
const SANITISED = ${JSON.stringify(SANITISED)}
const SANITISED_HELD = ${JSON.stringify(SANITISED_HELD)}
window.__fired = []
window.__violations = []
document.addEventListener('securitypolicyviolation', (e) => {
  window.__violations.push(e.violatedDirective + ' <- ' + (e.blockedURI || '(inline)'))
})
const settle = (ms) => new Promise(r => setTimeout(r, ms))
const bytes = (text) => new TextEncoder().encode(text)
const parsed = (text) => new DOMParser().parseFromString(text, 'image/svg+xml').documentElement

/** What a sanitised mode hands the shadow root: sanitisePlan's tree, or the raw parse. */
const planFor = (text) => (bypass ? { ok: true, svg: parsed(text) } : PlanSanitiser.sanitisePlan(bytes(text)))

/** A naive consumer's sizing, without containment: what the sanitiser alone must cope with. */
const plainSheet = new CSSStyleSheet()
plainSheet.replaceSync(':host > svg { display: block; width: 100%; height: 100% }')
const holderSheet = new CSSStyleSheet()
holderSheet.replaceSync(PlanSanitiser.PLAN_HOLDER_CSS)

/** Puts one document into a holder the way the mode does, returning the root to inspect. */
const insert = (mode, holder, text, notes) => {
  if (mode === 'inline in document') {
    holder.innerHTML = text
    return holder
  }
  const root = holder.shadowRoot ?? holder.attachShadow({ mode: 'open' })
  if (mode === 'inline in shadow root') {
    root.innerHTML = text
    return root
  }
  const held = mode === HOLDER_ONLY || mode === SANITISED_HELD
  root.adoptedStyleSheets = [held ? holderSheet : plainSheet]
  if (mode === CONTROL || mode === HOLDER_ONLY) {
    // The sanitised modes' exact method without the sanitiser: parsed as XML, imported as nodes.
    root.append(document.importNode(parsed(text), true))
    return root
  }
  const result = planFor(text)
  if (result.ok) root.append(document.importNode(result.svg, true))
  else notes.push('a plan was refused: ' + result.problem.kind)
  return root
}

/** Whether the plan in a holder reaches outside it: by its box, or by what it paints. */
const escapes = (holder, root) => {
  const outer = holder.getBoundingClientRect()
  const plan = root.querySelector('svg')
  if (plan) {
    const r = plan.getBoundingClientRect()
    if (r.left < outer.left - 1 || r.top < outer.top - 1 || r.right > outer.right + 1 || r.bottom > outer.bottom + 1) return true
  }
  const middleX = outer.left + outer.width / 2
  const middleY = outer.top + outer.height / 2
  for (const [x, y] of [[outer.left - 5, middleY], [outer.right + 5, middleY], [middleX, outer.top - 5], [middleX, outer.bottom + 5]]) {
    const hit = document.elementFromPoint(x, y)
    if (hit && (hit === holder || holder.contains(hit))) return true
  }
  return getComputedStyle(holder).outlineStyle !== 'none'
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
  } else {
    const holder = document.getElementById(mode === 'inline in document' ? 'host' : mode === 'inline in shadow root' ? 'shadow' : 'plan')
    root = insert(mode, holder, svg, notes)
  }
  if (mode === SANITISED || mode === SANITISED_HELD) {
    // The proof that this row rendered a plan at all, rather than staying quiet by showing nothing.
    const shape = root.querySelector('#plan-shape')
    notes.push(shape && shape.getBBox().width > 0 ? 'rendered' : 'did not render the plan')
    if (planFor(doctype).ok) notes.push('the DOCTYPE plan was not refused')
    for (const [name, bomb] of Object.entries(bombs)) if (planFor(bomb).ok) notes.push(name + ' was not refused')
  }
  await settle(900)
  // A javascript: href needs a click.
  for (const link of root?.querySelectorAll('a') ?? []) {
    link.dispatchEvent(new MouseEvent('click', { bubbles: true }))
  }
  // Each layout escape on its own, in a holder of its own, beside the main plan.
  if (root) {
    for (const fixture of geometry) {
      const holder = document.createElement('div')
      holder.className = 'geometry'
      document.body.append(holder)
      const inside = insert(mode, holder, fixture.svg, notes)
      await settle(50)
      if (escapes(holder, inside)) window.__fired.push('escaped: ' + fixture.name)
      holder.remove()
    }
  }
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

const isEscape = (effect) => effect.startsWith('escaped: ')

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

  const script = harness(hostileSvg(other.url), doctypeSvg(other.url))
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
      // A real pointer over the plan: a cursor image is fetched only on a real hover, which a
      // synthetic event does not cause.
      await tab.mouse.move(350, 350)
      await tab.mouse.move(400, 400, { steps: 5 })
      await tab.waitForTimeout(500)
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
if (bypass)
  console.log('SELF-TEST: --bypass-sanitiser, so the sanitised rows must show the attacks')
console.log('Not in the fixture, because no mode can observe them:')
for (const [trick, why] of Object.entries(NOT_OBSERVABLE)) console.log(`  ${trick}: ${why}`)
const underPolicy = await measure(true)
report('under the deployment policy', underPolicy)
const noPolicy = await measure(false)
report('control: no Content-Security-Policy at all', noPolicy)

const failures = []

// The control: every vector must be seen working in the like-for-like control with no policy.
// Not in the union of the unsanitised modes: the HTML-parsed modes read some tricks differently,
// and a vector only they can show proves nothing about the mode that ships.
const control = noPolicy[CONTROL]
const seen = new Set([...control.fired, ...control.received, ...control.strays])
const geometryEffects = GEOMETRY.map((g) => `escaped: ${g.name}`)
for (const vector of [...EXPECTED_EFFECTS, ...geometryEffects, ...EXPECTED_PATHS])
  if (!seen.has(vector))
    failures.push(
      `the control never showed "${vector}" - the probe cannot observe that vector, so its absence proves nothing`,
    )

// The policy's proof: under the deployed policy, nothing runs and nothing leaves the origin,
// in any mode. Layout escapes are not the policy's to stop.
for (const [mode, r] of Object.entries(underPolicy)) {
  for (const fired of r.fired.filter((f) => !isEscape(f)))
    failures.push(`policy, ${mode}: executed ${fired}`)
  for (const path of r.received)
    failures.push(`policy, ${mode}: reached the other origin for ${path}`)
}

// The holder's proof: with neither the policy nor the sanitiser, the holder keeps every layout
// escape it is responsible for inside its box.
const held = new Set(
  GEOMETRY.filter((g) => g.holderStops !== false).map((g) => `escaped: ${g.name}`),
)
for (const fired of noPolicy[HOLDER_ONLY].fired.filter((f) => held.has(f)))
  failures.push(`no policy, ${HOLDER_ONLY}: ${fired}`)

// The sanitiser's proof: in both runs, with and without the holder, and above all with neither
// the policy nor the holder, the sanitised plan rendered with nothing run, nothing requested and
// nothing out of its box, and every hostile document was refused.
const sanitiserBreaches = [
  ['policy', underPolicy],
  ['no policy', noPolicy],
].flatMap(([run, results]) =>
  [SANITISED, SANITISED_HELD].flatMap((mode) =>
    breaches(results[mode]).map((b) => `${run}, ${mode}: ${b}`),
  ),
)

if (bypass) {
  // The self-test passes only if the bypassed row is seen to fail, in every way it can.
  const r = noPolicy[SANITISED]
  const missing = [
    r.fired.filter((f) => !isEscape(f)).length === 0 && 'nothing executed',
    r.fired.filter(isEscape).length === 0 && 'nothing escaped its box',
    r.received.length === 0 && 'nothing reached the other origin',
    !r.notes.includes('the DOCTYPE plan was not refused') && 'the DOCTYPE plan still refused',
    ...Object.keys(BOMBS).map(
      (name) => !r.notes.includes(`${name} was not refused`) && `${name} still refused`,
    ),
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
  '\nok: under the deployed policy nothing executed or left the origin; with no policy the sanitised plan rendered with nothing executed, nothing requested and nothing out of its box, with or without the holder; and the holder alone kept every layout escape in',
)
