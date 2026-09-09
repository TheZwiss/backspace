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

## Settings organization

Settings tabs split on ownership. **Appearance** holds preferences that belong
to this browser or app: language and interface scale today, themes and display
density later. They are stored locally and they work on the login screen, before
there is an account. **Account** holds what lives on the server and follows the
user to any device or instance: profile, credentials, deletion. Avatar and
banner colours look like appearance and are not, because other people see them.
A new presentation preference goes in Appearance, not in Account or in Desktop
(which is Electron-only and would hide it from the browser).

## Interface scale

Appearance settings include a device-local interface scale: 50–250% in 25% steps,
default/reset 100%. `interfaceScaleStore` persists the percentage under
`backspace-interface-scale`; unsupported stored values fall back to 100%.
`main.tsx` applies it before mounting React, including auth pages and portals.
English, German, and Russian labels live in the `settings` namespace.

50% is an opt-in density setting, not a recommended reading size: common 10–11px
labels render at only 5–5.5px. The former 75% floor kept those labels at
7.5–8.25px; the lower floor accommodates users who want more content on screen,
but going lower would further compromise legibility. Default/reset remains 100%.

The web and Electron clients share root CSS `zoom`. This is independent of the
browser's own zoom controls. CSS viewport units do **not** compensate for CSS
zoom, so viewport-constrained surfaces use `--app-vh`, `--app-dvh`, and `--app-vw`
(one viewport unit divided by `--interface-scale`). Tailwind's `h-screen` and
`min-h-screen` use the same units. Keep Electron's title-bar reservation in
physical pixels using the shared `--titlebar-inset` (33px divided by the scale
under Electron, zero in the browser). `App`, `SpaceSidebar` and `ImagePreview`
must all use this property rather than separate fixed offsets.

Safe-area and keyboard offsets use `--safe-top`, `--safe-bottom`, and
`--keyboard-inset`, which divide the corresponding environment lengths by the
scale. The viewport-token test rejects raw viewport units and environment
functions outside these definitions in production source.

`initializeInterfaceScale` updates `html[data-viewport="mobile|desktop"]` on
resize and scale changes using the same predicate as AppLayout: mobile below
768 layout pixels **or** below 600 unscaled viewport pixels (`window.innerWidth`).
The narrow-viewport guard keeps 390–430px phones in MobileShell even at 50%,
when their effective layout width is 780–860px. Wider windows retain the scaled
768px breakpoint; 600px is the first width eligible for desktop at 50%.

The guard also decides the outcome at 75%, not only at the new floor: it applies
at any scale at or below 78.125%, so a 576–599px window renders MobileShell where
the scaled breakpoint alone would have kept the desktop grid. That is intended.
A physically narrow viewport is mobile regardless of scale; gating the guard on
scale would reintroduce the scale-driven shell flip it exists to prevent.

Use the `desktop:` Tailwind variant for app-shell responsiveness; raw media
queries ignore root zoom. Auth pages without a JS layout branch may keep `md:`.
When scale moves the appearance panel into MobileShell, route reconstruction
places the current channel below settings and remains idempotent in StrictMode.

`ImageCropModal` cancels root zoom only on the cropper container with
`zoom: calc(1 / var(--interface-scale, 1))`. react-easy-crop mixes visual DOM
measurements and pointer deltas with CSS pixels, so this subtree must operate
at effective 100%. The surrounding dialog controls retain the interface scale.
Validate both dragging and the exported crop pixels when changing this boundary.

DOM rectangles and pointer coordinates are visual pixels. Convert them with
`layoutPixels` / `layoutRect` before assigning CSS positions, sizes, or drag
offsets. `computeFloatingPosition` accepts visual rectangles and dimensions and
returns layout coordinates; its callers must not pre-convert them. Pure hit
tests comparing two visual coordinates do not need conversion.
For anchors created from layout constants, convert with `visualPixels` before
calling `pointAnchor` so floating-position conversion does not shrink them twice.

