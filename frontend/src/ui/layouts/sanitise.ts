/**
 * The plan sanitiser for SVG layouts (#143; spec 2026-11-24 "SVG layouts", *Import* and
 * *Sanitising*; ADR 0023).
 *
 * A plan is untrusted twice over: the file a writer imports, and every drawing that later
 * arrives by replication, which some member's client or a direct CouchDB write produced. Both
 * pass through {@link sanitisePlan} before anything renders them, so this module is the only
 * thing standing between a hostile drawing and this application's origin when the
 * Content-Security-Policy is not there to catch it. `npm run probe:svg` proves that it holds
 * with no policy at all.
 *
 * **Lazily loaded.** DOMPurify is imported here and nowhere else, and this module is reached
 * only by `import()`, so the sanitiser travels in a chunk only the layout feature downloads.
 * `scripts/check-lazy-svg.mjs` fails the build if it reaches the entry bundle.
 *
 * **Behind one function.** When the native Sanitizer API reaches Safari, replacing DOMPurify is
 * a change to this module alone (spec, *Sanitiser*, option 3).
 *
 * The steps, in the order the spec numbers them, each with its own {@link PlanProblem}:
 * size, encoding, well-formedness, root, DOCTYPE, tree size, geometry, the sanitising itself
 * (which strips rather than refuses), and finally "is anything left to draw". Every refusal is
 * a value, never an exception, so the import dialog can say exactly what was wrong.
 *
 * @module
 */

import DOMPurify, { type Config, type DOMPurify as Purifier } from 'dompurify'

const SVG_NS = 'http://www.w3.org/2000/svg'
const XMLNS_NS = 'http://www.w3.org/2000/xmlns/'

/**
 * The largest plan accepted, in bytes: 2 MiB.
 *
 * The spike's largest ordinary detailed plan was 907 KB. Two attachments (the plan and its
 * woven copy) base64-encoded in one replicated document come to about 5.6 MB at this size,
 * under CouchDB's default `max_document_size` of 8 MB. Exported so a caller can refuse a
 * `File` by its `size` before reading a byte of it.
 */
export const PLAN_MAX_BYTES = 2 * 1024 * 1024

/** The most elements a plan may have, its root included. */
export const PLAN_MAX_ELEMENTS = 100_000

/** The deepest a plan may nest, counting the root as level 1. */
export const PLAN_MAX_DEPTH = 64

/**
 * The most element instances a plan may render once every `<use>` is expanded.
 *
 * The element limit alone does not bound rendering: each `<use>` clones its target, nested uses
 * multiply, and 61 of them can expand to a million instances that hang layout for minutes. So the
 * expanded count gets the same bound the plain tree has.
 */
export const PLAN_MAX_INSTANCES = 100_000

/**
 * The stylesheet every element that renders a plan must adopt in the shadow root it puts the
 * plan in (`shadowRoot.adoptedStyleSheets`). PR 6's `<mm-plan-canvas>` is that element.
 *
 * **Why the holder as well as the sanitiser.** A shadow root scopes selectors, not layout, and
 * the ways for a drawing to leave its box (`position`, `transform`, `overflow`, sizes) are
 * many, so the box is enforced where the box is: the host contains and clips everything inside
 * it, and the plan's root cannot be moved, transformed or allowed to overflow. The sanitiser
 * removes those properties too, and `probe:svg` proves each layer without the other.
 *
 * **Why a cascade layer.** An `!important` declaration in a layer beats every unlayered
 * `!important` declaration, whatever its specificity. A plan's own `<style>` cannot declare a
 * layer (the sanitiser drops every at-rule), so nothing in a plan can outrank these.
 */
export const PLAN_HOLDER_CSS = `@layer plan-holder {
  :host {
    display: block;
    contain: strict;
    overflow: clip;
    isolation: isolate;
  }
  :host > svg {
    position: static !important;
    transform: none !important;
    overflow: hidden !important;
    display: block !important;
    width: 100% !important;
    height: 100% !important;
    margin: 0 !important;
    filter: none !important;
    clip-path: none !important;
    mask: none !important;
  }
}`

/** Why a plan was refused. Each kind is one row of the spec's import-check table. */
export type PlanProblem =
  | { readonly kind: 'too-large'; readonly bytes: number }
  | { readonly kind: 'not-utf8' }
  | { readonly kind: 'malformed' }
  | { readonly kind: 'not-svg' }
  | { readonly kind: 'doctype' }
  | { readonly kind: 'too-many-elements'; readonly count: number }
  | { readonly kind: 'too-deep'; readonly depth: number }
  | { readonly kind: 'no-geometry' }
  | { readonly kind: 'use-cycle' }
  | { readonly kind: 'too-many-instances'; readonly count: number }
  | { readonly kind: 'nothing-drawable' }

/**
 * What sanitising removed, by kind, so the import dialog can say "Removed: 2 scripts, 1
 * external image, 14 event handlers" and a person whose plan looks different knows why.
 *
 * Counts, not a log: a removed element counts once, whatever it contained.
 */
export interface RemovedCounts {
  /** `<script>` elements. */
  scripts: number
  /** `foreignObject`, `iframe`, `embed`, `object`, `audio`, `video`. */
  embeddedContent: number
  /** `animate`, `animateMotion`, `animateTransform`, `animateColor`, `set`, `discard`. */
  animations: number
  /** `<a>` elements unwrapped: the link removed, what it wrapped kept. */
  links: number
  /** `on*` attributes. */
  eventHandlers: number
  /** Attributes carrying `javascript:`, `vbscript:` or a `data:` URL that is not a raster image. */
  unsafeUrls: number
  /**
   * `href`s that are not a local fragment, and attribute values the CSS parser could make
   * fetch: a `url()` leaving the document, a function not on the allow-list, or an escape.
   */
  externalReferences: number
  /** CSS at-rules and declarations dropped from `<style>` elements and `style` attributes. */
  styleRules: number
  /** Elements with an `mm-` id (removed whole), `mm-` class tokens and `data-mm-*` attributes. */
  reservedNames: number
  /** Any other element, such as one outside the SVG namespace. */
  otherElements: number
  /** Any other attribute, such as an editor's `inkscape:label`. */
  otherAttributes: number
}

