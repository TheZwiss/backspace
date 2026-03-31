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
| Modal | `.glass-modal` | Large center-screen dialogs |
| Pill | `.glass-pill` | Inline decorations (reactions, tags) |
| Pill (own) | `.glass-pill-mine` | User's own reaction (mint-tinted) |

**Rule:** If it floats above the content plane, it's glass. Never use `bg-surface-elevated` for floating/overlay elements.

**Modal backdrops:** `bg-black/50` — light enough for glass blur to show through.

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
