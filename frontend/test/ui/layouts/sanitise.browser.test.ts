/**
 * The plan sanitiser (#143, PR 5 of the SVG layouts spec): the import checks that need no
 * storage, and the corpus of hostile constructs, each of which must be removed **and** counted.
 *
 * In the browser project because the sanitiser is the browser's own parsers (`DOMParser`,
 * `CSSStyleSheet`) driven by DOMPurify; a Node DOM would test a different parser from the one
 * an attacker targets.
 */
import { describe, expect, it, vi } from 'vitest'
import {
  PLAN_MAX_BYTES,
  type PlanProblem,
  type RemovedCounts,
  type SanitisedPlan,
  sanitisePlan,
} from '../../../src/ui/layouts/sanitise.js'

const SVG_NS = 'http://www.w3.org/2000/svg'
const XLINK = 'xmlns:xlink="http://www.w3.org/1999/xlink"'

const sanitise = (text: string): SanitisedPlan => sanitisePlan(new TextEncoder().encode(text))

/** A plan with a usable viewBox and one drawable shape, around whatever `inner` adds. */
const plan = (inner: string, attributes = 'viewBox="0 0 100 100"') =>
  `<svg xmlns="${SVG_NS}" ${XLINK} ${attributes}><rect width="10" height="10"/>${inner}</svg>`

/** Sanitises, insists it succeeded, and hands back the tree, its markup and the counts. */
function clean(text: string): { svg: SVGSVGElement; markup: string; removed: RemovedCounts } {
  const result = sanitise(text)
  if (!result.ok) throw new Error(`expected a plan, got ${JSON.stringify(result.problem)}`)
  return {
    svg: result.svg,
    markup: new XMLSerializer().serializeToString(result.svg),
    removed: result.removed,
  }
}

const problemOf = (text: string | Uint8Array): PlanProblem['kind'] => {
  const result = typeof text === 'string' ? sanitise(text) : sanitisePlan(text)
  if (result.ok) throw new Error('expected the plan to be refused')
  return result.problem.kind
}

