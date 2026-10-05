---
name: Matter Manager
description: Never lose a Matter commissioning QR code again.
colors:
  commissioning-blue: "#0152c1"
  commissioning-blue-deep: "#003ea2"
  commissioning-blue-mist: "#e5f6ff"
  commissioning-blue-night: "#001853"
  commissioning-blue-lamp: "#5db7f3"
  focus-blue: "#309aee"
  page-white: "#ffffff"
  graphite-ink: "#1d1d1d"
  graphite-quiet: "#595959"
  page-shadow-grey: "#f2f2f2"
  page-rule: "#e6e6e6"
  control-edge: "#959595"
  placeholder-grey: "#757575"
  basement-black: "#121212"
  basement-raised: "#1d1d1d"
  basement-rule: "#323232"
  basement-ink: "#f2f2f2"
  basement-quiet: "#959595"
  signal-green: "#1b6548"
  signal-green-mist: "#ebf6e0"
  signal-green-edge: "#96db86"
  signal-green-night: "#032317"
  signal-green-lamp: "#4aa672"
  caution-amber: "#7f4d29"
  caution-amber-mist: "#faf3e1"
  caution-amber-edge: "#eac673"
  caution-amber-night: "#2f1809"
  caution-amber-lamp: "#bf8b4a"
  fault-red: "#89453f"
  fault-red-mist: "#ffefee"
  fault-red-edge: "#fabab8"
  fault-red-night: "#331512"
  fault-red-lamp: "#d47c7e"
typography:
  headline:
    fontFamily: "Figtree, sans-serif"
    fontSize: "41px"
    fontWeight: 800
    lineHeight: 1.35
    letterSpacing: "-0.02em"
  title:
    fontFamily: "Figtree, sans-serif"
    fontSize: "32px"
    fontWeight: 800
    lineHeight: 1.35
    letterSpacing: "-0.02em"
  title-small:
    fontFamily: "Figtree, sans-serif"
    fontSize: "20px"
    fontWeight: 800
    lineHeight: 1.35
    letterSpacing: "-0.02em"
  body:
    fontFamily: "Figtree, sans-serif"
    fontSize: "16px"
    fontWeight: 400
    lineHeight: 1.8
  body-small:
    fontFamily: "Figtree, sans-serif"
    fontSize: "14px"
    fontWeight: 400
    lineHeight: 1.8
  label:
    fontFamily: "Figtree, sans-serif"
    fontSize: "14px"
    fontWeight: 600
    lineHeight: 1.35
  code:
    fontFamily: "Chivo Mono, monospace"
    fontSize: "20px"
    fontWeight: 400
rounded:
  s: "4px"
  m: "8px"
  l: "16px"
  pill: "9999px"
spacing:
  3xs: "2.25px"
  2xs: "4.5px"
  xs: "9px"
  s: "13.5px"
  m: "18px"
  l: "27px"
  xl: "36px"
  5xl: "90px"
