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
  /** `href`s that are not a local fragment, and `url()`s in attributes that leave the document. */
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
 */
const CONFIG: Config & { RETURN_DOM: true } = {
  USE_PROFILES: { svg: true, svgFilters: true },
  ADD_TAGS: ['use'],
  FORBID_TAGS: FORBIDDEN_ELEMENTS,
  KEEP_CONTENT: false,
  RETURN_DOM: true,
}

/**
 * Raster images a plan may embed. Never `data:image/svg+xml`: that is a plan inside the plan,
 * which this sanitiser would never see.
 */
const RASTER_DATA_URL = /^data:image\/(?:png|jpeg|webp|gif)[;,]/i

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
  'url',
])

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
  removeReservedNames(root, removed)
  unwrapLinks(root, removed)
  const svg = purify(root, removed)
  if (svg === undefined) return refuse({ kind: 'nothing-drawable' })
  filterStyles(svg, removed)
  normaliseGeometry(svg, viewBox)

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
  for (const element of [...root.querySelectorAll('*')]) {
    if (!element.isConnected) continue
    if (reserved(element.getAttribute('id') ?? '')) {
      element.remove()
      removed.reservedNames += 1
      continue
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
    link.replaceWith(...link.childNodes)
    removed.links += 1
  }
}

/** Lowercased, with every whitespace and control character removed, as a URL parser sees it. */
const squash = (value: string) =>
  // biome-ignore lint/suspicious/noControlCharactersInRegex: removing controls is the point.
  value.replace(/[\u0000- \u007f-\u009f]/g, '').toLowerCase()

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
): 'eventHandlers' | 'unsafeUrls' | 'externalReferences' | undefined {
  const lower = name.toLowerCase()
  if (lower.startsWith('on')) return 'eventHandlers'
  const squashed = squash(value)
  const isHref = lower === 'href' || lower === 'xlink:href'
  if (isHref && element.localName === 'image' && RASTER_DATA_URL.test(squashed)) return undefined
  if (UNSAFE_SCHEME.test(squashed)) return 'unsafeUrls'
  // Only a fragment: the plan may point into itself (`<use href="#door">`) and nowhere else.
  // A relative path is as external as an absolute one, resolved against this application.
  if (isHref && !squashed.startsWith('#')) return 'externalReferences'
  if (lower === 'xml:base') return 'externalReferences'
  if (lower !== 'style' && squashed.includes('url(') && !onlyFragmentUrls(squashed))
    return 'externalReferences'
  return undefined
}

/** Whether every `url(` in a squashed value points at a fragment of this document. */
const onlyFragmentUrls = (squashed: string) =>
  [...squashed.matchAll(/url\(/g)].every((match) =>
    /^url\(["']?#/.test(squashed.slice(match.index)),
  )

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

/** Whether a declaration may stay: no custom properties, no escapes, only safe functions. */
function safeDeclaration(property: string, value: string): boolean {
  // A custom property is opaque until `var()` substitutes it, and escapes can spell `url(`
  // in a way only the substitution reveals. Plans from drawing tools use neither.
  if (property.startsWith('--') || value.includes('\\')) return false
  const lower = value.toLowerCase()
  for (const match of lower.matchAll(/([a-z-]+)\(/g)) {
    const name = match[1] ?? ''
    if (!SAFE_CSS_FUNCTIONS.has(name)) return false
    if (name === 'url' && !/^url\(\s*["']?#/.test(lower.slice(match.index))) return false
  }
  return true
}

/**
 * Removes every unsafe declaration from a parsed declaration block, returning how many went.
 *
 * A longhand whose value is empty belongs to a shorthand that holds a `var()` the browser has
 * not substituted yet. Its real value is unknowable here, so it goes too.
 */
function filterDeclarations(style: CSSStyleDeclaration): number {
  const doomed = new Set<string>()
  let pending = 0
  for (let i = 0; i < style.length; i += 1) {
    const property = style.item(i)
    const value = style.getPropertyValue(property)
    if (value === '') pending += 1
    if (value === '' || !safeDeclaration(property, value)) doomed.add(property)
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
      if (!(rule instanceof CSSStyleRule)) {
        removed.styleRules += 1
        continue
      }
      // Nested rules (CSS nesting) go too, rather than being filtered recursively.
      while (rule.cssRules.length > 0) {
        rule.deleteRule(0)
        removed.styleRules += 1
      }
      removed.styleRules += filterDeclarations(rule.style)
      kept.push(rule.cssText)
    }
    if (kept.length > 0) element.textContent = kept.join('\n')
    else element.remove()
  }

  for (const element of [svg, ...svg.querySelectorAll('[style]')]) {
    if (!(element instanceof SVGElement) || !element.hasAttribute('style')) continue
    removed.styleRules += filterDeclarations(element.style)
    if (element.style.length > 0) element.setAttribute('style', element.style.cssText)
    else element.removeAttribute('style')
  }
}
