/**
 * The projects page's small mechanics, kept apart from its markup so each is tested directly:
 * how the table sorts, and how a field is read and cleared.
 *
 * @module
 */

import type { Row } from '../projects-model.js'

/** Which column the pro table is sorted by, and which way. */
export interface Sort {
  readonly by: 'name' | 'client'
  readonly ascending: boolean
}

/** The value of a field inside `container`, trimmed; empty when there is no such field. */
export function fieldValue(container: Element | null, field: string): string {
  const control = container?.querySelector(`[data-field="${field}"]`) as { value?: unknown } | null
  return typeof control?.value === 'string' ? control.value.trim() : ''
}

/**
 * Empties every field inside `container`.
 *
 * After a create: Lit reuses an empty slot's or the dialog's elements for the next render, and
 * a field's typed value is the element's own state, not something the template binds — so
 * without this the next "Add project" opens pre-filled with the project just created.
 */
export function clearFields(container: Element | null): void {
  for (const control of container?.querySelectorAll('[data-field]') ?? []) {
    ;(control as { value?: unknown }).value = ''
  }
}

/** Rows sorted by a column, ties broken by name and then by key so the order is stable. */
export function sortRows(rows: readonly Row[], sort: Sort): Row[] {
  const direction = sort.ascending ? 1 : -1
  return [...rows].sort(
    (a, b) =>
      direction * (a[sort.by] ?? '').localeCompare(b[sort.by] ?? '') ||
      a.name.localeCompare(b.name) ||
      a.key.localeCompare(b.key),
  )
}