Changing scale dispatches `resize` to update floating surfaces and the effective
mobile breakpoint. The account settings stay accessible when crossing that
breakpoint. Native browser zoom and pinch gestures retain their normal behavior.

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
| Bubble | `.glass-bubble` | Persistent floating controls (voice bar, **chat composer**, voice mini-bar). Chat composer is a floating bubble on **both** desktop and mobile (`position: absolute`, sits above the message-list scroll area; messages scroll behind it). On mobile, its `bottom` value is driven by `useVisualViewportInset()` so it lifts above the iOS soft keyboard when one is open. See `docs/systems/mobile-ui.md` "Floating Composer" for the full pattern. |
| Popover | `.glass` | Small floating surfaces (context menus, popovers, tooltips) |
| Tray dropdown | `.glass` (popover) | `TransferIndicator` global panel — anchored under the channel-header icon. |
| Modal | `.glass-modal` | Large center-screen dialogs |
| Pill | `.glass-pill` | Inline decorations (reactions, tags) |
| Pill (own) | `.glass-pill-mine` | User's own reaction (mint-tinted) |

**Rule:** If it floats above the content plane, it's glass. Never use `bg-surface-elevated` for floating/overlay elements.

**Modal backdrops:** `.modal-scrim` — a radial vignette from 42% black at the centre to 66% at the corners, so the dialog sits in a pool of light and the app's edges fall away. Same average darkness as the flat 50% it replaced, still light enough for glass blur to show through. Every backdrop that sits behind a `.glass-modal` uses it (`Modal`, `ConfirmDialog`, `UserProfileModal`, `TransferOwnershipModal`, `IncomingCallModal`, `MobileFolderSheet`).

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

**Vendor prefix order is load-bearing.** In `globals.css`, write `-webkit-backdrop-filter` **first** and the unprefixed `backdrop-filter` **last**. Vite 8 minifies CSS with Lightning CSS, which folds a prefixed and an unprefixed declaration of the same property into one and keeps whichever came last. With the unprefixed line first, the build ships only `-webkit-backdrop-filter`, which Firefox does not implement, so every glass surface loses its blur there with nothing in the console. The same order applies to any other property written in both forms.

---

## Button and backdrop classes

Three classes in `globals.css` carry the flat Aether Drift button surfaces so
colour and states are written once: `.cta-primary` (accent primary),
`.cta-danger` (rose) and `.cta-warning` (amber), each with a softer fill on
hover, a two-stop focus ring and a not-allowed cursor when disabled. Sizing,
radius and layout stay at the call site as utilities; `disabled:opacity-50`
composes. Do not add `bg-accent-primary`, `text-white` or `transition-colors`
beside them. `.modal-scrim` is the flat 50% black backdrop every dialog uses.

A first version of these classes shipped gloss, lit lips, rims and auras, and
put rims and gloss on `.glass-modal` and a lit edge on toasts. It was rejected
as forced 3D against this design system's flat calm glass and reverted on
2026-09-10; the scene bible (`docs/superpowers/specs/2026-09-09-ui-soul-pass-scene-bible.md`,
sections 4 and 12) records why. Glass is felt, not seen; nothing wears it.

**Design workbench.** A scene ships with a dev page under `packages/web/src/dev/`
plus an HTML entry beside `index.html`, built on `dev/workbench.tsx` and
`dev/harness.tsx` (`WorkbenchPage`, `Section`, `Slot`, `Surround`,
`mountScenePage`, and `?state=hover|focus|active` to force a state). The i18n
literal-string rule skips `src/dev/`; never use `100vh` there.

## Scenes

The bespoke half of the soul pass. Each scene is one component with a co-located stylesheet, one subject from the scene bible, and its own workbench page. A scene reads no store and handles no click unless the table says otherwise; the caller passes the copy in, already translated, so no scene owns a string. Every scene obeys the bible's darkness rule (section 4: the void darker than the chrome, sparse crisp stars, flat vector shapes, no shading, gloss, rims, grain or plotted lines), keeps to the motion budget at rest (at most two very slow animations, transform and opacity only), holds a still frame under `prefers-reduced-motion`, and paints only with `SCENE_PALETTE` in SVG and `rgb(var(--token) / a)` in CSS. The table below is refreshed when the second pass lands.

