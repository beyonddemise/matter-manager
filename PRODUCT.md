# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

An installable, offline-first PWA (`frontend/public/manifest.webmanifest`, service worker, standalone display). It runs in phone and desktop browsers. There is no native wrapper.

## Users

Two primary audiences are served equally, and the interface must not favour one over the other:

- **Homeowners** catalogue the Matter devices in their own house. They usually have one or two projects, sometimes shared with a partner, and are typically on the free or member plan.
- **Installers** commission many houses, often on site with no connectivity. They hand each project over to its homeowner and may keep read access for support. They are typically on the pro plan.

A third audience, **operators**, runs the service: accounts, plans, support. Operators work through the API and by hand-editing records, not through the app UI.

## Product Purpose

Matter devices are commissioned by scanning a QR code printed on the device or its box. That code is routinely lost, and recovering it means a factory reset, a support call or a replacement device. Matter Manager captures each code once, together with useful metadata: room, type, name, installation date, serial number, photos and timestamped remarks. It reproduces the code exactly whenever it is needed, on screen or as a printable PDF (a label sheet, or a full inventory grouped by room) to file with the house documents.

Success: no one who used Matter Manager ever has to factory-reset a device because its code was lost.

## Positioning

**"Never lose a Matter commissioning QR code again."** The tagline leads. The mechanisms behind it:

- **A catalogue, not a hub.** It never commissions, controls or monitors devices, and never talks to the Matter network or fabric.
- **The code is a string, not a picture** (`MT:` plus Base38). It is stored exactly, reproduced at any size, and its vendor and product IDs are decoded to fill in manufacturer and product name automatically.
- **Offline-first.** "The basement is exactly where you need this." Every device operation works without connectivity, and data syncs when the network returns.
- **Hand-over.** An installer can transfer a whole house record to the homeowner and optionally keep read access.

## Operating Context

- Used on site on a phone, often in basements or plant rooms with no signal, and at a desk for printing labels and inventories.
- **Workflows:**
  - scan or enter a code;
  - record and edit a device;
  - organise rooms as hierarchical paths (e.g. `Ground Floor/Kitchen`);
  - search the device list;
  - show a code enlarged, or as a numeric pairing code when a camera cannot read a curled label;
  - disable or re-commission a device;
  - generate a label sheet or inventory PDF;
  - manage projects (create, rename, promote to synchronized, download, remove a local or server copy);
  - share with roles;
  - transfer ownership.
- **Roles per project:** owner, manage, write, read. Ownership moves only by transfer.
- **Plans:** free (1 project, local only), member (5), pro (unlimited, with a client name per project). Plan limits count local and server projects together, and shared projects don't count.
- **Sign-in:** Google OIDC. Facebook sign-in is planned for later.
- **Languages:** English and German. German uses the formal *Sie*. The language follows the browser and can be overridden in the profile.

## Capabilities and Constraints

- **Stack:** Lit with Web Awesome **Pro** (a licence is required, ADR 0008), Vite, deployed to Cloudflare Pages (`matter-manager-app`). The backend is Fastify with CouchDB 3.5 (one database per project), and the browser uses PouchDB/IndexedDB.
- **Offline:**
  - Must never require connectivity for device work.
  - Creating server projects, promoting and downloading need a connection.
  - The network state must always be visible.
- **Security:** setup passcodes are stored deliberately unencrypted (ADR 0005). They must never be logged. They leave the browser only through sync and through the catalogue lookup on our own API ([ADR 0019](docs/adr/0019-setup-code-to-own-api.md)), which decodes them in memory and never stores or logs them; only vendor and product IDs reach the DCL.
- **Dependencies:** minimal runtime dependencies, enforced in CI (ADR 0013).
- **PDFs** are generated client-side (pdf-lib, loaded lazily).
- **Undecided:**
  - pricing, prices and billing provider (ADR 0009); the "Upgrade" path currently shows "It's just alpha — coming soon";
  - organisations or teams for installers (the schema is ready, the feature is not built);
  - an operator admin UI.

## Brand Commitments

- **Name:** "Matter Manager". The short name is "Matter" (manifest `short_name`).
- **Web addresses:** website https://www.matter-manager.io/ with `/privacy` and `/tos`. These are linked from a footer on every view, which Google OAuth review requires. The app is at app.matter-manager.io.
- **Assets:**
  - app icons in `frontend/public/` (`icon-192.png`, `icon-512.png`, `icon-maskable-512.png`, `apple-touch-icon.png`);
  - an inline SVG favicon (a circle with an "M") in `frontend/index.html`;
  - self-hosted fonts in `frontend/src/ui/fonts/`;
  - bundled icons in `frontend/src/ui/icons/svg/`.
- **Voice:** plain, concrete and example-led ("Deckenlampe Küche", "Erdgeschoss/Küche"). Consequences are stated before destructive actions, and the safer alternative is offered (deactivate rather than delete). The tone is dry and matter-of-fact, never cute. German always uses *Sie*.
- **Theming:** the user can choose a light, dark or system scheme, and theme and palette are preferences. Themes that fail contrast are withheld.

## Evidence on Hand

None yet. The product is pre-alpha with no users, testimonials, customers, screenshots or metrics. Future work must not invent any of these.

## Product Principles

1. **The code must never be lost.** Every flow that could destroy data proves it is safe first, or asks explicitly, naming the consequence.
2. **Offline is the normal state.** Design for no signal first; the network is a bonus, and it is always visible.
3. **Serve the homeowner and the installer equally.** The same app is a personal house record and a professional on-site tool.
4. **A catalogue, not a controller.** Never imply the app operates devices.
5. **Plain and exact.** Precise names and concrete examples, with consequences stated, in both languages.

## Accessibility & Inclusion

The bar is **WCAG 2.2 AA**: contrast, keyboard operation, visible focus, labels, target size, reflow at phone width and status messages. Contrast is measured today in `frontend/test/ui/theme/contrast.browser.test.ts`, across every theme, palette and scheme. Future UI work must hold the full AA bar, not only contrast.
