# Matter Manager — instructions for Claude

## Always load the Web Awesome skills for UI work

Before writing, changing or reviewing anything in `frontend/src/ui/`, including views, the shell, styles, dialogs and icons, invoke both skills:

1. `webawesome-design`: layout (`<wa-page>`), theming (`--wa-*` tokens), colour and composition.
2. `webawesome`: component APIs (dialog, dropdown, input, tag, callout, card and the others).

This applies to subagents doing UI work too: tell them to load both skills first. The UI is built on Web Awesome **Pro** (ADR 0008). Use its components, utilities (`wa-stack`, `wa-cluster`, `wa-split`, `wa-grid`, `wa-gap-*`) and design tokens rather than custom CSS values.

## Product and design context

- `PRODUCT.md`: users, purpose, principles, accessibility bar (WCAG 2.2 AA).
- `DESIGN.md`: the visual system, once recorded with `/impeccable document`.