| Scene | Component | Subject | Workbench | Notes |
|---|---|---|---|---|
| The ship on its way | `voice/VoiceEmptyPanel` | The empty voice channel: a near-black void darker than the header, the hello scene's flat craft top left with a soft plume, a flat dark world mostly off-frame low right with one thin atmosphere line, sparse crisp stars | `dev-voice-empty.html` | Extracted from `MainContent`; desktop only. Two slow animations at rest, no filters |
| Arriving | `auth/AuthBackdrop` | Behind the login, register and invite cards: the void, the stars, the world with its atmosphere line; the invalid-invite variant darker and colder | `dev-auth-backdrop.html` | Sticky zero-height root sized to the scroll port by a ResizeObserver, so the scene stays still while the card scrolls and never paints under the desktop title bar. One twinkle at rest |
| A hail, calmly | `voice/IncomingCallModal` | The plain modal glass, the caller's avatar, one thin ring in the hail colour that eases out slowly, flat accept and decline | `dev-incoming-call.html` | Behaviour untouched; one animation while ringing |
| Nori in open space | `ui/CrewEmptyState`, `chat/ExploreEmpty` | Every "no one is here" state and the empty explore page: the whole column as void, a sparse deterministic sky, Nori small at the centre, the copy plain on the dark | `dev-crew-empty.html`, `dev-explore.html` | `OpenSpace` is exported from CrewEmptyState and shared; one twinkle at rest plus Nori's hook. Replaces the seven bare `Mascot` sites |
| Home space | `chat/HomeSpace` | The living backdrop behind the friends page's main column: the void, one sky with a density band, the same world low right, small stars breathing, a Sternschnuppe every minute or so, and the ship crossing low every few minutes to slip behind the world's limb | `dev-friends-home.html` | Three animation definitions, no filters; parked and still under reduced motion |
| Friends on glass | `chat/FriendsGlass` | The friends page's controls as `.glass-bubble` pills (title, segmented tabs, Add Friend, the trailing toggle), each friend or request row its own content-sized glass bubble, the section count its own pill; no content panel, and the empty states bare on the backdrop | `dev-friends-home.html` | Rows and counts are tagged `friends-row` and `friends-count` in FriendsPage and styled only under `.friends-panel`, so the mobile page keeps its plain rows. Solid fallbacks under reduced transparency |
| Nori | `ui/Mascot` | The mascot, same silhouette and moods, relit flat under one soft light | `dev-mascot.html` | The animation hook changed only in timings, now at or above the six-second floor |

Structure-only extractions that carry no scene: `chat/WelcomeHero` (the plain welcome header, rendered from `MessageList`; its height is part of the scroll contract, see `message-list.md`) and `chat/ExploreCardBanner` (the plain card banner). The first pass gave both a scene and the search popover a scanner; all three were rejected and reverted, see the bible's section 12.

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

## Unread and attention indicators

| Colour | Meaning | Used by |
|--------|---------|---------|
| `accent-rose` / `bg-notification` | Someone is waiting on you: unread messages, mentions, pending friend requests | channel unread dots, mobile bottom-nav badges |
| `accent-amber` | Informational, no one is blocked: an available instance update, pending federation approvals | settings tab and sidebar badges |

A settings section carries a count (`SettingsSection.badgeCount`) when the number
matters, or a dot (`SettingsSection.badgeDot`) when only the existence does. Both
render in `SettingsTabBar` and in the desktop sidebar sub-links.

Exception: the mobile bottom-nav "You" tab (`MobileBottomNav.tsx`) ORs the
update dot into its existing rose dot rather than showing a separate amber
one. That tab already means "something of yours needs attention" for incoming
friend/DM activity, and splitting one dot into two colours by cause would read
worse than a single dot with mixed causes — this is a deliberate exception to
the amber-means-update rule above, not a bug.

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

