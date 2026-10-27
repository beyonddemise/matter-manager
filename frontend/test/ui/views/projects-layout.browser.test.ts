// The theme and the application's stylesheet, as `main.ts` loads them. Without them there is no
// layout to measure: every claim in this file is about geometry that only exists once the row's
// CSS applies.
import '@awesome.me/webawesome-pro/dist/styles/webawesome.css'
import '@awesome.me/webawesome-pro/dist/styles/themes/glossy.css'
import '@awesome.me/webawesome-pro/dist/styles/color/palettes/anodized.css'
import '@awesome.me/webawesome-pro/dist/components/button/button.js'
import '@awesome.me/webawesome-pro/dist/components/icon/icon.js'
import '@awesome.me/webawesome-pro/dist/components/input/input.js'
import '@awesome.me/webawesome-pro/dist/components/tag/tag.js'
import { waitUntil } from '@open-wc/testing-helpers'
import { afterEach, describe, expect, it } from 'vitest'
import type { LocalProjectEntry } from '../../../src/data/index.js'
import { useBundledIcons } from '../../../src/ui/icons/library.js'
import type { Project } from '../../../src/ui/projects.js'
import type { ProjectsInput } from '../../../src/ui/projects-model.js'
import '../../../src/ui/styles/app.css'
import type { ProjectsView } from '../../../src/ui/views/projects.js'
import '../../../src/ui/views/projects.js'

/**
 * #281: a project row takes **one line** at phone width, and an empty slot is the same height as
 * a filled row — the member layout's premise is counting by looking, which only works while every
 * slot, filled or not, is the same shape.
 *
 * Everything here is measured geometry at 360px (the narrow phone the issue's width math uses),
 * through the page's real stylesheets. The host `<div>` plays the part of the main column, the
 * same arrangement `account.browser.test.ts` uses for its phone-width claims.
 */

useBundledIcons()

const WIDTH = 360

const entry = (over: Partial<LocalProjectEntry> = {}): LocalProjectEntry => ({
  dbName: 'project_local_a',
  name: 'Alpha',
  createdAt: '2026-10-01T09:00:00.000Z',
  ...over,
})

const project = (over: Partial<Project> = {}): Project => ({
  projectId: 'p1',
  dbName: 'project_p1',
  name: 'Beta',
  role: 'owner',
  owner: { ownerType: 'user', ownerId: 'user-1' },
  archived: false,
  ...over,
})

/** A member-plan input with one local row, one synced row and one empty slot. */
const memberInput = (over: Partial<ProjectsInput> = {}): ProjectsInput => ({
  local: [entry(), entry({ dbName: 'project_p1', name: 'Beta', projectId: 'p1' })],
  server: [project()],
  plan: 'member',
  reportedLimit: 3,
  session: 'signed-in',
  online: true,
  syncStates: (id) => (id === 'p1' ? 'idle' : undefined),
  ...over,
})

let host: HTMLDivElement | undefined

afterEach(() => {
  host?.remove()
  host = undefined
})

/** The page inside a host of the given width, rendered and settled enough to measure. */
async function pageAt(width: number, input: ProjectsInput): Promise<ProjectsView> {
  host = document.createElement('div')
  host.style.width = `${width}px`
  document.body.appendChild(host)
  const view = document.createElement('projects-view') as ProjectsView
  view.input = input
  host.appendChild(view)
  await view.updateComplete
  // Web Awesome's components render asynchronously; measuring before the input and the buttons
  // have a height would compare nothing to nothing.
  await waitUntil(
    () => {
      const field = view.querySelector('[data-slot-empty] wa-input')
      const open = view.querySelector('[data-row] [data-open]')
      return (
        field !== null &&
        open !== null &&
        field.getBoundingClientRect().height > 0 &&
        open.getBoundingClientRect().height > 0
      )
    },
    'the rows never took shape',
    { timeout: 4000 },
  )
  await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))
  return view
}

const find = <T extends Element = HTMLElement>(root: Element, selector: string): T => {
  const found = root.querySelector(selector)
  if (found === null) throw new Error(`Nothing matches ${selector}`)
  return found as T
}

const rect = (element: Element): DOMRect => element.getBoundingClientRect()

/** Whether two elements share a line: their vertical extents overlap. */
const onOneLine = (a: Element, b: Element): boolean => {
  const ra = rect(a)
  const rb = rect(b)
  return ra.top < rb.bottom && rb.top < ra.bottom
}

/** A row's full horizontal budget is respected: nothing scrolls out of it sideways. */
function expectNoHorizontalOverflow(row: HTMLElement): void {
  expect(row.scrollWidth, 'the row overflows sideways').toBeLessThanOrEqual(row.clientWidth)
}