describe('the import checks, in order', () => {
  it('refuses a file over 2 MiB before decoding it', () => {
    // Not valid UTF-8 either: the size check has to come first, or a 50 MB file is decoded.
    const bytes = new Uint8Array(PLAN_MAX_BYTES + 1).fill(0xff)
    expect(PLAN_MAX_BYTES).toBe(2_097_152)
    expect(problemOf(bytes)).toBe('too-large')
  })

  it('accepts a file of exactly 2 MiB', () => {
    const head = plan('')
    const padded = head.replace('</svg>', `${' '.repeat(PLAN_MAX_BYTES - head.length)}</svg>`)
    expect(new TextEncoder().encode(padded).length).toBe(PLAN_MAX_BYTES)
    expect(sanitise(padded).ok).toBe(true)
  })

  it('refuses bytes that are not UTF-8', () => {
    const bytes = new TextEncoder().encode(plan('<text>caf_</text>'))
    bytes[bytes.indexOf('_'.charCodeAt(0))] = 0xe9 // Latin-1 é, a lone byte UTF-8 forbids
    expect(problemOf(bytes)).toBe('not-utf8')
  })

  it('refuses an XML declaration naming another encoding', () => {
    expect(problemOf(`<?xml version="1.0" encoding="ISO-8859-1"?>${plan('')}`)).toBe('not-utf8')
    expect(sanitise(`<?xml version="1.0" encoding="utf-8"?>${plan('')}`).ok).toBe(true)
    expect(sanitise(`﻿<?xml version="1.0" encoding="UTF-8"?>${plan('')}`).ok).toBe(true)
  })

  it('refuses a document that is not well-formed XML', () => {
    expect(problemOf(`<svg xmlns="${SVG_NS}"><rect></svg>`)).toBe('malformed')
    // An entity nobody declared is a well-formedness error in XML, not text.
    expect(problemOf(plan('<text>&undeclared;</text>'))).toBe('malformed')
  })

  it('refuses a root that is not svg in the SVG namespace', () => {
    expect(problemOf('<html xmlns="http://www.w3.org/1999/xhtml"><body/></html>')).toBe('not-svg')
    expect(problemOf('<svg viewBox="0 0 1 1"><rect width="1" height="1"/></svg>')).toBe('not-svg')
  })

  it('refuses any DOCTYPE, before the parser can expand what it declares', () => {
    const laughs = `<?xml version="1.0"?>
<!DOCTYPE svg [
  <!ENTITY a "lollollollollollollollollollol">
  <!ENTITY b "&a;&a;&a;&a;&a;&a;&a;&a;&a;&a;">
  <!ENTITY c "&b;&b;&b;&b;&b;&b;&b;&b;&b;&b;">
  <!ENTITY d "&c;&c;&c;&c;&c;&c;&c;&c;&c;&c;">
]>
${plan('<text>&d;</text>')}`
    const external = `<!DOCTYPE svg [<!ENTITY ext SYSTEM "https://elsewhere.invalid/x">]>${plan('<text>&ext;</text>')}`
    // "Before the parser" is the claim, so the parser must never be called for these.
    const parse = vi.spyOn(DOMParser.prototype, 'parseFromString')
    try {
      expect(problemOf(laughs)).toBe('doctype')
      expect(problemOf(external)).toBe('doctype')
      expect(problemOf(`<!doctype svg>${plan('')}`)).toBe('doctype')
      expect(parse).not.toHaveBeenCalled()
    } finally {
      parse.mockRestore()
    }
  })

  it('refuses more than 100,000 elements', () => {
    expect(sanitise(plan('<g/>'.repeat(99_998))).ok).toBe(true)
    expect(problemOf(plan('<g/>'.repeat(99_999)))).toBe('too-many-elements')
  })

  it('refuses nesting deeper than 64', () => {
    const nest = (depth: number) => `${'<g>'.repeat(depth)}${'</g>'.repeat(depth)}`
    // The root is level 1, so 63 groups reach exactly 64.
    expect(sanitise(plan(nest(63))).ok).toBe(true)
    expect(problemOf(plan(nest(64)))).toBe('too-deep')
  })

  it('refuses a plan with no usable geometry', () => {
    expect(problemOf(plan('', ''))).toBe('no-geometry')
    expect(problemOf(plan('', 'width="100%" height="100%"'))).toBe('no-geometry')
    expect(problemOf(plan('', 'width="20mm" height="10mm"'))).toBe('no-geometry')
    expect(problemOf(plan('', 'viewBox="0 0 0 10"'))).toBe('no-geometry')
    expect(problemOf(plan('', 'viewBox="0 0 -5 10"'))).toBe('no-geometry')
    expect(problemOf(plan('', 'viewBox="0 0 NaN 10"'))).toBe('no-geometry')
    expect(problemOf(plan('', 'viewBox="0 0 10"'))).toBe('no-geometry')
    expect(problemOf(plan('', 'viewBox="0 0 10 10" width="0" height="10"'))).toBe('no-geometry')
    expect(problemOf(plan('', 'width="Infinity" height="10"'))).toBe('no-geometry')
  })

  it('refuses a plan with nothing left to draw', () => {
    const empty = `<svg xmlns="${SVG_NS}" viewBox="0 0 1 1"><desc>nothing</desc><script>x()</script></svg>`
    expect(problemOf(empty)).toBe('nothing-drawable')
  })
})

describe('geometry is normalised onto the root', () => {
  it('synthesises a viewBox from unitless or px width and height', () => {
    const { svg } = clean(plan('', 'width="200px" height="100"'))
    expect(svg.getAttribute('viewBox')).toBe('0 0 200 100')
    expect(svg.hasAttribute('width')).toBe(false)
    expect(svg.hasAttribute('height')).toBe(false)
    expect(svg.getAttribute('preserveAspectRatio')).toBe('xMidYMid meet')
  })

  it('keeps an existing viewBox, comma-separated or not, and reports it', () => {
    const result = sanitise(plan('', 'viewBox="10,20 300 400.5" width="30mm" height="40mm"'))
    if (!result.ok) throw new Error('expected a plan')
    expect(result.viewBox).toEqual([10, 20, 300, 400.5])
    expect(result.svg.getAttribute('viewBox')).toBe('10 20 300 400.5')
    expect(result.svg.hasAttribute('width')).toBe(false)
  })
})