### AvatarStack

Reusable group-DM identity widget at `packages/web/src/components/ui/AvatarStack.tsx`. Replaces the bespoke inline avatar logic that previously lived in `DmListItem`. Single source of truth for any rendered group-DM identity slot — sidebar rows, chat header, welcome header, settings modal hero, and mobile equivalents all consume it.

```ts
interface AvatarStackProps {
  members: User[];                        // already filtered to "other" members
  size: number;                           // outer box edge length in px (24, 32, 40, 56, 80)
  border: 'channel' | 'chat' | 'modal';   // surface tier the stack sits on; controls tile border color
  iconUrl?: string | null;                // when set, renders the icon as a single image and ignores the stack
}
```

**Layout rules** (chosen by `members.length`, ignored entirely when `iconUrl` is set):

| Member count | Layout | `data-avatar-stack-layout` |
|---|---|---|
| 0 | Empty placeholder + small 12×12 group badge bottom-right | — |
| 1 | Single avatar centered in the box + 12×12 group badge bottom-right (distinguishes a 1-other-member group from a 1-on-1 DM) | — |
| 2 | Two avatars at 70% size with a 30% offset overlap (z-stacked) | `overlap` |
| 3 | Equilateral-triangle huddle: three 62%-size tiles arranged radially (top, bottom-right, bottom-left), neighbors overlap | `triangle` |
| 4 | Diamond huddle: four 58%-size tiles at the four cardinal points (top, right, bottom, left), neighbors overlap | `diamond` |
| 5-10 | Diamond huddle: three 58%-size tiles at the top/right/left points + a `+N` overflow tile occupying the bottom point, where `N = members.length - 3` | `diamond` |

**3+ member geometry.** Tiles are positioned radially around the box center on a circle of radius `R = (S − T) / 2`, where `S` is the box edge length and `T` is the tile size (`0.62·S` for 3 members, `0.58·S` for 4+). The first slot starts at `−90°` (top) and remaining slots are evenly spaced clockwise (`360° / slotCount` apart). This makes the farthest edges of each tile graze the box's bounding rect — no clipping, no wasted whitespace — and produces the same "huddle of overlapping faces" aesthetic as the 2-member overlap pattern at every member count. Z-index descends clockwise from the top slot so each tile tucks slightly under its clockwise neighbor (mirrors the 2-member case where the first tile sits on top of the second). The `+N` overflow tile always occupies the bottom diamond slot — reads as "more members behind these three" rather than "+N is one of the people".

`iconUrl` accepts a bare filename (resolved to `/api/uploads/<filename>`) or an absolute URL (`http`, `blob:`, `data:`, or `/`-prefixed) — passed through unchanged. When set, the entire box renders as a single rounded `<img>` filling the box.

**Status dots are deliberately omitted** regardless of member count — a group is a group. The 1-on-1 path keeps its presence dot via the direct `Avatar` component.

**Hooks-in-loop safety:** each rendered slot is its own `<AvatarTile>` component so `useCanonicalUserView` is called exactly once per slot, never inside a variable-length `.map()`.

### Avatar vs ProfileAvatar

Two components, one deliberate split:

| Component | Role |
|---|---|
| `Avatar` (`ui/Avatar.tsx`) | Purely presentational. Takes `user` for the gradient, avatar colour, `homeUserId` and status dot. Clicking it does nothing unless the caller passes `onClick`. |
| `ProfileAvatar` (`ui/ProfileAvatar.tsx`) | `Avatar` plus the profile card. Opens `UserProfilePopout` anchored to its own box, stops propagation so it wins over an enclosing row handler, and stays inert while `user` is undefined. |

