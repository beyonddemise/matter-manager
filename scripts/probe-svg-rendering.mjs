#!/usr/bin/env node
/**
 * Measures what a hostile SVG can do when this application renders it — once under the
 * Content-Security-Policy the deployment serves, and once with no policy at all.
 *
 * The control run is the point. #143 has to choose between rendering a layout through
 * `<img src="blob:">` and rendering it inline, and the two are protected by different
 * things: one by a rule the browser enforces whatever the policy says, the other by the
 * policy alone. Only running both tells them apart.
 */
import { readFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')

const policy = (() => {
  const headers = readFileSync(join(root, 'packages/web/public/_headers'), 'utf8')
  const line = headers.split('\n').find((l) => l.trim().startsWith('Content-Security-Policy:'))
  if (line === undefined)
    throw new Error('No Content-Security-Policy in packages/web/public/_headers')
  return line.slice(line.indexOf(':') + 1).trim()
})()

/** Every trick #143 names, each flagging a distinct name if it succeeds. */
const HOSTILE_SVG = `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="200" height="200">
  <script>window.top.__fired.push('inline &lt;script&gt;')</script>
  <rect width="200" height="200" fill="#eee" onload="window.top.__fired.push('onload= attribute')"/>
  <image href="https://example.invalid/pixel.png" x="0" y="0" width="10" height="10"/>
  <use href="https://example.invalid/sprite.svg#icon"/>
  <style>@import url("https://example.invalid/hostile.css");</style>
  <foreignObject width="200" height="200">
    <body xmlns="http://www.w3.org/1999/xhtml">
      <img src="/does-not-exist" onerror="window.top.__fired.push('foreignObject onerror=')"/>
      <iframe src="https://example.invalid/frame"></iframe>
    </body>
  </foreignObject>
  <a xlink:href="javascript:window.top.__fired.push('javascript: href')"><text x="10" y="100">click</text></a>
</svg>`

const PAGE = `<!doctype html><html><head><meta charset="utf-8"><title>svg probe</title></head>
<body><div id="host"></div><div id="shadow"></div><script src="/probe.js"></script></body></html>`

const HARNESS = `
const svg = ${JSON.stringify(HOSTILE_SVG)}
window.__fired = []
window.__violations = []
document.addEventListener('securitypolicyviolation', (e) => {
  window.__violations.push(e.violatedDirective + ' <- ' + (e.blockedURI || '(inline)'))
})
const settle = (ms) => new Promise(r => setTimeout(r, ms))

window.__run = async (mode) => {
  window.__fired = []
  window.__violations = []
  let root
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
  }
  await settle(900)
  // A javascript: href needs a click; nothing else here does.
  root?.querySelector('a')?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
  await settle(400)
  return { fired: [...new Set(window.__fired)], violations: [...new Set(window.__violations)] }
}
`

/** @param {boolean} withPolicy */
async function measure(withPolicy) {
  const server = createServer((req, res) => {
    const url = req.url.split('?')[0]
    const send = (body, type) => {
      const headers = { 'content-type': type }
      if (withPolicy) headers['content-security-policy'] = policy
      res.writeHead(200, headers).end(body)
    }
    if (url === '/probe.js') return send(HARNESS, 'text/javascript')
    if (url === '/does-not-exist') return res.writeHead(404).end()
    return send(PAGE, 'text/html')
  })
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  const origin = `http://127.0.0.1:${server.address().port}`

  const browser = await chromium.launch()
  const results = {}
  for (const mode of ['img blob:', 'img data:', 'inline in document', 'inline in shadow root']) {
    const page = await browser.newPage()
    const attempted = new Set()
    const blocked = new Map()
    page.on('request', (r) => {
      if (!/^(http:\/\/127\.0\.0\.1|data:|blob:)/.test(r.url())) attempted.add(r.url())
    })
    page.on('requestfailed', (r) => {
      if (!/^(http:\/\/127\.0\.0\.1|data:|blob:)/.test(r.url()))
        blocked.set(r.url(), r.failure()?.errorText ?? '?')
    })
    await page.goto(origin, { waitUntil: 'load' })
    const r = await page.evaluate((m) => window.__run(m), mode)
    await page.close()
    results[mode] = { ...r, attempted: [...attempted], blocked: Object.fromEntries(blocked) }
  }
  await browser.close()
  server.close()
  return results
}

const report = (title, results) => {
  console.log(`\n=== ${title} ===`)
  for (const [mode, r] of Object.entries(results)) {
    console.log(`\n  ${mode}`)
    console.log(`    script executed : ${r.fired.length ? r.fired.join(', ') : '(none)'}`)
    console.log(
      `    off-origin      : ${r.attempted.length ? r.attempted.map((u) => `${u} → ${r.blocked[u] ?? 'NOT BLOCKED'}`).join('\n                      ') : '(none attempted)'}`,
    )
    console.log(
      `    csp violations  : ${r.violations.length ? r.violations.join('\n                      ') : '(none)'}`,
    )
  }
}

console.log('POLICY:', policy)
const underPolicy = await measure(true)
report('under the deployment policy', underPolicy)
report('control: no Content-Security-Policy at all', await measure(false))

// The probe is a measurement, and it is also an assertion: under the deployed policy, an SVG
// from an untrusted source must not run anything and must not reach off the origin. Nothing
// calls this in CI yet, because no feature renders an uploaded SVG - but the invariant is about
// the policy rather than about that feature, so it fails loudly the day the policy stops
// holding it.
const failures = []
for (const [mode, r] of Object.entries(underPolicy)) {
  for (const fired of r.fired) failures.push(`${mode}: executed ${fired}`)
  for (const url of r.attempted)
    if (r.blocked[url] === undefined) failures.push(`${mode}: reached ${url}`)
}
if (failures.length > 0) {
  console.error('\nA hostile SVG got through the deployed policy:')
  for (const f of failures) console.error(`  - ${f}`)
  process.exit(1)
}
console.log('\nok: under the deployed policy, nothing executed and nothing left the origin')