/** A `viewBox`: minimum x, minimum y, width and height, in user units. */
export type ViewBox = readonly [minX: number, minY: number, width: number, height: number]

/**
 * The outcome of {@link sanitisePlan}.
 *
 * On success, `svg` is the sanitised root **in a document of its own that has no browsing
 * context**, so nothing in it has loaded or can load. The caller renders it by importing it
 * (`document.importNode(svg, true)`) into a shadow root that holds nothing else; it must never
 * be serialised and re-parsed as HTML, which is how mutation XSS works.
 */
export type SanitisedPlan =
  | {
      readonly ok: true
      readonly svg: SVGSVGElement
      readonly viewBox: ViewBox
      readonly removed: RemovedCounts
    }
  | { readonly ok: false; readonly problem: PlanProblem }

/**
 * Elements removed whatever DOMPurify's SVG profile says.
 *
 * Why each: `script` runs; `foreignObject` is a door back into HTML, where the spike measured an
 * `onerror=` executing; the embedding elements load other documents; and the animation
 * elements can **rewrite an attribute after sanitising**, `<animate attributeName="href"
 * to="javascript:…">` being the classic bypass. `use` is *not* here: DOMPurify forbids it by
 * default because of external and `data:` references, which the href rule below already
 * removes, and plans use `<symbol>` + `<use>` for every repeated door and socket.
 */
const FORBIDDEN_ELEMENTS = [
  'script',
  'foreignObject',
  'iframe',
  'embed',
  'object',
  'audio',
  'video',
  'animate',
  'animateColor',
  'animateMotion',
  'animateTransform',
  'set',
  'discard',
]

const EMBEDDED = new Set(['foreignobject', 'iframe', 'embed', 'object', 'audio', 'video'])
const ANIMATIONS = new Set([
  'animate',
  'animatecolor',
  'animatemotion',
  'animatetransform',
  'set',
  'discard',
])

/** Elements that put something on the screen. A plan with none of them is refused. */
const DRAWABLE = 'path, rect, circle, ellipse, line, polyline, polygon, text, image, use'

/**
 * The DOMPurify configuration, on top of its SVG and SVG-filter profiles.
 *
 * - **`KEEP_CONTENT: false`**: a removed element takes its subtree with it. The default hoists
 *   the children, which would lift a `foreignObject`'s HTML body into the drawing for a second
 *   look; removing it whole is simpler to reason about.
 * - **`ADD_TAGS: ['use']`**: see {@link FORBIDDEN_ELEMENTS}.
 * - **`RETURN_DOM`**: the result stays a tree. A string would have to be parsed again, and every
 *   parse is a chance for the markup to mean something different the second time.
 * - **`FORBID_ATTR: ['xml:id']`**: a second way to name an element, which the `mm-` reservation
 *   below would otherwise have to police twice. No drawing tool needs it.
 */
const CONFIG: Config & { RETURN_DOM: true } = {
  USE_PROFILES: { svg: true, svgFilters: true },
  ADD_TAGS: ['use'],
  FORBID_TAGS: FORBIDDEN_ELEMENTS,
  FORBID_ATTR: ['xml:id'],
  KEEP_CONTENT: false,
  RETURN_DOM: true,
}

/**
 * Raster images a plan may embed. Never `data:image/svg+xml`: that is a plan inside the plan,
 * which this sanitiser would never see.
 */
const RASTER_TYPE = /^image\/(?:png|jpeg|webp|gif)[;,]/i

/**
 * Whether a value is a raster `data:` URL, read by the URL parser itself rather than by a
 * pattern over the text: the parser decides what the scheme is, so it decides here too. A
 * control character before or inside `data:` (`&#x85;data:…`, `da&#x85;ta:…`) makes it a
 * relative URL the browser requests from this origin, and here it makes it no `data:` URL at
 * all (re-review of #367).
 */
function isRasterDataUrl(value: string): boolean {
  try {
    const url = new URL(value)
    return url.protocol === 'data:' && RASTER_TYPE.test(url.pathname)
  } catch {
    return false
  }
}

/** Schemes that run code or smuggle a document, checked with whitespace and controls removed. */
const UNSAFE_SCHEME = /(?:javascript|vbscript|data):/

/**
 * CSS functions a declaration may use. Everything else is dropped with its declaration.
 *
 * An allow-list rather than a deny-list of `url(`, because `url(` is not the only way CSS
 * fetches: `image-set("…")`, `image()`, `cross-fade()` and `src()` all take a plain string, and
 * a custom property can hide an escaped `u\72l(` until `var()` substitutes it. `url()` itself is
 * allowed only when it points into the document (`url(#gradient)`), checked separately.
 */
const SAFE_CSS_FUNCTIONS = new Set([
  'rgb',
  'rgba',
  'hsl',
  'hsla',
  'hwb',
  'lab',
  'lch',
  'oklab',
  'oklch',
  'color',
  'color-mix',
  'calc',
  'min',
  'max',
  'clamp',
  'translate',
  'translatex',
  'translatey',
  'translate3d',
  'rotate',
  'rotatex',
  'rotatey',
  'rotatez',
  'rotate3d',
  'scale',
  'scalex',
  'scaley',
  'scale3d',
  'skew',
  'skewx',
  'skewy',
  'matrix',
  'matrix3d',
  'perspective',
  'cubic-bezier',
  'steps',
  // Filter functions and basic shapes, which `filter=` and `clip-path=` take. None takes a URL.
  'blur',
  'brightness',
  'contrast',
  'drop-shadow',
  'grayscale',
  'hue-rotate',
  'invert',
  'opacity',
  'saturate',
  'sepia',
  'inset',
  'circle',
  'ellipse',
  'polygon',
  'url',
])

