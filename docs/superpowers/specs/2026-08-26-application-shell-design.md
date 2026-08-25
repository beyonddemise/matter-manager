# Application shell and routing — design

Date: 2026-08-26
Issue: [#19 M2-2](https://github.com/beyonddemise/matter-manager/issues/19)
Status: proposed

## What this establishes

The first front-end code in the project. `packages/web` currently holds a `package.json` and
nothing else, so this story decides how every later view is reached, laid out, styled and
tested. M2-5 through M2-9, all of M3, and the M2b scanner render inside whatever this defines.

Out of scope, per the issue: authentication and projects (M4/M5). M2 operates on a single
implicit local project.

## Decisions taken before this document

| Decision | Where |
|---|---|
| Lit plus Web Awesome | ADR 0008 |
| Web Awesome **Pro**; contributors need their own licence | ADR 0008, resolved 2026-08-26 |
| Minimal runtime dependencies; the platform first | ADR 0013 |
| Vitest browser mode plus `@open-wc/testing-helpers`, 70% gate for `web` | CONTRIBUTING |
| Every user-visible string wrapped in `msg()` from the first line | CONTRIBUTING |
| Hash-based routing, hand-rolled | this story, decided by the owner |
| `wa-theme-glossy wa-palette-anodized` | this story, chosen from rendered candidates |
| Light/dark toggle with persistence, in this story | this story |
| Navigation shows only sections that exist | this story |

## Layout

`<wa-page>` owns the page. It provides the grid, the sticky regions, the desktop sidebar, the
mobile drawer and its hamburger, and the `html`/`body` reset. None of that is rebuilt by hand:
the Web Awesome design skill names hand-rolling the drawer, and duplicating navigation across
slots, as the two most common failures with this component.

```
┌─ header ────────────────────────────────────┐   brand · scheme toggle
├─ navigation ─┬─ main ───────────────────────┤   nav written ONCE
│  Devices     │  the routed view             │   desktop: sidebar
│              │                              │   mobile:  drawer + hamburger
└──────────────┴──────────────────────────────┘
```

- Navigation lives in `slot="navigation"`, written once. `<wa-page>` renders it as a sidebar on
  desktop and moves it into a drawer below the mobile breakpoint. There is no second copy.
- `--menu-width: 15rem`, reset to `auto` under `wa-page[view='mobile']`. Setting a fixed width
  without the reset reserves an empty band down the left on mobile.
- Navigation links carry `data-drawer="close"` so tapping one on a phone closes the drawer
  rather than leaving it open over the view just navigated to.
- The header carries its own `data-toggle-nav` button rather than relying on the built-in
  hamburger, which renders before the header slot content and wraps onto its own row.
- `view` is read-only. It is read in CSS; it is never set, and no initial render depends on it.

## Routing

Hash-based, hand-rolled, and split so that the part which can be wrong is testable without a
browser.

```
src/router/match.ts    pure     matchRoute(hash, routes) → { route, params } | null
src/router/routes.ts   data     the registry: one entry per section
src/app-shell.ts       Lit      listens to hashchange, renders the matched view
```

`matchRoute` is a pure function over strings. It is unit-tested in the node environment exactly
like `packages/core`, at `core`-level rigour, because an off-by-one in path segmentation is the
kind of error that produces a plausible wrong view rather than an error.

Hash routing was chosen by the owner. It needs no server rewrite rules, which keeps the
Cloudflare Pages deployment in M2-10 to a static upload.

### The registry is the extension point

```ts
export const ROUTES = [
  { path: '/', view: 'device-list', label: () => msg('Devices'), icon: 'lightbulb' },
] as const
```

`matchRoute` supports path parameters (`/devices/:id`) and they are unit-tested against fixture
tables, but **no parameterised route is registered yet** — M2-7 adds the first one, for the
device detail view. Registering `/devices/:id` now would match a path whose view does not exist,
which is worse than not matching it: the shell would resolve a route and then fail to render,
where an unregistered path correctly falls through to not-found.

Navigation renders **from** this table: an entry with a `label` appears in the nav, one without
is reachable but not listed. M3 adding PDF export is one entry plus one view file, and the
navigation picks it up with no further change. That is where the "sections will evolve"
requirement is satisfied — in the registry, not in visible dead links.

**Only Devices exists today, and the navigation therefore has one entry.** That is a
consequence of the decision worth stating rather than softening: M2 has no rooms screen. Rooms
are created inline while adding a device (M2-5), group the list (M2-6), and change when a device
is moved (M2-8) — there is no room-management view in the milestone, so putting "Rooms" in the
navigation would promise a section that does not exist.

A one-entry sidebar looks sparse, and that is the honest state of the application until M2-3
adds a settings surface for the locale preference. The navigation *mechanism* is still fully
exercised: it renders from the registry, the drawer opens and closes on mobile, and the current
entry is marked. Those are what the tests assert, and they do not need a second link to be
meaningful.

### Unknown routes

`matchRoute` returns `null`, and the shell renders a not-found view offering a link back to the
device list, per the issue's second scenario. `null` rather than a `not-found` route entry,
because "no route matched" and "the user asked for the not-found page" are different facts and
conflating them makes the first untestable.

## Theme and colour scheme

`<html class="wa-theme-glossy wa-palette-anodized wa-light">`, chosen by rendering the real
shell with real device rows under four candidate pairs and comparing screenshots.

The scheme is a three-state preference — light, dark, or follow the system — persisted in
`localStorage` and defaulting to `prefers-color-scheme`. It is applied by toggling `wa-light`
and `wa-dark` on the document element. The control sits in the header.

Choosing the **theme and palette** is deliberately not in this story; it is
[#70](https://github.com/beyonddemise/matter-manager/issues/70), and belongs with the locale
preference once M2-3 introduces a settings surface.

### Token discipline

No raw hex, `px` or `rem` literals anywhere in the web package. Colour, spacing, radius, font
size and shadow come from `--wa-*` tokens. Layout uses `wa-stack`, `wa-cluster`, `wa-grid`,
`wa-split` rather than hand-written flexbox.

Styling a Web Awesome component goes through its documented API in this order: attributes, then
the component's own custom properties, then its documented `::part()`. The component's reference
is read first, every time. Setting `background` or `color` on a `<wa-button>` host styles an
invisible wrapper while the real surface keeps its default fill; this is the single most common
way Web Awesome styling silently fails.

**One known issue to fix rather than inherit:** during the theme comparison, the brand button
rendered with a pale fill and a low-contrast label under `premium` in light mode and under
`matter` in dark mode. `glossy`/`anodized` did not show it, but the contrast of branded
controls is to be checked in both schemes rather than assumed.

## Internationalisation

Every user-visible string is wrapped in `msg()` from `@lit/localize` from the first line
written, including navigation labels — hence `label: () => msg('Devices')` in the registry
rather than a plain string, so the label re-evaluates when the locale changes.

M2-3 adds the German catalogue and the locale switcher. This story does not, but it must not
create strings that M2-3 then has to hunt for.

## Testing

| Unit | How | Environment |
|---|---|---|
| `matchRoute` | pure function over strings | node |
| `ROUTES` | the table is well-formed; every path unique; every `view` resolvable | node |
| `<app-shell>` | renders the matched view, handles unknown paths, toggles scheme | browser |
| Navigation | renders one entry per labelled route, marks the current one, drawer opens and closes | browser |

Browser tests use Vitest browser mode with `@open-wc/testing-helpers`, per CONTRIBUTING. This
adds `@vitest/browser` and `playwright` as **devDependencies**. Development dependencies are
not restricted by `dependency-policy.json` — they do not ship — but this is new tooling and is
called out rather than slipped in.

`vitest.config.ts` gains a `web` project alongside `core`, and the coverage gate becomes
per-project: `core` stays at 90%, `web` at 70%. The current global 90% is `core`'s alone and UI
code will not meet it.

Responsive behaviour is asserted at the two widths that matter — the sidebar present on desktop,
the drawer mechanism present on mobile — rather than by screenshot comparison, which is
brittle and slow at this stage.

## Files

```
packages/web/
  index.html                    <wa-page>, theme classes, html/body reset
  src/
    main.ts                     boot: scheme preference, locale, mount
    app-shell.ts                <app-shell>: routing outlet, header, nav
    router/
      match.ts                  pure matchRoute
      routes.ts                 the registry
    views/
      device-list.ts            placeholder until M2-6
      not-found.ts
    styles/
      tokens.css                the three theme classes and nothing else
  test/
    router/match.test.ts        node
    app-shell.test.ts           browser
  vite.config.ts
```

`device-list.ts` exists because the shell needs something to route to. It renders a heading and
an empty state; M2-6 replaces its contents without touching the shell.

## What could go wrong

**The nav is duplicated.** The failure is visual — links appearing twice — and the fix is to
keep exactly one `slot="navigation"`. Verified by a test asserting the count of rendered nav
links equals the count of labelled routes.

**A component is styled through its host rather than its part.** The failure is silent: the
declaration lands on a wrapper and the visible surface is unchanged. Mitigated by reading each
component's reference before styling it, and by looking at the rendered result.

**Hash routing and the scanner.** M2b's camera flow may want a URL it can return to. Hash routes
survive reload, so this is expected to be fine, but it is the one place the choice could bite.

**Coverage gate.** Splitting the gate per project means `core`'s 90% must not silently become the
global default for a package that cannot meet it, nor `web`'s 70% silently weaken `core`.
Asserted by checking both numbers appear in the config, and by the existing discipline of
proving a gate can fail before trusting it (lesson L8).

## Verification

`npm run verify` green. The shell rendered and looked at in a real browser at desktop and mobile
widths, in both colour schemes, with the console clean. An independent subagent review against
the Web Awesome design skill's checklist, which that skill requires and which is not optional.
