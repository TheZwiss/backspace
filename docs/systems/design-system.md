# Design System — "Aether Drift"

Prototype (source of truth): `Backspace-design-prototype.html` (open in browser)
Styles: `packages/web/src/styles/globals.css`
Theme: `packages/web/tailwind.config.js`
Font: DM Sans (primary) with system fallbacks

---

## Principles

- Calm over flashy. Warm over cool.
- Quiet glass (felt, not seen). No decorative gradients. Minimal shadows.
- Two-material system: solid matte panels for content (75%), frosted glass bubbles for persistent controls (25%)
- `prefers-reduced-transparency` → fall back to solid surfaces
- NOT a Discord clone — Backspace has its own visual identity

---

## Color Palette

### Matte Surfaces (CSS vars, RGB channels)
| Var | Role |
|-----|------|
| `--bg-base` | App background |
| `--bg-channel` | Channel sidebar (#1a1a23) |
| `--bg-chat` | Chat area (#13131a) |
| `--bg-members` | Member list |
| `--bg-elevated` | Static structural panels only |
| `--bg-input` | Input backgrounds (sunken) |
| `--bg-overlay` | Overlay backgrounds |

### Pastel Accents
`--accent-mint`, `--accent-peach`, `--accent-lavender`, `--accent-sky`, `--accent-amber`, `--accent-rose`, `--accent-coral`

### Primary Action
`--accent-primary`, `--accent-primary-hover`, `--accent-primary-active`

### Text Hierarchy
`--text-primary`, `--text-secondary`, `--text-tertiary`, `--text-category`, `--text-message`, `--text-link`, `--text-positive`, `--text-warning`, `--text-danger`

### Interactive States
`--interactive-hover`, `--interactive-active`, `--interactive-selected`, `--interactive-muted`

### Status
`--status-online`, `--status-idle`, `--status-dnd`, `--status-offline`

---

## Surface Material Tiers

| Tier | Class | When to Use |
|------|-------|-------------|
| Structural | `bg-surface-*` | Permanent layout (sidebars, chat, member list) |
| Strip | `.glass-strip` | Persistent edge chrome (space sidebar) |
| Bubble | `.glass-bubble` | Persistent floating controls (voice bar, input pill) |
| Popover | `.glass` | Small floating surfaces (context menus, popovers, tooltips) |
| Tray dropdown | `.glass` (popover) | `TransferIndicator` global panel — anchored under the channel-header icon. |
| Modal | `.glass-modal` | Large center-screen dialogs |
| Pill | `.glass-pill` | Inline decorations (reactions, tags) |
| Pill (own) | `.glass-pill-mine` | User's own reaction (mint-tinted) |

**Rule:** If it floats above the content plane, it's glass. Never use `bg-surface-elevated` for floating/overlay elements.

**Modal backdrops:** `bg-black/50` — light enough for glass blur to show through.

**Portal target — `usePortalContainer()`:** Every overlay (context menu, tooltip, popover, modal, screen-share picker) MUST portal through `usePortalContainer()` (`packages/web/src/hooks/usePortalContainer.ts`) instead of hard-coding `document.body`. The hook returns `document.fullscreenElement ?? document.body` and re-renders subscribers on `fullscreenchange`. Without this, anything portaled while an element (e.g. the voice container in fullscreen mode) is in the browser's Fullscreen API top-layer is rendered outside that layer and is invisible. Components mounted at App root that render with `fixed inset-0` (not just portals) must also portal through this hook for the same reason.

### Glass Material Properties
```css
.glass {
  backdrop-filter: blur(20px) saturate(120%);
  background: rgba(20, 20, 26, 0.52);    /* --glass-bg */
  border: 1px solid rgba(255, 255, 255, 0.07);  /* --glass-border */
}
.glass-modal {
  /* Higher opacity: 82%, stronger shadow */
}
.glass-pill {
  backdrop-filter: blur(12px) saturate(110%);
}
```

---

## Input Tiers

All defined in `globals.css`. No resting border — sunken `surface-input` background provides differentiation.

| Tier | Class | When to Use | Focus |
|------|-------|-------------|-------|
| Standard | `.input-standard` | Form fields in modals, settings, auth | `ring-2` primary |
| Search | `.input-search` | Search bars, filter inputs | `ring-1` primary |
| Embedded | `.input-embedded` | Inside glass (chat input, search popover) | none |
| Danger | `.input-danger` | Destructive confirmations | `ring-2` rose |

Override padding/size with utilities: `input-standard w-full py-2.5`

### iOS Auto-Zoom Suppression

iOS Safari auto-zooms (and shifts the viewport right) on input focus when the computed `font-size` is below 16px. The `@media (max-width: 767px)` block in `globals.css` bumps every input tier — and bare `<input>`/`<textarea>`/`<select>` plus `[contenteditable]` — to `font-size: 16px !important`.

`!important` is required because Tailwind utilities like `text-[15px]` (used on the chat composer textarea) and `text-sm` (used on form fields) are emitted in the `@layer utilities` block, which comes after `@layer components` in the cascade and would otherwise override the input-tier rules. There is no legitimate reason to use a `<16px` font-size on a mobile input, so the override is universally correct.

When introducing a new input or contenteditable surface, no extra work is needed — the global rule covers it.

---

## Layout

3-column grid: 312px channel sidebar | main content | 240px members sidebar
Glass server strip overlays left 72px of channel sidebar.
Channel sidebar fully opaque with gradient at left edge feeding glass.

---

## Shadows

| Name | Use |
|------|-----|
| `header` | Top bars |
| `elevation-low` | Subtle lift |
| `elevation-high` | Dropdowns, popovers |
| `glass` | Glass surfaces |
| `input` | Input fields |

---

## Animations

### Core
`fadeIn`, `slideUp`, `slideDown`, `typingFadeIn`, `gradientPulse`, `shimmer` (skeleton loading)

### Search
`search-flash`, `stepForward`, `stepBack`

### Call
`callRippleLiquid`, `callGlowSoft`, `callRefraction`, `callButtonBreath`

### Mobile
`mobile-screen-enter`, `mobile-screen-enter-active`, `mobile-screen-exit-active`, `slide-up-sheet`

### Skeleton Loading
`.skeleton`, `.skeleton-circle`, `.skeleton-bar`, `.skeleton-block`

---

## Utility Classes

- `.no-scrollbar` — Hides scrollbars
- `.scrollbar-thin` — 4px thin scrollbars
- `.rounded-inherit` — Inherits border radius
- `.titlebar-drag` / `.titlebar-no-drag` — Electron window drag
- `.call-refraction` — Light shimmer overlay for call UI

---

## Primitives

### Radial Progress Ring

Used in `AttachmentProgress` overlays inside the optimistic bubble and the staged-files row. Implementation:

```css
background: conic-gradient(rgba(180, 220, 200, .85) <pct>%, rgba(255, 255, 255, .15) <pct>%);
```

Inner disk uses `bg-surface-overlay` to sit visually above the underlying tile thumbnail. Failed-state ring uses `bg-accent-rose/30`.