components:
  button-primary:
    backgroundColor: "{colors.commissioning-blue}"
    textColor: "{colors.page-white}"
    typography: "{typography.label}"
    rounded: "{rounded.m}"
    padding: "0.75em 1em"
  button-row-action:
    backgroundColor: "{colors.page-rule}"
    textColor: "{colors.graphite-ink}"
    typography: "{typography.label}"
    rounded: "{rounded.m}"
  button-secondary:
    backgroundColor: "{colors.page-white}"
    textColor: "{colors.graphite-ink}"
    typography: "{typography.label}"
    rounded: "{rounded.m}"
  button-destructive:
    backgroundColor: "{colors.fault-red}"
    textColor: "{colors.page-white}"
    typography: "{typography.label}"
    rounded: "{rounded.m}"
  input:
    backgroundColor: "{colors.page-white}"
    textColor: "{colors.graphite-ink}"
    typography: "{typography.body}"
    rounded: "{rounded.m}"
    padding: "0.75em 1em"
  status-tag-success:
    backgroundColor: "{colors.signal-green-mist}"
    textColor: "{colors.signal-green}"
    typography: "{typography.body-small}"
    rounded: "{rounded.m}"
  status-tag-warning:
    backgroundColor: "{colors.caution-amber-mist}"
    textColor: "{colors.caution-amber}"
    typography: "{typography.body-small}"
    rounded: "{rounded.m}"
  status-tag-neutral:
    backgroundColor: "{colors.page-shadow-grey}"
    textColor: "{colors.graphite-quiet}"
    typography: "{typography.body-small}"
    rounded: "{rounded.m}"
  status-tag-danger:
    backgroundColor: "{colors.fault-red-mist}"
    textColor: "{colors.fault-red}"
    typography: "{typography.body-small}"
    rounded: "{rounded.m}"
  nav-item:
    textColor: "{colors.graphite-ink}"
    typography: "{typography.body}"
    rounded: "{rounded.m}"
    padding: "13.5px 18px"
  nav-item-active:
    backgroundColor: "{colors.commissioning-blue-mist}"
    textColor: "{colors.commissioning-blue}"
    rounded: "{rounded.m}"
  card:
    backgroundColor: "{colors.page-white}"
    rounded: "{rounded.l}"
  project-row:
    backgroundColor: "{colors.page-white}"
    rounded: "{rounded.m}"
    padding: "13.5px 18px"
---

# Design System: Matter Manager

## Overview

**Creative North Star: "The Site Logbook"**

Matter Manager is a tradesperson's durable logbook: plain, exact, legible in a dim basement, every entry trustworthy. The interface is the binding and the ruled page, never the story. A project is a line in the book, a device is an entry, a status is a stamp in the margin. Everything a user needs to trust the record (where a copy lives, whether it has synced, whether the network is there at all) is stamped in the same words and the same colours every time it appears.

The mood is polished, tactile and confident. Polish comes from Web Awesome Pro's glossy theme on the anodized palette: buttons carry a lit sheen and press in when tapped, surfaces are quiet whites and graphites, and one saturated blue marks the way forward. Density is moderate: rows are compact enough to scan a pro installer's project list at a desk, and generous enough to hit with a gloved thumb on site. Dark mode is "the basement at night": near-black pages with lamp-lit text, built for a plant room with the light off rather than as an inverted afterthought.

The component philosophy is refined and restrained. The system is stock Web Awesome, used through documented variants, utilities and tokens; the app adds layout and a handful of rules, not a parallel component kit. The app code never names a colour or a pixel: it references `--wa-*` tokens, so the user's theme, palette and scheme preferences reach every surface.

**Key Characteristics:**
- Web Awesome Pro, glossy theme, anodized palette, light and dark schemes; theme and palette are user preferences.
- One brand colour, Commissioning Blue, for the primary action, the active navigation item and links.
- One status vocabulary, stamped as small filled tags, identical in the footer status bar and on project rows.
- Figtree throughout, heavy and tightly tracked in headings; Chivo Mono only for codes a person must read aloud or type.
- Two radii: gently rounded controls and rows, softer-cornered panels and dialogs.
- Layered surfaces as the direction: panels lift on soft shadows, buttons are glossy on top.
- A sticky footer status bar on every view; the network state is never hidden.

## Colors

A restrained anodized palette: white and graphite pages, one confident Commissioning Blue, and muted, earthy status hues that read as stamps rather than alarms. The values below are the resolved Web Awesome tokens for the default theme (glossy) and palette (anodized); app code references the `--wa-color-*` token named alongside each one, never the hex.