/**
 * A function call in a value: whatever precedes a `(`, up to a separator. An empty name is a
 * bare parenthesis, as in a label's "Kitchen (north)", which calls nothing.
 */
const FUNCTION_CALL = /([^\s(),'"]*)\(/g

/**
 * Whether a CSS value, from a declaration or a presentation attribute, is free of anything that
 * could fetch: no escapes, only {@link SAFE_CSS_FUNCTIONS}, and `url()` only into the document.
 *
 * **Why one rule for attributes and CSS.** A presentation attribute (`fill=`, `mask=`,
 * `clip-path=`, `filter=`) is parsed by the browser's CSS parser, escapes and all, so
 * `mask="\75 rl(…)"` fetches exactly as `mask: \75 rl(…)` would. The review of #367 found
 * those attributes checked only for the literal text `url(`.
 */
function safeValue(value: string): boolean {
  // Escapes can spell `url(` in a way only the CSS parser reveals. Drawing tools write none.
  if (value.includes('\\')) return false
  const lower = value.toLowerCase()
  for (const match of lower.matchAll(FUNCTION_CALL)) {
    const name = match[1] ?? ''
    if (name === '') continue
    if (!SAFE_CSS_FUNCTIONS.has(name)) return false
    if (name === 'url' && !/^url\(\s*["']?#/.test(lower.slice(match.index))) return false
  }
  return true
}

/**
 * CSS properties a plan may set, as the longhands the browser reports. An allow-list, because
 * the danger is not only fetching: `position`, `z-index`, `inset`, `width` and `overflow` let a
 * plan's CSS leave its box and lay itself over the application, where it could draw markers
 * that are not ours (found by the review of #367). What a drawing needs is paint, text and
 * geometry inside its own coordinate system.
 */
const ALLOWED_PROPERTIES = new Set([
  'opacity',
  'display',
  'visibility',
  'color',
  'filter',
  'lighting-color',
  'paint-order',
  'vector-effect',
  'shape-rendering',
  'image-rendering',
  'text-rendering',
  'text-anchor',
  'dominant-baseline',
  'alignment-baseline',
  'baseline-shift',
  'letter-spacing',
  'word-spacing',
  'line-height',
  'writing-mode',
  'direction',
  'unicode-bidi',
  'white-space',
  'white-space-collapse',
  'color-rendering',
  'background-color',
  'pointer-events',
  'cx',
  'cy',
  'r',
  'rx',
  'ry',
  'x',
  'y',
  'd',
])

/** Families allowed by prefix: `fill-opacity`, `stroke-dasharray`, `font-variant-caps` and so on. */
const ALLOWED_PREFIXES = [
  'fill',
  'stroke',
  'font',
  'text-decoration',
  'text-wrap',
  'mask',
  'clip-path',
  'clip-rule',
  'stop-',
  'flood-',
  'color-interpolation',
]

const allowedProperty = (property: string) =>
  ALLOWED_PROPERTIES.has(property) || ALLOWED_PREFIXES.some((prefix) => property.startsWith(prefix))

/**
 * The attributes SVG 2 defines as presentation attributes: each sets the CSS property of the
 * same name, so the browser reads it as CSS. The spec's list, not a guess at which attributes
 * look like CSS. Every other attribute (`viewBox`, `points`, `offset` on a `<stop>`, `scale` on
 * `<feDisplacementMap>`) is not CSS, whatever its name.
 */
const PRESENTATION_ATTRIBUTES = new Set([
  'alignment-baseline',
  'baseline-shift',
  'clip',
  'clip-path',
  'clip-rule',
  'color',
  'color-interpolation',
  'color-interpolation-filters',
  'color-rendering',
  'cursor',
  'cx',
  'cy',
  'd',
  'direction',
  'display',
  'dominant-baseline',
  'fill',
  'fill-opacity',
  'fill-rule',
  'filter',
  'flood-color',
  'flood-opacity',
  'font-family',
  'font-size',
  'font-size-adjust',
  'font-stretch',
  'font-style',
  'font-variant',
  'font-weight',
  'glyph-orientation-horizontal',
  'glyph-orientation-vertical',
  'height',
  'image-rendering',
  'letter-spacing',
  'lighting-color',
  'marker-end',
  'marker-mid',
  'marker-start',
  'mask',
  'mask-type',
  'opacity',
  'overflow',
  'paint-order',
  'pointer-events',
  'r',
  'rx',
  'ry',
  'shape-rendering',
  'stop-color',
  'stop-opacity',
  'stroke',
  'stroke-dasharray',
  'stroke-dashoffset',
  'stroke-linecap',
  'stroke-linejoin',
  'stroke-miterlimit',
  'stroke-opacity',
  'stroke-width',
  'text-anchor',
  'text-decoration',
  'text-overflow',
  'text-rendering',
  'transform',
  'transform-origin',
  'unicode-bidi',
  'vector-effect',
  'visibility',
  'white-space',
  'width',
  'word-spacing',
  'writing-mode',
  'x',
  'y',
])

/**
 * Presentation attributes allowed on elements inside the plan but never on its root, and never
 * as CSS: shapes need a size and a `transform=`, while the root's size is its holder's business
 * and a transformed root leaves its box (re-review of #367: `transform="scale(50)"` on the root
 * covered the page). Inside the root, a transform moves content within a box that clips it.
 */
const INNER_ONLY_ATTRIBUTES = new Set(['transform', 'transform-origin'])

/**
 * Whether a presentation attribute may stay: the CSS property allow-list, the same one
 * declarations get, plus sizes and the inner-only transforms. `overflow`, `clip` and `cursor`
 * are on none of them. The root's `width` and `height` pass here only to be read as geometry;
 * `normaliseGeometry` then removes them.
 */
const presentationAllowed = (name: string, root: boolean, inMarker: boolean) => {
  // The root's paint effects reach past its box: a drop-shadow or an offset filter region
  // draws outside it (third security review of #367). Inside the root they are clipped.
  if (root && ROOT_PAINT_EFFECTS.some((effect) => name.startsWith(effect))) return false
  // Markers only as attributes, and only one level deep: a marker inside a marker multiplies
  // painting by the vertex count at each level. One level is counted in the instance budget.
  if (MARKER_ATTRIBUTES.includes(name)) return !inMarker
  return (
    allowedProperty(name) ||
    name === 'width' ||
    name === 'height' ||
    (!root && INNER_ONLY_ATTRIBUTES.has(name))
  )
}

/** Paint effects that draw beyond the box of the element they are set on. */
const ROOT_PAINT_EFFECTS = ['filter', 'clip-path', 'mask']

/** Whether an element is the plan's root: an `svg` whose parent, if any, is not SVG. */
const isPlanRoot = (element: Element) =>
  element.localName === 'svg' &&
  element.namespaceURI === SVG_NS &&
  element.parentElement?.namespaceURI !== SVG_NS

/** Viewport units, which size a plan by the window rather than by its own box. */
const VIEWPORT_UNIT = /\d(?:[sld]?v(?:w|h|i|b|min|max))\b/i

/** Selectors that reach out of the plan's shadow root, onto its host or beyond. */
const ESCAPING_SELECTOR = /:host|::slotted|::part/i

/** One DOMPurify instance of our own, so its hooks never reach anybody else's use of it. */
let purifier: Purifier | undefined

/**
 * Validates and sanitises an SVG plan.
 *
 * Takes the bytes rather than a string because two of the checks are about bytes: the size
 * limit, and that the file is UTF-8 at all.
 *
 * @param bytes the file as read, or a stored `plan.svg` attachment
 * @returns the sanitised plan with its normalised `viewBox` and what was removed, or the first
 *   check it failed
 */
export function sanitisePlan(bytes: Uint8Array): SanitisedPlan {
  // 1. Size, before anything else looks at the bytes.
  if (bytes.byteLength > PLAN_MAX_BYTES) return refuse({ kind: 'too-large', bytes: bytes.length })

  // 2. Encoding.
  const text = decodeUtf8(bytes)
  if (text === undefined) return refuse({ kind: 'not-utf8' })

  // 5, ahead of 3. A DOCTYPE is refused *before* parsing, not after, because parsing is what it
  // attacks: the internal subset declares the entities, and the parser expands them. A
  // billion-laughs document would exhaust the tab inside `DOMParser` before any check on its
  // result could run. A plan never needs one. The parsed tree is checked again below, so this
  // text scan is a fast path, not the only guard.
  if (/<!doctype/i.test(text)) return refuse({ kind: 'doctype' })

  // 3. Well-formed. `DOMParser` reports failure in-band, as a `parsererror` element.
  const parsed = new DOMParser().parseFromString(text, 'image/svg+xml')
  if (parsed.getElementsByTagNameNS('*', 'parsererror').length > 0)
    return refuse({ kind: 'malformed' })

  // 4. Root.
  const root = parsed.documentElement
  if (root.localName !== 'svg' || root.namespaceURI !== SVG_NS) return refuse({ kind: 'not-svg' })

  // 5. No DTD, from the parser's own point of view.
  if (parsed.doctype !== null) return refuse({ kind: 'doctype' })

  // 6. Size of the tree.
  const tree = measureTree(root)
  if (tree.elements > PLAN_MAX_ELEMENTS)
    return refuse({ kind: 'too-many-elements', count: tree.elements })
  if (tree.depth > PLAN_MAX_DEPTH) return refuse({ kind: 'too-deep', depth: tree.depth })

  // 7. Geometry.
  const viewBox = geometryOf(root)
  if (viewBox === undefined) return refuse({ kind: 'no-geometry' })

  // 8. Sanitise. Stripping is not refusing: a CAD export full of editor metadata still imports.
  const removed = emptyCounts()
  const plain = unprefixSvg(root)
  removeReservedNames(plain, removed)
  unwrapLinks(plain, removed)
  const svg = purify(plain, removed)
  if (svg === undefined) return refuse({ kind: 'nothing-drawable' })
  filterStyles(svg, removed)
  normaliseGeometry(svg, viewBox)

  // 6, again, on what will actually render: every `<use>` expanded.
  const expanded = expandedInstances(svg, resolveUses(svg, removed))
  if (expanded === 'cycle') return refuse({ kind: 'use-cycle' })
  if (expanded > PLAN_MAX_INSTANCES) return refuse({ kind: 'too-many-instances', count: expanded })

  // 9. Something left.
  if (svg.querySelector(DRAWABLE) === null) return refuse({ kind: 'nothing-drawable' })

  return { ok: true, svg, viewBox, removed }
}

const refuse = (problem: PlanProblem): SanitisedPlan => ({ ok: false, problem })

const emptyCounts = (): RemovedCounts => ({
  scripts: 0,
  embeddedContent: 0,
  animations: 0,
  links: 0,
  eventHandlers: 0,
  unsafeUrls: 0,
  externalReferences: 0,
  styleRules: 0,
  reservedNames: 0,
  otherElements: 0,
  otherAttributes: 0,
})

/**
 * Decodes strict UTF-8, or returns `undefined`.
 *
 * `fatal: true` because the default replaces a bad byte with U+FFFD and carries on, which would
 * import a Latin-1 plan with every accented room name silently mangled. An XML declaration
 * naming another encoding is refused too: the bytes may happen to be valid UTF-8 while the file
 * means something else by them.
 */
function decodeUtf8(bytes: Uint8Array): string | undefined {
  let text: string
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  } catch {
    return undefined
  }
  const declared = /^\s*<\?xml\s[^>]*?\bencoding\s*=\s*["']([^"']*)["']/.exec(text)?.[1]
  if (declared !== undefined && !/^utf-?8$/i.test(declared)) return undefined
  return text
}

/** Counts the elements of a tree and its depth, without recursing (a hostile plan is deep). */
function measureTree(root: Element): { elements: number; depth: number } {
  let elements = 0
  let depth = 0
  const stack: Array<[Element, number]> = [[root, 1]]
  for (let next = stack.pop(); next !== undefined; next = stack.pop()) {
    const [element, level] = next
    elements += 1
    if (level > depth) depth = level
    for (const child of element.children) stack.push([child, level + 1])
  }
  return { elements, depth }
}

/**
 * The elements a `<use>` reference can reach, resolved the way the browser resolves it.
 *
 * **Why decode.** Chromium percent-decodes a fragment before looking the id up, so
 * `href="#%6C5"` reaches `id="l5"`. Looking up the raw text instead let a `<use>` bomb spelled
 * with escapes count as zero instances and hang the tab (re-review of #367). The URL parser
 * produces the fragment and `decodeURIComponent` decodes it, so no escaping rule of ours is
 * involved; the raw text is looked up as well, so whichever the browser picks is counted.
 */
function referenceTargets(href: string, byId: ReadonlyMap<string, Element>): Element[] {
  const stripped = urlStrip(href)
  if (!stripped.startsWith('#')) return []
  const found = new Set<Element>()
  const raw = byId.get(stripped.slice(1))
  if (raw !== undefined) found.add(raw)
  try {
    const decoded = byId.get(
      decodeURIComponent(new URL(stripped, 'http://plan.invalid/').hash.slice(1)),
    )
    if (decoded !== undefined) found.add(decoded)
  } catch {
    // A malformed escape decodes to nothing, so it reaches nothing.
  }
  return [...found]
}

/**
 * Resolves every `<use>`, removes the ones that reach nothing, and returns what the rest reach.
 *
 * **Why remove rather than count as zero.** A reference this function cannot resolve is one it
 * cannot vouch for: if the browser resolves it some other way, an uncounted `<use>` is exactly
 * how the bomb got through. A `<use>` that reaches nothing draws nothing, so removing it costs
 * the drawing nothing. Removing one can strand another that pointed at it, so the removals
 * follow the references rather than rescanning the tree.
 */
function resolveUses(svg: SVGSVGElement, removed: RemovedCounts): Map<Element, Element[]> {
  const byId = new Map<string, Element>()
  for (const element of svg.querySelectorAll('[id]')) {
    const id = element.getAttribute('id') ?? ''
    if (!byId.has(id)) byId.set(id, element)
  }
  const targets = new Map<Element, Element[]>()
  const pointingAt = new Map<Element, Element[]>()
  for (const use of svg.getElementsByTagNameNS(SVG_NS, 'use')) {
    const href = use.getAttribute('href') ?? use.getAttribute('xlink:href') ?? ''
    const reached = referenceTargets(href, byId)
    targets.set(use, reached)
    for (const target of reached) {
      const list = pointingAt.get(target)
      if (list === undefined) pointingAt.set(target, [use])
      else list.push(use)
    }
  }
  const dangling = (use: Element) =>
    (targets.get(use) ?? []).every((target) => !svg.contains(target))
  const queue = [...targets.keys()].filter(dangling)
  for (let use = queue.pop(); use !== undefined; use = queue.pop()) {
    if (!svg.contains(use)) continue
    const gone = [use, ...use.querySelectorAll('*')]
    // An href still present is an unresolvable reference; an absent one was already removed,
    // and counted, by the reference rule.
    if (use.hasAttribute('href') || use.hasAttribute('xlink:href')) removed.externalReferences += 1
    use.remove()
    for (const element of gone)
      for (const other of pointingAt.get(element) ?? []) if (dangling(other)) queue.push(other)
  }
  for (const use of [...targets.keys()]) {
    if (!svg.contains(use)) targets.delete(use)
    else
      targets.set(
        use,
        (targets.get(use) ?? []).filter((target) => svg.contains(target)),
      )
  }
  return targets
}

/**
 * How many element instances the tree renders with every `<use>` expanded, or `'cycle'`.
 *
 * A `<use>` renders a copy of its target's whole subtree, uses inside it included, so the count
 * is a sum over a graph whose edges are children and `use` targets. Child edges alone cannot
 * loop; a loop means a `use` reaches its own ancestor or another `use` that reaches it back,
 * which browsers refuse to render and which is refused here. Iterative, with memoised counts,
 * because a chain of twenty thousand uses would overflow a recursive walk, and capped, because
 * the true count can be astronomically large.
 */
function expandedInstances(
  svg: SVGSVGElement,
  targets: ReadonlyMap<Element, readonly Element[]>,
): number | 'cycle' {
  const markers = markerEdges(svg)
  // Each edge carries how many times its target is painted: once for a child or a `<use>`,
  // once per vertex for a marker.
  const edges = (element: Element): Array<[Element, number]> => [
    ...[...element.children].map((child): [Element, number] => [child, 1]),
    ...(targets.get(element) ?? []).map((target): [Element, number] => [target, 1]),
    ...(markers.get(element) ?? []),
  ]
  const cap = PLAN_MAX_INSTANCES + 1
  const counted = new Map<Element, number>()
  const onPath = new Set<Element>()
  type Frame = { element: Element; next: Array<[Element, number]> | undefined }
  const stack: Frame[] = [{ element: svg, next: undefined }]
  while (stack.length > 0) {
    const frame = stack[stack.length - 1] as Frame
    if (frame.next === undefined) {
      if (counted.has(frame.element)) {
        stack.pop()
        continue
      }
      frame.next = edges(frame.element)
      onPath.add(frame.element)
      for (const [next] of frame.next) {
        if (onPath.has(next)) return 'cycle'
        if (!counted.has(next)) stack.push({ element: next, next: undefined })
      }
      continue
    }
    stack.pop()
    onPath.delete(frame.element)
    let total = 1
    for (const [next, times] of frame.next)
      total = Math.min(cap, total + times * (counted.get(next) ?? 0))
    counted.set(frame.element, total)
  }
  return counted.get(svg) ?? 1
}

/** The attributes that put a marker on a shape. CSS cannot: the sanitiser drops it there. */
const MARKER_ATTRIBUTES = ['marker-start', 'marker-mid', 'marker-end']

/** Shapes a marker is drawn on. */
const MARKABLE = 'path, line, polyline, polygon'

/**
 * How many vertices a shape and everything inside it can put a marker on. Crude on purpose and
 * never low: every run of digits and every command letter in `d` or `points` counts as a
 * vertex of its own. Every number holds a digit run and two numbers never share one, and a
 * `z` with no numbers is a vertex too, so the count cannot fall below the true one. It
 * over-counts a path by at least half and an arc by more, which only spends budget.
 */
function markableVertices(element: Element): number {
  let total = 0
  for (const shape of [element, ...element.querySelectorAll(MARKABLE)]) {
    const name = shape.localName
    if (name === 'line') total += 2
    else if (name === 'path' || name === 'polyline' || name === 'polygon') {
      const text = shape.getAttribute(name === 'path' ? 'd' : 'points') ?? ''
      total += (text.match(/\d+|[a-z]/gi)?.length ?? 0) + 1
    }
  }
  return total
}

/**
 * The markers each element puts on its shapes, weighted by how many vertices receive one.
 *
 * Markers multiply painting: one 300-vertex path drawing a 300-vertex marker that draws
 * another is 300³ paints from 6 KB (third security review of #367). The sanitiser keeps
 * markers to one level, as attributes only, outside any `<marker>`; this puts that one level in
 * the instance budget as (vertices of the element and everything that inherits from it) ×
 * (the marker's own counted size). A marker reached again through `<use>` is multiplied by the
 * graph walk like anything else a `<use>` copies.
 */
function markerEdges(svg: SVGSVGElement): Map<Element, Array<[Element, number]>> {
  const byId = new Map<string, Element>()
  for (const element of svg.querySelectorAll('[id]')) {
    const id = element.getAttribute('id') ?? ''
    if (!byId.has(id)) byId.set(id, element)
  }
  const edges = new Map<Element, Array<[Element, number]>>()
  const selector = MARKER_ATTRIBUTES.map((name) => `[${name}]`).join(', ')
  for (const element of svg.querySelectorAll(selector)) {
    const reached: Array<[Element, number]> = []
    const times = markableVertices(element)
    for (const name of MARKER_ATTRIBUTES) {
      // The reference rule has already made every url() a fragment, so this only reads it.
      const fragment = /url\(\s*["']?(#[^"')]*)/.exec(element.getAttribute(name) ?? '')?.[1]
      if (fragment === undefined) continue
      for (const marker of referenceTargets(fragment, byId)) reached.push([marker, times])
    }
    if (reached.length > 0) edges.set(element, reached)
  }
  return edges
}

/** A plain number in user units: unitless or `px`, nothing else. */
const LENGTH = /^\s*([+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?)(?:px)?\s*$/i

const userUnits = (value: string | null): number | undefined => {
  const match = value === null ? null : LENGTH.exec(value)
  return match === null ? undefined : Number(match[1])
}

const positive = (value: number | undefined): value is number =>
  value !== undefined && Number.isFinite(value) && value > 0

/**
 * The plan's `viewBox`, read from the attribute or synthesised from `width` and `height`.
 *
 * Without one there is no coordinate system for placements, which are stored in user units of
 * this `viewBox`. A `width` or `height` that is present in user units but zero, negative or not
 * finite is refused even beside a good `viewBox`: the file is broken, and guessing which half
 * of it is right would be a guess.
 */
function geometryOf(root: Element): ViewBox | undefined {
  const widthText = root.getAttribute('width')
  const heightText = root.getAttribute('height')
  const width = userUnits(widthText)
  const height = userUnits(heightText)
  if ((width !== undefined && !positive(width)) || (height !== undefined && !positive(height)))
    return undefined

  const box = root.getAttribute('viewBox')
  if (box !== null) {
    const parts = box
      .trim()
      .split(/[\s,]+/)
      .map(Number)
    const [minX, minY, w, h] = parts
    if (
      parts.length === 4 &&
      parts.every(Number.isFinite) &&
      minX !== undefined &&
      minY !== undefined &&
      positive(w) &&
      positive(h)
    )
      return [minX, minY, w, h]
    return undefined
  }
  return positive(width) && positive(height) ? [0, 0, width, height] : undefined
}

/**
 * Puts the `viewBox` on the root and lets the plan scale to its container.
 *
 * `width` and `height` go: a plan's size is its container's business, and the markers placed
 * over it rely on `xMidYMid meet` mapping user units linearly onto that container's box.
 */
function normaliseGeometry(svg: SVGSVGElement, viewBox: ViewBox): void {
  svg.setAttribute('viewBox', viewBox.join(' '))
  svg.removeAttribute('width')
  svg.removeAttribute('height')
  svg.setAttribute('preserveAspectRatio', 'xMidYMid meet')
}

/** Whether a name is one of ours: `mm-…`, which the woven device group uses. */
const reserved = (name: string) => name.toLowerCase().startsWith('mm-')

/**
 * Removes every `mm-` name from the plan.
 *
 * **Why the names are ours.** The woven copy's device group (`g#mm-devices`, `data-mm-*`) is
 * produced only by the app, from trusted inputs. A plan that could carry those names could
 * forge markers: links to anywhere, devices that are not there. So an element with an `mm-` id
 * goes **with its subtree**, which is also what makes a stored `woven.svg` sanitise back to its
 * bare plan, forged group or genuine. A class token or `data-mm-*` attribute just goes.
 */
function removeReservedNames(root: Element, removed: RemovedCounts): void {
  // The root included: it is the one element whose `mm-` names would otherwise survive. It
  // cannot be removed, so it loses the name instead.
  for (const element of [root, ...root.querySelectorAll('*')]) {
    if (!element.isConnected) continue
    if (reserved(element.getAttribute('id') ?? '')) {
      if (element === root) element.removeAttribute('id')
      else element.remove()
      removed.reservedNames += 1
      if (element !== root) continue
    }
    for (const attribute of [...element.attributes]) {
      if (attribute.name.toLowerCase().startsWith('data-mm-')) {
        element.removeAttributeNode(attribute)
        removed.reservedNames += 1
      }
    }
    const classes = element.getAttribute('class')
    if (classes !== null) {
      const tokens = classes.split(/\s+/).filter(Boolean)
      const kept = tokens.filter((token) => !reserved(token))
      if (kept.length < tokens.length) {
        removed.reservedNames += tokens.length - kept.length
        if (kept.length > 0) element.setAttribute('class', kept.join(' '))
        else element.removeAttribute('class')
      }
    }
  }
}

/**
 * Replaces every SVG `<a>` with its children.
 *
 * **Why unwrap rather than keep or remove.** A link in a plan points wherever its author chose,
 * and the only links the layout view may show are its own device markers. Removing the element
 * would remove the room label it wrapped; unwrapping keeps the drawing and drops the link.
 */
function unwrapLinks(root: Element, removed: RemovedCounts): void {
  for (const link of [...root.getElementsByTagNameNS(SVG_NS, 'a')]) {
    // One child at a time: spreading them into `replaceWith` overflows the argument list for a
    // link holding a few hundred thousand comments, which the element limit does not count.
    while (link.firstChild !== null) link.before(link.firstChild)
    link.remove()
    removed.links += 1
  }
}

/**
 * Rewrites every prefixed SVG element (`<s:rect>` under `xmlns:s=…`) to the default namespace.
 *
 * The same drawing, and legal XML, but DOMPurify compares qualified names against its
 * unprefixed allow-list and would drop the root, refusing a valid plan as empty. Only elements
 * already in the SVG namespace are touched, so nothing is moved *into* SVG that was not there.
 * Returns the root, which may itself have been replaced.
 */
function unprefixSvg(root: Element): Element {
  let result = root
  for (const element of [root, ...root.querySelectorAll('*')]) {
    if (element.namespaceURI !== SVG_NS || element.prefix === null) continue
    const plain = element.ownerDocument.createElementNS(SVG_NS, element.localName)
    // The prefix's own declaration (`xmlns:s`) is dropped with the prefix it declared.
    for (const attribute of [...element.attributes])
      if (attribute.namespaceURI !== XMLNS_NS)
        plain.setAttributeNodeNS(attribute.cloneNode() as Attr)
    while (element.firstChild !== null) plain.append(element.firstChild)
    element.replaceWith(plain)
    if (element === root) result = plain
  }
  return result
}

/**
 * Lowercased, with every whitespace and control character removed: deliberately *more*
 * aggressive than a URL parser, because it is only used to *detect* a scheme. Finding
 * `javascript:` in more places than the browser would is a safe mistake.
 */
const squash = (value: string) =>
  // biome-ignore lint/suspicious/noControlCharactersInRegex: removing controls is the point.
  value.replace(/[\u0000- \u007f-\u009f]/g, '').toLowerCase()

/**
 * A URL as the URL parser reads it before anything else: leading and trailing C0 controls and
 * spaces trimmed, tabs and newlines removed, and nothing more.
 *
 * **Why not {@link squash}.** Deciding that a reference *is* a fragment has to err the other
 * way. `squash` also removes U+0080–U+009F, which the URL parser keeps, so `href="&#x85;#x"`
 * looked like `#x` to the check and was requested as `/%C2%85` (review of #367).
 */
const urlStrip = (value: string) =>
  // biome-ignore lint/suspicious/noControlCharactersInRegex: the URL spec's own stripping.
  value.replace(/^[\u0000- ]+|[\u0000- ]+$/g, '').replace(/[\t\n\r]/g, '')

/**
 * Why an attribute must go, or `undefined` if it may stay as far as references go.
 *
 * Applied to every attribute DOMPurify visits, before its own allow-list, and again to the
 * result as a backstop. One predicate for both, so the two can never disagree.
 */
function rejection(
  element: Element,
  name: string,
  value: string,
): 'eventHandlers' | 'unsafeUrls' | 'externalReferences' | 'styleRules' | undefined {
  const lower = name.toLowerCase()
  if (lower.startsWith('on')) return 'eventHandlers'
  const squashed = squash(value)
  const isHref = lower === 'href' || lower === 'xlink:href'
  if (isHref && element.localName === 'image' && isRasterDataUrl(value)) return undefined
  if (UNSAFE_SCHEME.test(squashed)) return 'unsafeUrls'
  // The root is the box the plan must stay in, so it keeps no style of its own: its size comes
  // from the holder, and every declaration that could move it is one the holder would fight.
  const root = isPlanRoot(element)
  if (root && lower === 'style') return 'styleRules'
  if (
    PRESENTATION_ATTRIBUTES.has(lower) &&
    !presentationAllowed(lower, root, element.closest('marker') !== null)
  )
    return 'styleRules'
  // Only a fragment: the plan may point into itself (`<use href="#door">`) and nowhere else.
  // A relative path is as external as an absolute one, resolved against this application.
  if (isHref) return urlStrip(value).startsWith('#') ? undefined : 'externalReferences'
  if (lower === 'xml:base') return 'externalReferences'
  // Every other attribute may be a presentation attribute, read by the CSS parser, so it gets
  // the CSS rule. `style` itself is filtered declaration by declaration in `filterStyles`.
  if (lower !== 'style' && !safeValue(value)) return 'externalReferences'
  return undefined
}

/** DOMPurify, once, with the reference rule as its attribute hook. */
function instance(): Purifier {
  if (purifier !== undefined) return purifier
  const created = DOMPurify(window)
  created.addHook('uponSanitizeAttribute', (node, data) => {
    if (rejection(node as Element, data.attrName, data.attrValue) !== undefined)
      data.keepAttr = false
  })
  purifier = created
  return created
}

/**
 * Runs DOMPurify over the parsed root and classifies what it removed.
 *
 * The root is passed as a node, so DOMPurify imports it into an inert HTML document of its own
 * and never parses markup. What comes back is that document's body, holding our `svg`.
 */
function purify(root: Element, removed: RemovedCounts): SVGSVGElement | undefined {
  const purify = instance()
  const body = purify.sanitize(root, CONFIG)
  for (const entry of purify.removed) {
    // DOMPurify lists the body it wrapped our root in among the removed elements; it was never
    // part of the plan.
    if ('element' in entry && entry.element === body) continue
    if ('element' in entry && entry.element instanceof Element) countElement(entry.element, removed)
    else if ('attribute' in entry && entry.attribute !== null && entry.from instanceof Element)
      countAttribute(entry.from, entry.attribute, removed)
  }
  const svg = body.firstChild
  if (!(svg instanceof SVGSVGElement) || svg.namespaceURI !== SVG_NS) return undefined

  // The backstop: the same reference rule over the finished tree, in case a future DOMPurify
  // stops calling the hook for some attribute. It should find nothing.
  for (const element of [svg, ...svg.querySelectorAll('*')]) {
    for (const attribute of [...element.attributes]) {
      const why = rejection(element, attribute.name, attribute.value)
      if (why === undefined) continue
      element.removeAttributeNode(attribute)
      removed[why] += 1
    }
  }
  return svg
}

function countElement(element: Element, removed: RemovedCounts): void {
  const name = element.localName.toLowerCase()
  if (name === 'script') removed.scripts += 1
  else if (EMBEDDED.has(name)) removed.embeddedContent += 1
  else if (ANIMATIONS.has(name)) removed.animations += 1
  else removed.otherElements += 1
}

function countAttribute(element: Element, attribute: Attr, removed: RemovedCounts): void {
  removed[rejection(element, attribute.name, attribute.value) ?? 'otherAttributes'] += 1
}

/**
 * Whether a declaration may stay: an allowed property, with a value that cannot fetch and is
 * not sized by the viewport. A custom property is never allowed: it is opaque until `var()`
 * substitutes it, and drawing tools write none.
 */
function safeDeclaration(property: string, value: string): boolean {
  return allowedProperty(property) && safeValue(value) && !VIEWPORT_UNIT.test(value)
}

/**
 * Removes every unsafe declaration from a parsed declaration block, returning how many went.
 *
 * A longhand whose value is empty belongs to a shorthand that holds a `var()` the browser has
 * not substituted yet. Its real value is unknowable here, so it goes too.
 */
function filterDeclarations(style: CSSStyleDeclaration, reachesRoot = false): number {
  const doomed = new Set<string>()
  let pending = 0
  for (let i = 0; i < style.length; i += 1) {
    const property = style.item(i)
    const value = style.getPropertyValue(property)
    if (value === '') pending += 1
    const paintsOutside =
      reachesRoot && ROOT_PAINT_EFFECTS.some((effect) => property.startsWith(effect))
    if (value === '' || paintsOutside || !safeDeclaration(property, value)) doomed.add(property)
  }
  for (const property of doomed) style.removeProperty(property)
  // The longhands of a `var()` shorthand were one declaration as written, so they count once.
  return pending > 0 ? doomed.size - pending + 1 : doomed.size
}

/**
 * Filters the CSS a plan carries, in `<style>` elements and `style` attributes.
 *
 * **Why keep CSS at all.** Illustrator and Inkscape style by class, and a plan without its
 * stylesheet renders as black shapes. The shadow root it renders in keeps its rules off the
 * application; what is left to stop is CSS that fetches.
 *
 * **Why the browser's parser** (`CSSStyleSheet.replaceSync`, `element.style`) **and not a
 * tokenizer of our own.** What matters is what the browser will do with the text, so the
 * browser is asked. A hand-rolled CSS tokenizer is a grammar re-implemented, and every place it
 * disagrees with the real one is a bypass (lesson L49). The filtered rules are written back from
 * the parser's own serialisation.
 */
function filterStyles(svg: SVGSVGElement, removed: RemovedCounts): void {
  // Whether a rule can reach the root is the browser's question, so the browser answers it,
  // with the root where it will render: alone in a shadow root, with no element parent. A
  // selector such as `svg:not(body > *)` matches there and nowhere else. A selector `matches`
  // refuses (a pseudo-element) is treated as matching.
  const parent = svg.parentNode
  const scratch = svg.ownerDocument.createElement('div').attachShadow({ mode: 'open' })
  scratch.append(svg)
  const reachesRoot = (selector: string) => {
    try {
      return svg.matches(selector)
    } catch {
      return true
    }
  }
  for (const element of [...svg.getElementsByTagNameNS(SVG_NS, 'style')]) {
    const text = element.textContent ?? ''
    const sheet = new CSSStyleSheet()
    // `replaceSync` drops `@import` without a trace (constructed sheets may not import), so the
    // count is taken from the text. Counting only; what is kept comes from the parsed rules.
    removed.styleRules += text.match(/@import\b/gi)?.length ?? 0
    sheet.replaceSync(text)
    const kept: string[] = []
    for (const rule of sheet.cssRules) {
      // Every at-rule goes: `@font-face` and `@import` fetch, `@namespace` and `@media` are not
      // worth an argument for a floor plan, and the list of at-rules keeps growing.
      // A selector reaching the shadow host restyles the application around the plan.
      if (!(rule instanceof CSSStyleRule) || ESCAPING_SELECTOR.test(rule.selectorText)) {
        removed.styleRules += 1
        continue
      }
      // Nested rules (CSS nesting) go too, rather than being filtered recursively.
      while (rule.cssRules.length > 0) {
        rule.deleteRule(0)
        removed.styleRules += 1
      }
      removed.styleRules += filterDeclarations(rule.style, reachesRoot(rule.selectorText))
      kept.push(rule.cssText)
    }
    if (kept.length > 0) element.textContent = kept.join('\n')
    else element.remove()
  }
  parent?.appendChild(svg)

  for (const element of [svg, ...svg.querySelectorAll('[style]')]) {
    if (!(element instanceof SVGElement) || !element.hasAttribute('style')) continue
    removed.styleRules += filterDeclarations(element.style)
    if (element.style.length > 0) element.setAttribute('style', element.style.cssText)
    else element.removeAttribute('style')
  }
}
