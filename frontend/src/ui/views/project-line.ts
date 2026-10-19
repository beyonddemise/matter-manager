/**
 * The line under a page heading that says which project the page shows: "Project Hillside".
 *
 * One template for the Devices and Rooms pages, so the two cannot drift apart. The name comes
 * from the shell (`ViewHost.projectName`), which already knows it for the status bar.
 *
 * @module
 */

import { msg, str } from '@lit/localize'
import { html, nothing } from 'lit'

/**
 * "Project <name>", or nothing when the open project has no name to show.
 *
 * Nothing rather than "Project " for an unnamed one: the first-run catalogue, before it is
 * adopted into the project list, has no name yet, and a label with nothing after it reads as a
 * fault.
 *
 * @param name the open project's name, `''` when it has none
 */
export function projectLine(name: string) {
  return name === ''
    ? nothing
    : html`<p class="app-empty" data-project-name>
        ${msg(str`Project ${name}`, { desc: 'Under the Devices and Rooms headings: which project the page shows.' })}
      </p>`
}