describe('a member row at 360px (#281)', () => {
  it('keeps a filled row on one line, with no horizontal overflow', async () => {
    const view = await pageAt(WIDTH, memberInput())

    for (const key of ['project_local_a', 'project_p1']) {
      const row = find(view, `[data-row="${key}"]`)
      const name = find(row, '[data-name]')
      // Open and the actions menu sit on the same line as the name, not under it.
      expect(onOneLine(name, find(row, '[data-open]')), `${key}: Open left the line`).toBe(true)
      expect(
        onOneLine(name, find(row, '[data-actions-trigger]')),
        `${key}: the menu left the line`,
      ).toBe(true)
      expectNoHorizontalOverflow(row)
    }
    // The host plays the main column; nothing may scroll out of it sideways either.
    expect(host?.scrollWidth).toBeLessThanOrEqual(WIDTH)
  })

  it('gives an empty slot one line of the same height as a filled row', async () => {
    const view = await pageAt(WIDTH, memberInput())

    const filled = find(view, '[data-row="project_p1"]')
    const empty = find(view, '[data-slot-empty]')
    expect(onOneLine(find(empty, 'wa-input'), find(empty, '[data-create]'))).toBe(true)
    expectNoHorizontalOverflow(empty)
    // The layout's premise: every slot the same shape, so the count reads at a glance.
    expect(Math.abs(rect(empty).height - rect(filled).height)).toBeLessThan(1)
  })

  it('truncates a long name with an ellipsis and keeps the full name recoverable', async () => {
    const name = 'Hillside Residence Renovation with an Uncommonly Elaborate Project Name'
    const view = await pageAt(
      WIDTH,
      memberInput({ local: [entry({ name })], server: [], syncStates: () => undefined }),
    )

    const row = find(view, '[data-row="project_local_a"]')
    const span = find(row, '[data-name]')
    // Actually truncated (the text is wider than its box), not wrapped onto further lines.
    expect(span.scrollWidth).toBeGreaterThan(span.clientWidth)
    expect(getComputedStyle(span).textOverflow).toBe('ellipsis')
    // And recoverable without opening anything: the title holds the whole name.
    expect(span.getAttribute('title')).toBe(name)
    expect(onOneLine(span, find(row, '[data-open]'))).toBe(true)
    expectNoHorizontalOverflow(row)
  })

  it('keeps location and sync as named, visible affordances without the words', async () => {
    const view = await pageAt(WIDTH, memberInput())

    const local = find(view, '[data-row="project_local_a"] [data-location]')
    const synced = find(view, '[data-row="project_p1"] [data-location]')
    const sync = find(view, '[data-row="project_p1"] [data-sync]')
    // The words stay in the tags for assistive technology — the existing translation units,
    // not new ones.
    expect(local.textContent).toContain('On this device')
    expect(synced.textContent).toContain('Synchronized')
    expect(sync.textContent).toContain('Synced')
    // Sighted readers get a state each per icon and colour, with no hover needed: the status
    // bar's own vocabulary for sync, and the laptop/cloud pair for where a copy lives.
    expect(local.querySelector('wa-icon[name="laptop"]')).not.toBeNull()
    expect(synced.querySelector('wa-icon[name="arrows-rotate"]')).not.toBeNull()
    expect(sync.querySelector('wa-icon[name="circle-check"]')).not.toBeNull()
    expect(sync.getAttribute('variant')).toBe('success')
    // At this width the words are clipped out of the visible line...
    for (const words of view.querySelectorAll('[data-row] .app-tag-words')) {
      expect(rect(words).width).toBeLessThanOrEqual(1)
    }
  })

  it('shows the words again where they fit', async () => {
    const view = await pageAt(700, memberInput())

    const words = find(view, '[data-row="project_local_a"] [data-location] .app-tag-words')
    expect(rect(words).width).toBeGreaterThan(10)
    expect(onOneLine(find(view, '[data-row="project_local_a"] [data-name]'), words)).toBe(true)
  })

  it('keeps rename on the row and Open at least 24px square (WCAG 2.2 AA)', async () => {
    const view = await pageAt(WIDTH, memberInput())

    const row = find(view, '[data-row="project_p1"]')
    const pen = rect(find(row, '[data-rename]'))
    expect(pen.width).toBeGreaterThanOrEqual(24)
    expect(pen.height).toBeGreaterThanOrEqual(24)
    const open = rect(find(row, '[data-open]'))
    expect(open.width).toBeGreaterThanOrEqual(24)
    expect(open.height).toBeGreaterThanOrEqual(24)
  })

  it('lays out a "Shared with me" row the same way', async () => {
    const view = await pageAt(
      WIDTH,
      memberInput({
        server: [
          project(),
          project({
            projectId: 'p2',
            dbName: 'project_p2',
            name: 'Theirs',
            role: 'write',
            owner: { ownerType: 'user', ownerId: 'them' },
          }),
        ],
      }),
    )

    const row = find(view, '[data-shared] [data-row="project_p2"]')
    const name = find(row, '[data-name]')
    expect(onOneLine(name, find(row, '[data-actions-trigger]'))).toBe(true)
    expectNoHorizontalOverflow(row)
    // The shared row keeps the slot shape, so the two lists read as one system.
    const owned = find(view, '[data-row="project_p1"]')
    expect(Math.abs(rect(row).height - rect(owned).height)).toBeLessThan(1)
  })
})