describe('what the sanitiser removes, and counts', () => {
  it('removes <script>', () => {
    const { markup, removed } = clean(plan('<script>window.__x = 1</script>'))
    expect(markup).not.toContain('script')
    expect(removed.scripts).toBe(1)
  })

  it('removes foreignObject with everything inside it, onerror included', () => {
    const { markup, removed } = clean(
      plan(`<foreignObject width="10" height="10">
        <body xmlns="http://www.w3.org/1999/xhtml"><img src="x" onerror="window.__x = 1"/></body>
      </foreignObject>`),
    )
    expect(markup).not.toMatch(/foreignObject|onerror|<img|<body/i)
    expect(removed.embeddedContent).toBe(1)
  })

  it('removes iframe, embed, object, audio and video', () => {
    const xhtml = 'xmlns="http://www.w3.org/1999/xhtml"'
    const { markup, removed } = clean(
      plan(
        `<iframe ${xhtml} src="https://elsewhere.invalid/"/><embed ${xhtml} src="x"/>` +
          `<object ${xhtml} data="x"/><audio ${xhtml} src="x"/><video ${xhtml} src="x"/>`,
      ),
    )
    expect(markup).not.toMatch(/iframe|embed|object|audio|video/)
    expect(removed.embeddedContent).toBe(5)
  })

  it('removes every animation element, which can rewrite an href after sanitising', () => {
    const { markup, removed } = clean(
      plan(`<rect width="1" height="1">
        <animate attributeName="href" to="javascript:alert(1)"/>
        <set attributeName="onclick" to="alert(1)"/>
        <animateMotion dur="1s" path="M0 0"/>
        <animateTransform attributeName="transform" type="rotate"/>
        <discard begin="1s"/>
      </rect>`),
    )
    expect(markup).not.toMatch(/animate|<set|discard|javascript/i)
    expect(removed.animations).toBe(5)
  })

  it('removes every event-handler attribute', () => {
    const { markup, removed } = clean(
      plan(
        '<circle r="1" onload="window.__x = 1" onclick="x()" ONMOUSEOVER="x()"/><g onfocusin="x()"/>',
      ),
    )
    expect(markup).not.toMatch(/\bon[a-z]+=/i)
    expect(removed.eventHandlers).toBe(4)
  })

  it('unwraps <a>: the link goes, what it wrapped stays', () => {
    const { svg, markup, removed } = clean(
      plan(`<a href="javascript:window.__x = 1"><text id="kept">click</text></a>
        <a xlink:href="https://elsewhere.invalid/"><circle id="also-kept" r="2"/></a>`),
    )
    expect(markup).not.toMatch(/<a\b|javascript|elsewhere/)
    expect(svg.querySelector('#kept')?.textContent).toBe('click')
    expect(svg.querySelector('#also-kept')).not.toBeNull()
    expect(removed.links).toBe(2)
  })

  it('removes javascript:, vbscript: and data:text/html in any attribute, however obfuscated', () => {
    const { markup, removed } = clean(
      plan(`<use href="java&#9;script:x()"/><use xlink:href=" JAVASCRIPT:x()"/>
        <image href="vbscript:x" width="1" height="1"/>
        <image href="data:text/html,&lt;script&gt;x()&lt;/script&gt;" width="1" height="1"/>
        <rect width="1" height="1" class="javascript:x"/>`),
    )
    expect(markup).not.toMatch(/script:|text\/html/i)
    expect(removed.unsafeUrls).toBe(5)
  })

  it('keeps only local fragments in href and xlink:href', () => {
    const { svg, markup, removed } = clean(
      plan(`<defs><symbol id="lamp"><circle r="1"/></symbol></defs>
        <use id="local" href="#lamp"/><use id="local-xlink" xlink:href="#lamp"/>
        <use href="https://elsewhere.invalid/sprite.svg#icon"/>
        <use xlink:href="//elsewhere.invalid/sprite.svg#icon"/>
        <use href="sprite.svg#icon"/>
        <image href="https://elsewhere.invalid/pixel.png" width="1" height="1"/>
        <filter id="f"><feImage href="https://elsewhere.invalid/pixel.png"/></filter>`),
    )
    expect(svg.querySelector('#local')?.getAttribute('href')).toBe('#lamp')
    expect(svg.querySelector('#local-xlink')?.getAttribute('xlink:href')).toBe('#lamp')
    expect(markup).not.toMatch(/elsewhere|sprite\.svg/)
    expect(removed.externalReferences).toBe(5)
  })

  it('keeps raster data: images on <image>, and never a nested SVG', () => {
    const png = 'data:image/png;base64,iVBORw0KGgo='
    const { svg, markup, removed } = clean(
      plan(`<image id="raster" href="${png}" width="1" height="1"/>
        <image id="jpeg" xlink:href="data:image/jpeg;base64,/9j/" width="1" height="1"/>
        <image href="data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=" width="1" height="1"/>
        <use href="${png}"/>`),
    )
    expect(svg.querySelector('#raster')?.getAttribute('href')).toBe(png)
    expect(svg.querySelector('#jpeg')?.getAttribute('xlink:href')).toMatch(/^data:image\/jpeg/)
    expect(markup).not.toContain('svg+xml')
    expect(removed.unsafeUrls).toBe(2)
  })

  it('removes url() references that leave the document from presentation attributes', () => {
    const { svg, markup, removed } = clean(
      plan(`<defs><linearGradient id="grad"><stop offset="0"/></linearGradient></defs>
        <rect id="local" width="1" height="1" fill="url(#grad)"/>
        <rect id="remote" width="1" height="1" fill="url(https://elsewhere.invalid/p.svg#g)"
          filter="url('//elsewhere.invalid/f.svg#f')" cursor="url(x.cur), auto"/>`),
    )
    expect(svg.querySelector('#local')?.getAttribute('fill')).toBe('url(#grad)')
    expect(markup).not.toMatch(/elsewhere|x\.cur/)
    expect(removed.externalReferences).toBe(3)
  })

  it('keeps <style> but drops its at-rules and any declaration that could fetch', () => {
    const { svg, markup, removed } = clean(
      plan(`<style>
        @import url("https://elsewhere.invalid/hostile.css");
        @font-face { font-family: x; src: url(https://elsewhere.invalid/f.woff) }
        @media print { .wall { stroke: red } }
        .wall { stroke: #333; stroke-width: 2; background-image: url(https://elsewhere.invalid/bg.png) }
        .room { fill: url(#grad); mask-image: image-set("https://elsewhere.invalid/m.png" 1x) }
        .evil { --u: u\\72l(https://elsewhere.invalid/v.png); background: var(--u); behavior: url(x.htc) }
      </style>`),
    )
    const css = svg.querySelector('style')?.textContent ?? ''
    expect(css).toMatch(/\.wall\s*\{[^}]*stroke:\s*(#333|rgb\(51, 51, 51\))/)
    expect(css).toMatch(/\.room\s*\{[^}]*fill:\s*url\("?#grad"?\)/)
    expect(markup).not.toMatch(/elsewhere|@import|@font-face|@media|var\(|--u|behavior|\.htc/)
    // @import, @font-face, @media; background-image, mask-image, --u and background.
    expect(removed.styleRules).toBe(7)
  })

  it('filters style attributes with the same rules', () => {
    const { svg, markup, removed } = clean(
      plan(`<rect id="r" width="1" height="1"
        style="fill: red; background-image: url(https://elsewhere.invalid/a.png); stroke: url(#g)"/>
        <rect id="gone" width="1" height="1" style="background-image: url(//elsewhere.invalid/b.png)"/>
        <rect id="shorthand" width="1" height="1" style="background: url(//elsewhere.invalid/c.png) red"/>`),
    )
    const style = svg.querySelector('#r')?.getAttribute('style') ?? ''
    expect(style).toMatch(/fill:\s*red/)
    expect(style).toMatch(/stroke:\s*url\("?#g"?\)/)
    expect(svg.querySelector('#gone')?.hasAttribute('style')).toBe(false)
    // A shorthand is filtered as its longhands: the image goes, the colour stays.
    expect(svg.querySelector('#shorthand')?.getAttribute('style')).toMatch(/background-color: red/)
    expect(markup).not.toContain('elsewhere')
    // Counted per longhand: of `background`'s, only `background-color` is allowed to stay.
    expect(removed.styleRules).toBeGreaterThanOrEqual(3)
  })

  it('reserves the mm- names: a forged device group is removed whole', () => {
    const { svg, markup, removed } = clean(
      plan(`<g id="mm-devices" data-mm-format="1">
          <a href="javascript:steal()" data-mm-device="x" onclick="steal()"><circle r="8"/></a>
        </g>
        <rect id="wall" class="mm-marker wall mm-x" data-mm-room="Hall" width="1" height="1"/>`),
    )
    expect(markup).not.toMatch(/mm-|steal|javascript/)
    expect(svg.querySelector('#wall')?.getAttribute('class')).toBe('wall')
    // The group, two class tokens and one data-mm- attribute.
    expect(removed.reservedNames).toBe(4)
  })

  it('removes elements outside the SVG namespace, and editor attributes', () => {
    const { markup, removed } = clean(
      plan(
        '<sodipodi:namedview xmlns:sodipodi="http://sodipodi.sourceforge.net/DTD/sodipodi-0.dtd"/>' +
          '<div xmlns="http://www.w3.org/1999/xhtml">html</div>' +
          '<rect xmlns:inkscape="http://www.inkscape.org/namespaces/inkscape" inkscape:label="Wall" width="1" height="1" xml:base="https://elsewhere.invalid/"/>',
      ),
    )
    expect(markup).not.toMatch(/namedview|<div|inkscape:label|xml:base/)
    expect(removed.otherElements).toBe(2)
    expect(removed.otherAttributes).toBeGreaterThanOrEqual(2)
  })

  it('counts nothing for a plan that needed nothing removed', () => {
    const { removed } = clean(plan('<circle r="3" fill="blue"/>'))
    expect(Object.values(removed).every((count) => count === 0)).toBe(true)
  })
})

describe('what the sanitiser keeps', () => {
  /** The shape of an Inkscape or Illustrator export: class-styled, with defs, symbols and text. */
  const drawing = `<?xml version="1.0" encoding="UTF-8" standalone="no"?>
<svg xmlns="${SVG_NS}" ${XLINK} width="1200" height="800" viewBox="0 0 1200 800">
  <title>Ground floor</title>
  <defs>
    <style>.wall{fill:none;stroke:#222;stroke-width:4}.label{font-family:'Inter', sans-serif;font-size:24px}</style>
    <linearGradient id="floor"><stop offset="0" stop-color="#eee"/><stop offset="1" stop-color="#ddd"/></linearGradient>
    <symbol id="door" viewBox="0 0 10 10"><path d="M0 0 L10 0 A10 10 0 0 1 0 10 Z"/></symbol>
    <clipPath id="clip"><rect width="1200" height="800"/></clipPath>
    <filter id="soft"><feGaussianBlur stdDeviation="1"/></filter>
  </defs>
  <g id="walls" clip-path="url(#clip)" transform="translate(10 10)">
    <rect class="wall" x="0" y="0" width="600" height="400" fill="url(#floor)"/>
    <polyline class="wall" points="600,0 1180,0 1180,780"/>
    <polygon points="0,400 600,400 600,780 0,780" filter="url(#soft)" style="fill: #f8f8f8"/>
    <ellipse cx="300" cy="200" rx="20" ry="10"/><line x1="0" y1="0" x2="10" y2="10"/>
    <use href="#door" x="590" y="190" width="20" height="20"/>
  </g>
  <text class="label" x="300" y="200"><tspan>Kitchen</tspan></text>
</svg>`

  it('keeps every element, the classes and the camelCase SVG names', () => {
    const before = new DOMParser().parseFromString(drawing, 'image/svg+xml')
    const { svg, removed } = clean(drawing)
    expect(svg.querySelectorAll('*').length + 1).toBe(before.querySelectorAll('*').length)
    expect(Object.values(removed).every((count) => count === 0)).toBe(true)
    expect(svg.querySelector('linearGradient')).not.toBeNull()
    expect(svg.querySelector('clipPath')).not.toBeNull()
    expect(svg.querySelector('feGaussianBlur')?.getAttribute('stdDeviation')).toBe('1')
    expect(svg.querySelector('symbol')?.getAttribute('viewBox')).toBe('0 0 10 10')
    expect(svg.querySelector('.label tspan')?.textContent).toBe('Kitchen')
    expect(svg.querySelector('style')?.textContent).toMatch(/\.wall/)
  })

  it('returns a detached SVG element that nothing has loaded yet', () => {
    const { svg } = clean(drawing)
    expect(svg.namespaceURI).toBe(SVG_NS)
    expect(svg.localName).toBe('svg')
    // Inert until the caller imports it: an <image> in this tree cannot fetch.
    expect(svg.ownerDocument).not.toBe(document)
    expect(svg.isConnected).toBe(false)
  })

  it('renders once imported into a shadow root', () => {
    const host = document.createElement('div')
    document.body.append(host)
    const root = host.attachShadow({ mode: 'open' })
    root.append(document.importNode(clean(drawing).svg, true))
    const rect = root.querySelector('rect.wall') as SVGGraphicsElement
    expect(rect.getBBox().width).toBe(600)
    host.remove()
  })

  it('is idempotent: a sanitised plan sanitises to itself', () => {
    const once = clean(drawing).markup
    const twice = clean(once)
    expect(twice.markup).toBe(once)
    expect(Object.values(twice.removed).every((count) => count === 0)).toBe(true)
  })
})

/**
 * Findings of the independent security review of #367, each reproduced in Chromium with no
 * policy before it was fixed. Every case here failed first.
 */
describe('the security review of #367', () => {
  it('1. removes escaped and string-taking CSS functions from presentation attributes', () => {
    const { markup, removed } = clean(
      plan(`<rect id="a" width="1" height="1" mask="\\75 rl(https://elsewhere.invalid/m.svg#m)"/>
        <rect id="b" width="1" height="1" clip-path="u\\rl(https://elsewhere.invalid/c.svg#c)"/>
        <rect id="c" width="1" height="1" fill="\\75 rl(https://elsewhere.invalid/p.svg#p) red"/>
        <rect id="d" width="1" height="1" mask="image-set('https://elsewhere.invalid/m.png' 1x)"/>
        <rect id="e" width="1" height="1" filter="url(https://elsewhere.invalid/f.svg#f)"/>`),
    )
    expect(markup).not.toMatch(/elsewhere|\\|image-set/)
    expect(removed.externalReferences).toBe(5)
  })

  it('1. keeps the functions a drawing really uses in its attributes', () => {
    const { svg } = clean(
      plan(`<rect id="t" width="1" height="1" transform="translate(10 10) rotate(45) scale(2)"
        fill="rgb(10, 20, 30)" filter="url(#f)" clip-path="inset(1px)"/>`),
    )
    const rect = svg.querySelector('#t')
    expect(rect?.getAttribute('transform')).toBe('translate(10 10) rotate(45) scale(2)')
    expect(rect?.getAttribute('fill')).toBe('rgb(10, 20, 30)')
    expect(rect?.getAttribute('filter')).toBe('url(#f)')
    expect(rect?.getAttribute('clip-path')).toBe('inset(1px)')
  })

  it('2. drops :host rules, which would style the page around the plan', () => {
    const { svg, removed } = clean(
      plan(`<style>:host { outline: 5px solid red } :host(.x) rect { fill: red }
        :host-context(body) rect { fill: red } .wall { stroke: black }</style>`),
    )
    const css = svg.querySelector('style')?.textContent ?? ''
    expect(css).not.toMatch(/host/)
    expect(css).toMatch(/\.wall/)
    expect(removed.styleRules).toBe(3)
  })

  it('2. drops CSS that would take the plan out of its box', () => {
    const { svg, markup } = clean(
      plan(
        `<style>svg { position: fixed; top: 0; left: 0; width: 100vw; height: 100vh;
          z-index: 2147483647; inset: 0; overflow: visible } .wall { stroke: black; stroke-width: 2 }</style>`,
        'viewBox="0 0 100 100" style="position: fixed; z-index: 9; right: 0; bottom: 0; fill: red"',
      ),
    )
    expect(markup).not.toMatch(/position|z-index|inset|top:|left:|right:|bottom:|vw|vh|overflow/)
    expect(svg.querySelector('style')?.textContent).toMatch(/stroke-width: 2/)
    expect(svg.getAttribute('style')).toMatch(/fill: red/)
  })

  it('2. drops viewport-unit sizes even on properties it otherwise keeps', () => {
    const { svg } = clean(plan('<style>.a { stroke-width: 50vmax } .b { font-size: 3dvh }</style>'))
    expect(svg.querySelector('style')?.textContent ?? '').not.toMatch(/vmax|dvh/)
  })

  it('3. refuses <use> that expands exponentially', () => {
    let defs = '<g id="l0"><rect width="1" height="1"/></g>'
    for (let level = 1; level <= 6; level += 1) {
      const uses = Array.from({ length: 10 }, (_, i) => `<use href="#l${level - 1}" x="${i}"/>`)
      defs += `<g id="l${level}">${uses.join('')}</g>`
    }
    const bomb = `<svg xmlns="${SVG_NS}" viewBox="0 0 100 100"><defs>${defs}</defs><use href="#l6"/></svg>`
    expect(problemOf(bomb)).toBe('too-many-instances')
  })

  it('3. refuses a <use> cycle, direct or through an ancestor', () => {
    expect(problemOf(plan('<g id="a"><use href="#b"/></g><g id="b"><use href="#a"/></g>'))).toBe(
      'use-cycle',
    )
    expect(
      problemOf(plan('<g id="self"><rect width="1" height="1"/><use href="#self"/></g>')),
    ).toBe('use-cycle')
  })

  it('3. accepts ordinary reuse, and a long chain without exhausting the stack', () => {
    const doors = Array.from({ length: 500 }, (_, i) => `<use href="#door" x="${i}"/>`).join('')
    expect(sanitise(plan(`<symbol id="door"><path d="M0 0h1"/></symbol>${doors}`)).ok).toBe(true)
    // Each link of the chain doubles nothing, but 20,000 links still nest 20,000 instances deep.
    let chain = '<g id="c0"><rect width="1" height="1"/></g>'
    for (let i = 1; i < 20_000; i += 1) chain += `<g id="c${i}"><use href="#c${i - 1}"/></g>`
    expect(problemOf(plan(chain))).toBe('too-many-instances')
  })

  it('4. treats C1 controls in an href as the URL parser does: not a fragment', () => {
    const { markup, removed } = clean(
      plan(`<image href="&#x85;#x" width="1" height="1"/><use href="&#x9;#kept"/>
        <rect id="kept" width="1" height="1"/>`),
    )
    expect(markup).not.toContain('\u0085')
    expect(markup).toContain('#kept')
    expect(removed.externalReferences).toBe(1)
  })

  it('5. removes reserved names from the root too', () => {
    const { svg, removed } = clean(
      plan('', 'viewBox="0 0 1 1" id="mm-root" class="mm-x plan" data-mm-device="x"'),
    )
    expect(svg.hasAttribute('data-mm-device')).toBe(false)
    expect(svg.getAttribute('class')).toBe('plan')
    expect(svg.hasAttribute('id')).toBe(false)
    expect(removed.reservedNames).toBe(3)
  })

  it('CodeRabbit: keeps a drawing written with an svg: prefix', () => {
    const prefixed = `<s:svg xmlns:s="${SVG_NS}" viewBox="0 0 10 10"><s:defs><s:linearGradient id="g"/></s:defs>
      <s:rect id="r" width="1" height="1" fill="url(#g)"/></s:svg>`
    const { svg, removed } = clean(prefixed)
    expect(svg.querySelector('#r')?.namespaceURI).toBe(SVG_NS)
    expect(svg.querySelector('linearGradient')).not.toBeNull()
    expect(Object.values(removed).every((count) => count === 0)).toBe(true)
  })

  it('CodeRabbit: unwraps a link holding more children than an argument list can', () => {
    const { svg, removed } = clean(plan(`<a>${'<!--x-->'.repeat(200_000)}<rect id="in"/></a>`))
    expect(svg.querySelector('#in')).not.toBeNull()
    expect(removed.links).toBe(1)
  })

  it('6. removes xml:id, so mm- names cannot arrive that way', () => {
    const { markup } = clean(plan('<g xml:id="mm-devices"><rect width="1" height="1"/></g>'))
    expect(markup).not.toMatch(/xml:id|mm-/)
  })
})