### Primary
- **Commissioning Blue** (#0152c1, `--wa-color-brand-fill-loud`, `--wa-color-text-link` in light): the loud fill of the primary action ("Add project", "Continue with …", dialog confirms that are not destructive), link text in light mode, and the active navigation item's text. Identical in both schemes as a fill.
- **Commissioning Blue Deep** (#003ea2, `--wa-color-brand-on-normal`): text on the normal brand fill.
- **Commissioning Blue Mist** (#e5f6ff, `--wa-color-brand-fill-quiet`, light): the active navigation item's background; the quiet brand callout.
- **Commissioning Blue Night** (#001853, `--wa-color-brand-fill-quiet`, dark): the same role in the basement-at-night scheme.
- **Commissioning Blue Lamp** (#5db7f3, `--wa-color-text-link`, dark): link text in dark mode.
- **Focus Blue** (#309aee, `--wa-color-focus`): the focus ring in both schemes, and the active nav text and the outlined brand button's border in dark.

### Neutral
- **Page White** (#ffffff, `--wa-color-surface-default` / `-raised`, light): page, header, footer, cards and project rows.
- **Graphite Ink** (#1d1d1d, `--wa-color-text-normal`, light): all body text and headings.
- **Graphite Quiet** (#595959, `--wa-color-text-quiet`, light): secondary text (emails, notes, table heads, footer text, client names) and the neutral tag's text.
- **Page Shadow Grey** (#f2f2f2, `--wa-color-surface-lowered` / `--wa-color-neutral-fill-quiet`, light): the neutral tag's fill (Offline, Local, Sync paused), lowered device rows, link-row hover.
- **Page Rule** (#e6e6e6, `--wa-color-surface-border`, light): borders of rows, table rules, the footer's top rule; the row action button's fill.
- **Control Edge** (#959595, `--wa-color-neutral-border-loud`): the 1px border of inputs and selects.
- **Placeholder Grey** (#757575): input placeholder text in both schemes.
- **Basement Black** (#121212, `--wa-color-surface-default`, dark): the page at night.
- **Basement Raised** (#1d1d1d, `--wa-color-surface-raised`, dark): cards, rows and dialogs at night.
- **Basement Rule** (#323232, `--wa-color-surface-border`, dark): borders and rules at night.
- **Basement Ink** (#f2f2f2, `--wa-color-text-normal`, dark): text at night.
- **Basement Quiet** (#959595, `--wa-color-text-quiet`, dark): secondary text at night.

### Status
Status hues come from the palette's semantic variants and are only ever used to say what state something is in.
- **Signal Green** (#1b6548 on #ebf6e0 light; #4aa672 on #032317 dark; edge #96db86, `--wa-color-success-*`): Online, Synced, Synchronized.
- **Caution Amber** (#7f4d29 on #faf3e1 light; #bf8b4a on #2f1809 dark; edge #eac673, `--wa-color-warning-*`): Sync pending; warning callouts. Offline is not here: offline is normal, so it is neutral grey.
- **Fault Red** (#89453f fill, #89453f on #ffefee light; #d47c7e on #331512 dark; edge #fabab8, `--wa-color-danger-*`): No permission to sync; error callouts; the fill of destructive confirm buttons.

### Named Rules
**The Web Awesome First Rule.** Reach for a Web Awesome component first, then a layout utility (`wa-stack`, `wa-cluster`, `wa-split`, `wa-flank`, `wa-grid`, `wa-gap-*`), then a `--wa-*` token, then the component's documented styling API (attributes, CSS custom properties, `::part()`). App CSS contains no raw hex and no raw px or rem: every colour is a `--wa-color-*` token and every dimension is derived from `--wa-space-*`, so a theme or palette switch reaches everything.

**The One Status Vocabulary Rule.** Status is a small (size s) filled `wa-tag` with a leading icon, and the same state always uses the same words, variant and icon wherever it appears: Online (success, wifi), Offline (neutral, plug-circle-xmark), Local (neutral, laptop), Sync pending (warning, arrows-rotate), Synced (success, circle-check), No permission to sync (danger, triangle-exclamation), Sync paused – signed out (neutral, circle-pause). A status is a label, never a control: it is not focusable, has no hover state, and is never styled as a button.

**The Commissioning Blue Rule.** The loud brand fill marks the one primary action in view. Secondary actions are outlined or neutral; the Upgrade prompt is outlined brand, not filled. Blue elsewhere means "you are here" (the active nav item) or "this goes somewhere" (a link).

**The Withheld Theme Rule.** Theme and palette are user preferences (glossy and anodized by default), offered only where every token pair holds WCAG 2.2 AA (4.5:1) in both schemes. Tailspin, Shoelace and Brutalist are withheld because they fail in light; all ten palettes are offered. A new theme or palette ships only after the contrast test passes for every theme, palette and scheme.

## Typography

**Display Font:** Figtree (with sans-serif), heading weight 800
**Body Font:** Figtree (with sans-serif)
**Label/Mono Font:** Chivo Mono (with monospace), for pairing codes only

**Character:** One humanist sans does all the talking, in two voices: heavy and tightly tracked for headings, plain and roomy for everything else. The mono face appears only where a person must read characters exactly.

All fonts are self-hosted (Figtree 300/400/600/800, Chivo Mono 400) and work offline. The type scale is Web Awesome's 1.125 ratio on a 16px root.

### Hierarchy
- **Headline** (800, 41px, 1.35, -0.02em): the view title (`h1`, "Projects"). One per view.
- **Title** (800, 32px, 1.35, -0.02em): section headings within a view ("Shared with me") and the name on a single-project card.
- **Title Small** (800, 20px, 1.35, -0.02em): room headings and sub-sections.
- **Body** (400, 16px, 1.8): running text, input values, navigation items, project names in tables (semibold 600 for names).
- **Body Small** (400, 14px, 1.8): footer text and links, email addresses, notes, client names on phone rows, tag text (rendered a step smaller inside the tag).
- **Label** (600, 14px, 1.35): table column heads (in Graphite Quiet), form labels, button text.
- **Code** (400, 20px, normal tracking): the numeric pairing code, shown so it can be typed by hand.

### Named Rules
**The Tabular Figures Rule.** Tables use tabular numerals so dates and counts align in columns.

**The Plain Weight Rule.** Weight is the only emphasis: 800 for headings, 600 for names, labels and actions, 400 for everything else. No italics, no uppercase labels, no decorative faces.

## Layout

The shell is Web Awesome's `wa-page`: a header bar, a left navigation column, a fluid main area and a sticky footer status bar. The mobile breakpoint is 768px.

- **Desktop:** header with the product name left and Upgrade, the scheme toggle and the account email right, padded small by medium (13.5px 18px). Navigation column 270px wide (five times the 5xl space step multiplied out, `calc(var(--wa-space-5xl) * 3)`). Main padded large (27px) with no max width; forms and single cards cap at 720px (`calc(var(--wa-space-5xl) * 8)`).
- **Phone (below 768px):** navigation becomes a drawer behind a menu button in the header; header gutter shrinks to small (13.5px); main padding to medium (18px); tables reflow into stacked entries (name and actions, then client, then location and sync tags); dialog footer buttons stack full width with Cancel first. Every view must reflow at 320px.
- **Rhythm:** the space scale is Web Awesome's at 1.125 (2.25, 4.5, 9, 13.5, 18, 27, 36px and up). Lists and rows stack at small gaps; clusters of tags and buttons use extra-small to small gaps; the default content spacing between blocks is large (27px).
- **Footer:** always visible, sticky at the bottom, holding the status tags on the left and the site links (About, Privacy, Terms) on the right on desktop. Page scrolling reserves the footer's height so focused content is never hidden behind it.

## Elevation & Depth

The system's direction is **layered surfaces**: the page is the ground, cards and rows lift above it on soft, short, downward shadows, and buttons sit glossy on top with a lit upper edge and a shaded lower one. Shadows are soft and ambient, never hard-offset.

Where the build stands today:
- **Already layered:** cards (`wa-card`: the free plan's project card, the create and name cards) carry the small shadow; dialogs and dropdown menus float on the large and medium shadows over a dimmed page (50% graphite overlay in light, 60% black in dark).
- **Glossy on top:** every non-plain button carries the glossy sheen; inputs carry a faint top-lit band that clears on focus; checked checkboxes, radios and switch thumbs share the button sheen.
- **Still flat-bordered:** project rows on the member plan (1px Page Rule border, Page White fill, no shadow), the pro projects table (rules between rows only), device rows (Page Shadow Grey fill, no border, no shadow), the header and the footer status bar (1px top rule). These are the surfaces to lift when the direction is applied; until then they must not be described as raised.

### Shadow Vocabulary
- **Small lift** (`box-shadow: var(--wa-shadow-s)`, resolving to `0 0.125rem 0.375rem -0.0625rem` in the theme shadow colour): cards at rest; the target for project rows.
- **Medium lift** (`box-shadow: var(--wa-shadow-m)`, `0 0.25rem 0.75rem -0.125rem`): dropdown menus and popovers.
- **Large lift** (`box-shadow: var(--wa-shadow-l)`, `0 0.5rem 1.5rem -0.25rem`): dialogs.
- **Glossy sheen** (an inset stack: a thin white inner shine at the top, a broad white upper tint, a faint dark lower shade and a 1px dark bottom edge): every non-plain button. Pressed, the highlights flip to inner shadows and the button scales to 98%.

### Named Rules
**The Layered Surfaces Rule.** A surface that holds an entry (a card, a project row) sits above the page on the small shadow; menus and dialogs climb the scale. Depth comes from the theme's shadow tokens only, never from a hand-written shadow.

**The Gloss Belongs To Controls Rule.** The sheen is for things you press (buttons, checked controls). Surfaces, tags and status never carry it.

## Shapes

Two radii carry the whole system. Gently rounded corners (8px, `--wa-border-radius-m`) belong to everything at control scale: buttons, inputs, tags, navigation items, project rows, device rows, the QR plate and the scan preview. Softer corners (16px, `--wa-border-radius-l`, the panel radius) belong to containers: cards and dialogs. Tooltips use the small radius (4px). Tags are rounded rectangles, not pills.

Borders are thin and solid (1px) for structure. A dashed border means "empty or inactive": an empty project slot, a disabled device. Remarks hang off a 2px left rule. Focus is a 3px solid Focus Blue ring offset 1px.

## Components

### Buttons
Glossy, pressable and few.
- **Shape:** gently rounded (8px); height about 2.85em from 0.75em block and 1em inline padding; label in semibold.
- **Primary:** Commissioning Blue fill, white label, glossy sheen; leading icon where it helps ("Add project" with a plus).
- **Hover / Focus:** hover changes tone only (no movement); focus shows the 3px Focus Blue ring; pressed flips the sheen inward and scales to 98% over 75ms.
- **Row action:** "Open" on project rows is a small neutral filled-outlined button, grey in light and graphite in dark, sheen intact.
- **Secondary:** outlined (Cancel, Export, Edit). Upgrade is a small outlined brand button with a rocket icon.
- **Destructive:** the danger variant (Fault Red fill, white label), only ever as the confirm button inside a dialog that names the consequence.
- **Plain:** icon-only controls (menu, scheme toggle, rename pen, row kebab, close) are plain buttons with no sheen and an accessible label.

### Chips
Status tags, per The One Status Vocabulary Rule.
- **Style:** small (size s), rounded rectangle (8px), leading icon, text a step smaller than body. In the footer status bar the tag is filled: quiet fill (mist) with on-quiet text and no border. On project rows the location and sync tags use the default filled-outlined appearance: the same fill and text plus a thin edge in the variant's border colour.
- **State:** tags change variant, icon and words when the state changes; they never change shape, never take focus and never act on a click.

### Cards / Containers
- **Corner Style:** softer corners (16px).
- **Background:** Page White (Basement Raised at night).
- **Shadow Strategy:** small lift (see Elevation & Depth).
- **Border:** 1px Page Rule.
- **Internal Padding:** the card's own default; content inside stacks with Web Awesome gap utilities.
- **Project rows** (member plan): one row per project slot with the name and rename pen, tags, then Open and a kebab menu at the end; padded small by medium (13.5px 18px), 1px Page Rule border, 8px corners. At phone width the tags drop to their own line, and below about 400px the actions do too. An empty slot is dashed and transparent and holds a "New project name" input with a Create button.
- **Projects table** (pro plan): full width, Graphite Quiet semibold heads with sort buttons on sortable columns, a 1px rule under each row, Open and kebab in the end column; scrolls sideways inside its own scroller rather than squeezing.

### Inputs / Fields
- **Style:** Page White field, 1px Control Edge border, 8px corners, 0.75em by 1em padding, label above in semibold, hint in quiet text; a faint top-lit band from the glossy theme.
- **Focus:** the band clears and the 3px Focus Blue ring appears.
- **Error / Disabled:** errors are announced in a danger callout naming what happened and what to do; disabled follows Web Awesome's defaults.

### Navigation
- **Style:** a vertical list (Projects, Devices, Rooms, Settings) of icon plus label in body type, Graphite Ink, 8px corners, padded small by medium, no underline; Sign out sits last as a plain button aligned with the links.
- **Active:** the current page has a Commissioning Blue Mist fill (Night in dark) and Commissioning Blue text (Focus Blue in dark), marked with `aria-current="page"`.
- **Mobile:** the list moves into a drawer opened from the header's menu button; the account email and the site links join the drawer's foot.

### Footer Status Bar
The logbook's margin. A sticky bar on every view with a 1px top rule and Page White (Basement Black) fill, holding the network tag and, once a project is known, its sync tag, left; the site links in Body Small link colour, right (desktop only). One visually hidden live region announces changes; the tags themselves are silent labels.

### Dialogs and Callouts
- **Dialogs:** 16px corners, large lift, a heading that asks the question ("Remove from the server?"), one sentence that states the consequence, then Cancel (outlined) before the confirm (brand, or danger when destructive). Footer buttons stack full width at phone width.
- **Callouts:** one per message, with an icon: danger for errors, warning for session and sync problems and plan limits, neutral for hints and progress, brand for "update available".

### Named Rules
**The Confirm-Before-Destroy Rule.** Every destructive action opens a dialog that names the consequence and offers Cancel first; the confirm button is the danger variant and repeats the action's own words ("Remove from server").

## Do's and Don'ts

### Do:
- **Do** reference `--wa-*` tokens and Web Awesome components, utilities and variants for everything; derive any dimension from `--wa-space-*`.
- **Do** stamp state with the shared status vocabulary: a size s filled tag with its icon, the same words and variant in the footer and on rows.
- **Do** keep the network and sync state visible in the sticky footer on every view.
- **Do** give each view one Commissioning Blue primary action; make the rest outlined, neutral or plain.
- **Do** put every destructive action behind a dialog that states the consequence, with Cancel before a danger confirm.
- **Do** check every new screen in light and dark, at desktop and at 320px wide, with the 3px Focus Blue ring visible on every interactive element.
- **Do** lift entry surfaces (cards, project rows) on the small shadow token when they are touched, rather than adding heavier borders.

### Don't:
- **Don't** write raw hex, px or rem in app CSS, or hand-written box-shadows; the theme owns colour, size and depth.
- **Don't** style a status as a button, make it focusable, or invent a new word or colour for a state that already has one.
- **Don't** offer a theme or palette that fails WCAG 2.2 AA in either scheme; Tailspin, Shoelace and Brutalist stay withheld.
- **Don't** put the glossy sheen on surfaces, tags or status.
- **Don't** use pills for tags or a third radius for containers.
- **Don't** fill a secondary action with Commissioning Blue.
