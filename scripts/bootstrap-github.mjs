#!/usr/bin/env node
/**
 * Creates the GitHub labels, milestones and issues described by this repository.
 *
 *   node scripts/bootstrap-github.mjs --dry-run   # print what would happen, change nothing
 *   node scripts/bootstrap-github.mjs             # apply
 *
 * Sources:
 *   .github/labels.yml      label taxonomy
 *   docs/backlog/*.md       one milestone per file, one issue per `## ` heading
 *
 * IDEMPOTENT. Existing labels are updated, existing milestones reused, and issues whose
 * title already exists are skipped rather than duplicated — so a partial run can simply be
 * repeated. That matters more than it sounds: the failure mode of a non-idempotent bootstrap
 * is fifty duplicate issues, and the only remedy is closing them by hand.
 *
 * Written with no dependencies (ADR 0013), including the small amount of YAML reading it
 * needs. `gh` supplies authentication and the repository context.
 */

import { execFileSync } from 'node:child_process'
import { readdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const DRY = process.argv.includes('--dry-run')

const gh = (args, { allowFail = false } = {}) => {
  try {
    return execFileSync('gh', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
  } catch (err) {
    if (allowFail) return null
    throw new Error(`gh ${args.join(' ')}\n${err.stderr || err.message}`)
  }
}

const act = (what, fn) => {
  if (DRY) {
    console.log(`  would ${what}`)
    return null
  }
  console.log(`  ${what}`)
  return fn()
}

// ---------------------------------------------------------------- labels

/**
 * Reads the small, fixed subset of YAML in labels.yml: a list of maps with scalar values.
 * A full YAML parser would be a dependency for something this shape does not need.
 */
function readLabels() {
  const text = readFileSync(join(root, '.github/labels.yml'), 'utf8')
  const labels = []
  let current = null
  for (const raw of text.split('\n')) {
    const line = raw.replace(/\s+$/, '')
    if (line.trim() === '' || line.trimStart().startsWith('#')) continue
    const item = line.match(/^- (\w+):\s*(.*)$/)
    if (item) {
      if (current) labels.push(current)
      current = { [item[1]]: unquote(item[2]) }
      continue
    }
    const field = line.match(/^\s+(\w+):\s*(.*)$/)
    if (field && current) current[field[1]] = unquote(field[2])
  }
  if (current) labels.push(current)
  return labels
}

const unquote = (s) => s.replace(/^['"]|['"]$/g, '')

// ---------------------------------------------------------------- backlog

/** One milestone per file; `## ` headings become issues. */
function readBacklog() {
  const dir = join(root, 'docs/backlog')
  return readdirSync(dir)
    .filter((f) => /^milestone-.+\.md$/.test(f))
    .sort()
    .map((file) => {
      const text = readFileSync(join(dir, file), 'utf8')
      const h1 = text.match(/^# (.+)$/m)
      if (!h1) throw new Error(`${file}: no H1 milestone heading`)
      // "M2 — Local catalogue" -> "M2 Local catalogue"
      const milestone = h1[1].replace(/\s*[—–-]\s*/, ' ').trim()

      const issues = []
      // Split on issue headings, keeping the heading with its body.
      const parts = text.split(/\n(?=## )/).slice(1)
      for (const part of parts) {
        const head = part.match(/^## (.+)$/m)
        if (!head) continue
        const raw = head[1].trim()
        const done = raw.includes('✅')
        // "M2-1 · Confirm coverage" -> "M2-1 Confirm coverage"
        const title = raw
          .replace(/✅/g, '')
          .replace(/\s*·\s*/, ' ')
          .trim()
        const body = part.slice(part.indexOf('\n') + 1).trim()
        issues.push({ title, body, done, labels: extractLabels(part) })
      }
      return { file, milestone, issues }
    })
}

/** Labels are the backticked `type:` / `area:` / `size:` / bare tokens under the heading. */
function extractLabels(section) {
  const line = section
    .split('\n')
    .find((l) => /^`(type|area|size|security|blocked):?/.test(l.trim()))
  if (!line) return []
  return [...line.matchAll(/`([^`]+)`/g)].map((m) => m[1]).filter((l) => !l.includes(' '))
}

// ---------------------------------------------------------------- apply

console.log(DRY ? 'DRY RUN — nothing will be changed\n' : 'Applying to GitHub\n')

const repo = gh(['repo', 'view', '--json', 'nameWithOwner', '-q', '.nameWithOwner']).trim()
console.log(`Repository: ${repo}\n`)

console.log('Labels')
const existingLabels = new Set(
  JSON.parse(gh(['label', 'list', '--limit', '200', '--json', 'name'])).map((l) => l.name),
)
for (const label of readLabels()) {
  const verb = existingLabels.has(label.name) ? 'update' : 'create'
  act(`${verb} label ${label.name}`, () =>
    gh([
      'label',
      'create',
      label.name,
      '--color',
      label.color,
      '--description',
      label.description ?? '',
      '--force',
    ]),
  )
}

console.log('\nMilestones')
const milestoneNumbers = new Map()
const existingMilestones = JSON.parse(
  gh(['api', 'repos/{owner}/{repo}/milestones?state=all&per_page=100']),
)
for (const m of existingMilestones) milestoneNumbers.set(m.title, m.number)

const backlog = readBacklog()
for (const { milestone } of backlog) {
  if (milestoneNumbers.has(milestone)) {
    console.log(`  exists: ${milestone}`)
    continue
  }
  act(`create milestone ${milestone}`, () => {
    const created = JSON.parse(
      gh(['api', 'repos/{owner}/{repo}/milestones', '-f', `title=${milestone}`]),
    )
    milestoneNumbers.set(milestone, created.number)
  })
}

console.log('\nIssues')
const existingIssues = new Set(
  JSON.parse(gh(['issue', 'list', '--state', 'all', '--limit', '500', '--json', 'title'])).map(
    (i) => i.title,
  ),
)

let created = 0
let skipped = 0
for (const { milestone, issues } of backlog) {
  console.log(`\n  ${milestone}`)
  for (const issue of issues) {
    if (existingIssues.has(issue.title)) {
      console.log(`    exists: ${issue.title}`)
      skipped++
      continue
    }
    const labels = issue.labels.length ? issue.labels : ['type:chore']
    act(`create: ${issue.title}${issue.done ? '  (then close - already done)' : ''}`, () => {
      const args = [
        'issue',
        'create',
        '--title',
        issue.title,
        '--body',
        issue.body,
        '--milestone',
        milestone,
      ]
      for (const l of labels) args.push('--label', l)
      const url = gh(args).trim()
      // M0 issues completed during setup are recorded and closed, so the milestone
      // reflects what happened rather than looking untouched.
      if (issue.done) gh(['issue', 'close', url, '--reason', 'completed'], { allowFail: true })
    })
    created++
  }
}

console.log(
  `\n${DRY ? 'Would create' : 'Created'} ${created} issue(s); ${skipped} already existed.`,
)
if (DRY) console.log('Re-run without --dry-run to apply.')