**Rule:** an avatar is only a profile trigger when it is a `ProfileAvatar`. Never re-add an implicit "open the profile if a `user` prop is present" branch to `Avatar` — passing `user` is how *every* avatar gets its colour, so that branch silently turns the picture inside the profile card, the settings preview, the avatar-upload button and every row in a modal into a trigger. It also made the card re-anchor to its own picture and walk across the screen on repeated clicks (issue #37).

Use `ProfileAvatar` when the avatar is the primary way to reach that person's profile and nothing else owns the click. Use `Avatar` when an enclosing row, button or list item already handles clicks, or when the avatar depicts the surface it already sits on.

**Escalation chain.** Clicking a face always moves one step deeper, never sideways and never nowhere:

| Surface | Picture click |
|---|---|
| Member tile / row / message author | Opens the preview card (`UserProfilePopout`) |
| Preview card | Opens the full profile modal (`UserProfileModal`) and closes the card |
| Full profile modal | Nothing — this is the terminus |

The middle step matters: an inert picture on the preview card is a dead end that forces the user down to the *View Full Profile* link. What it must never do is reopen the card itself — that is the drift bug from issue #37.

### Floating placement

Every floating surface places itself with `computeFloatingPosition` (`hooks/useFloatingPosition.ts`): preferred side → flip when it would overflow → clamp into the viewport, with an 8px viewport padding.

- Components with a live anchor element use the `useFloatingPosition` hook (tooltips, mention/search popovers, voice popovers).
- Components opened from a store keep the anchor's **rect** instead of an element — `uiStore.openUserProfile(user, anchor, placement)` stores `AnchorRect` + `Placement`, and `UserProfilePopout` measures itself and places off that. `pointAnchor(x, y)` builds a zero-size rect for the rare caller with no anchor element.
- `align: 'start'` lines the surface's leading edge up with the anchor; the default centres it on the anchor.

**Callers never compute coordinates.** A surface that is handed a finished `{ top, left }` cannot account for its own measured size, and any caller-side constant (an assumed card height, a hardcoded sidebar width) drifts the moment the content or the layout changes.

**Tile geometry contract.** Each `AvatarTile` renders at `size × size` with a 2px border (`box-sizing: border-box` from Tailwind preflight), so its content area is `(size − 4) × (size − 4)`. The inner `Avatar` is sized to that content area (`size − 2 · TILE_BORDER_WIDTH`) and centered geometrically on the tile via `flex items-center justify-center`, **not** by inline-flow placement. Both corrections are required: sizing the Avatar to the outer dimensions overflows the padding box and gets clipped off-center (visible disc remains centered, but the avatar's contents — image crop, initials gradient + letter — anchor at the padding-edge top-left and visibly drift toward the lower-right of the visible disc); relying on `Avatar`'s `inline-flex` placement makes the Avatar drift vertically by whatever the inherited `line-height` adds, independent of border. `TILE_BORDER_WIDTH` is exported from `AvatarStack.tsx` as the single source of truth for the `border-2` width and must be updated in lockstep with any future change to that class.

**Border tiers:** the surface tier the stack sits on determines the tile border color (so the tiles cleanly separate from the panel they overlap). `channel` → `border-surface-channel` (sidebar); `chat` → `border-surface-chat` (chat area / welcome header / chat header); `modal` → `border-surface-elevated` (modal hero, mobile info-screen hero — there is no `surface-modal` token in `tailwind.config.js`).

**Usage sites** (all six call sites in the codebase):

| Site | Size | Border | Notes |
|---|---|---|---|
| `DmListItem.tsx` (sidebar row) | 32 | `channel` | Pinned to the DM sidebar; `iconUrl={dm.icon}` |
| `MessageList.tsx` `WelcomeHeader` (group-DM branch) | 80 | `chat` | Large hero on the empty-state header |
| `MainContent.tsx` chat header (group-DM branch) | 32 | `chat` | Replaces the people-icon for group DMs |
| `GroupDmSettings.tsx` (modal hero + member-row previews) | varies | `modal` | Modal Overview tab |
| `MobileGroupDmInfo.tsx` (pushed-screen hero) | 80 | `modal` | Mobile info screen hero |
| `MobileDmsScreen.tsx` (DM list rows) | 40 | `channel` | Mobile sidebar parity with desktop `DmListItem` |
