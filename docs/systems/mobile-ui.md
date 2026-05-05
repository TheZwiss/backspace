# Mobile & Responsive UI System

Source files:
- `packages/web/src/components/layout/MobileShell.tsx` — Root mobile container: three tabs, screen stack, swipe gesture, browser history sync
- `packages/web/src/components/layout/MobileScreenStack.tsx` — Push/pop animation state machine with CSS slide transitions
- `packages/web/src/components/layout/MobileBottomNav.tsx` — Tab bar with unread badge counts, hidden when stack non-empty
- `packages/web/src/components/layout/MobileNav.tsx` — Legacy hamburger menu (pre-MobileShell), renders only when `isMobile` true
- `packages/web/src/components/layout/MobileScreenHeader.tsx` — Reusable back-arrow header for pushed screens
- `packages/web/src/components/layout/MobileChatScreen.tsx` — Channel/DM chat view with MessageList, MessageInput, TypingIndicator
- `packages/web/src/components/layout/MobileDmsScreen.tsx` — DM list with online friends row, unread indicators, FAB for new DM
- `packages/web/src/components/layout/MobileSpacesScreen.tsx` — Space strip + channel list (split-pane), folder support, voice user rows
- `packages/web/src/components/layout/MobileYouScreen.tsx` — User profile card, action rows, logout
- `packages/web/src/components/layout/MobileSettingsScreen.tsx` — Settings hub and direct-panel rendering via `initialPanel` prop
- `packages/web/src/components/layout/MobileInstancePanel.tsx` — Admin-only instance settings hub (General, Registration, Federation, Streaming, Storage, Users; surfaces federation approval-count badge)
- `packages/web/src/components/layout/MobileMembersScreen.tsx` — Space member list grouped by role, with activity cards
- `packages/web/src/components/layout/MobileVoiceFullScreen.tsx` — Full-screen voice call view with participant grid and control bar
- `packages/web/src/components/layout/MobileVoiceMiniBar.tsx` — Persistent mini-bar overlay during voice calls
- `packages/web/src/components/layout/MobileFolderSheet.tsx` — Bottom sheet for space folder contents, rename, color, ungroup
- `packages/web/src/hooks/useSwipeGesture.ts` — Edge swipe-back touch gesture hook
- `packages/web/src/stores/uiStore.ts` — Mobile navigation state (mobileScreen, mobileStack, push/pop actions)

Cross-references:
- Surface/glass tiers, animations, input classes: see `docs/systems/design-system.md`
- Voice call state machine, LiveKit integration: see `docs/systems/voice.md`
- Desktop three-column layout (AppLayout): see `docs/systems/design-system.md`

---

## Responsive Breakpoint

Detection is in `AppLayout.tsx`:

```ts
const checkMobile = () => setIsMobile(window.innerWidth < 768);
// Called on mount + resize listener
```

| Breakpoint | Value | Layout |
|------------|-------|--------|
| Desktop | `>= 768px` | AppLayout three-column grid (sidebar + chat + member list) |
| Mobile | `< 768px` | MobileShell (tab bar + screen stack) |

`AppLayout` conditionally renders `<MobileShell />` when `isMobile === true`. Modals render globally in both modes.

### Desktop-to-Mobile Transition (`uiStore:setIsMobile`)

| Direction | State changes |
|-----------|--------------|
| **To mobile** (`isMobile: true`) | `sidebarOpen: false`, `memberListOpen: false` |
| **To desktop** (`isMobile: false`) | `sidebarOpen: true`, `mobileScreen: 'spaces'`, `mobileStack: []` (memberListOpen retains its persisted value) |

The `setIsMobile` function is a no-op if the value hasn't changed (`prev === isMobile` guard).

---

## Architecture Overview

```
MobileShell (100dvh flex column)
  +-- MobileScreenStack (flex-1, relative, overflow-hidden)
  |     +-- Root screen (spaces | dms | you) — always rendered, visibility-hidden when covered
  |     +-- Stacked screens (absolute inset-0, bg-surface-base, z-10)
  +-- MobileVoiceMiniBar (conditional: when currentVoiceChannelId && voice-full not on top)
  +-- MobileBottomNav (glass-bubble tab bar, hidden when stack non-empty)
```

---

## Mobile Navigation State (`uiStore`)

### Data Types

```ts
interface MobileStackEntry {
  screen: string;           // Screen key from screenMap
  params?: Record<string, string>;  // e.g., { channelId, spaceId }
}

// State
mobileScreen: 'spaces' | 'dms' | 'you';  // Active root tab
mobileStack: MobileStackEntry[];           // Push/pop stack
```

### Actions

| Action | Behavior |
|--------|----------|
| `setMobileTab(tab)` | Sets `mobileScreen` to tab, clears `mobileStack` to `[]` |
| `pushMobileScreen(screen, params?)` | Appends entry to `mobileStack`, calls `history.pushState({ mobileScreen: screen }, '')` |
| `popMobileScreen()` | Removes last entry from `mobileStack` (no-op if empty). Does NOT call `history.back()` |

### Browser History Integration

`pushMobileScreen` calls `history.pushState` to add a browser history entry. `MobileShell` listens for `popstate` events:

```ts
// MobileShell.tsx
useEffect(() => {
  const handlePopState = () => {
    if (useUIStore.getState().mobileStack.length > 0) {
      popMobileScreen();
    }
  };
  window.addEventListener('popstate', handlePopState);
  return () => window.removeEventListener('popstate', handlePopState);
}, [popMobileScreen]);
```

This means the hardware/browser back button pops the mobile screen stack. `popMobileScreen` intentionally does not call `history.back()` to avoid infinite loops when triggered by the `popstate` handler.

### Deep Link Reconstruction

`MobileShell` watches `location.pathname` for `/channels/:spaceId/:channelId` and pushes a `channel-chat` screen when the URL changes to a channel route — both on mount (deep link / refresh) and on subsequent programmatic navigations (e.g. SpaceInviteCard Join button, joinByCode flows, any `useNavigate(...)` call).

```ts
useEffect(() => {
  const path = location.pathname;
  const match = path.match(/^\/channels\/([^/]+)\/([^/]+)$/);
  if (!match) return;
  const spaceId = match[1] ?? '';
  const channelId = match[2] ?? '';
  const normalizedSpaceId = spaceId === '@me' ? '@me' : spaceId;

  // Idempotency guard — read stack imperatively to avoid re-firing on stack changes
  const currentStack = useUIStore.getState().mobileStack;
  const top = currentStack[currentStack.length - 1];
  if (
    top &&
    top.screen === 'channel-chat' &&
    top.params?.channelId === channelId &&
    top.params?.spaceId === normalizedSpaceId
  ) {
    return;
  }

  pushMobileScreen('channel-chat', { channelId, spaceId: normalizedSpaceId });
}, [location.pathname, pushMobileScreen]);
```

**Why these dependencies and the idempotency guard exist:**

- The dep array intentionally excludes `mobileStack`. The current stack is read imperatively via `useUIStore.getState()` so that pushing an unrelated screen (e.g. `settings`) does not re-trigger this effect — otherwise we would re-push `channel-chat` on top of every newly pushed screen because pathname is still `/channels/...`.
- The guard catches the common in-app case where `MobileSpacesScreen` calls both `pushMobileScreen('channel-chat', …)` AND `navigate('/channels/…')`. The push happens first (no pathname change since `pushMobileScreen` calls `history.pushState` with no URL), then `navigate` mutates pathname → this effect re-runs → top already matches → skip.
- The guard also catches the popstate path: browser back pops both the history entry and the mobile stack; if the new pathname is a channel route already represented by the new top entry, we skip.

In-app navigation that lands on a different channel (e.g. tapping a `SpaceInviteCard` Join button while inside another chat) stacks the new `channel-chat` on top so back returns to the originating chat.

### User Profile Mobile Override

`uiStore:openUserProfile` detects `isMobile` and pushes a `user-profile` screen instead of showing a positioned popout:

```ts
if (get().isMobile) {
  set((state) => ({
    mobileStack: [...state.mobileStack, { screen: 'user-profile', params: { userId: user.id } }],
  }));
  history.pushState({ mobileScreen: 'user-profile' }, '');
}
```

---

## MobileScreenStack — Animation State Machine

File: `MobileScreenStack.tsx`

The stack manages CSS slide-in/slide-out animations using a dual-state approach: the canonical `mobileStack` (from uiStore) drives transitions, while `renderStack` (local state) controls what's actually rendered.

### State

```ts
const [transitioning, setTransitioning] = useState<'push' | 'pop' | null>(null);
const [renderStack, setRenderStack] = useState(mobileStack);
const prevStackRef = useRef(mobileStack);
const animatingRef = useRef(false);
```

### Transition Algorithm

The `useEffect` on `mobileStack` compares the new length to the previous length:

**Push (newLen > prevLen):**
1. Set `renderStack = mobileStack` (new screen enters the DOM)
2. Set `transitioning = 'push'` (new screen positioned at `translateX(100%)` — off-screen right)
3. Double `requestAnimationFrame` ensures the off-screen position is painted
4. Set `transitioning = null` (CSS transition kicks in, slides screen to `translateX(0)`)

**Pop (newLen < prevLen):**
1. Set `transitioning = 'pop'` (top screen gets `transition-transform duration-200 ease-out` + `translateX(100%)`)
2. After 200ms timeout: set `renderStack = mobileStack` (removed screen exits DOM), `transitioning = null`

**Same length (replacement):**
- Directly set `renderStack = mobileStack` (no animation)

### CSS Classes per Screen State

| Condition | Classes | Transform |
|-----------|---------|-----------|
| Top screen, `transitioning === 'push'` | `absolute inset-0 bg-surface-base z-10` | `translateX(100%)` |
| Top screen, `transitioning === 'pop'` | `... transition-transform duration-200 ease-out` | `translateX(100%)` |
| Top screen, settled (no transition) | `... transition-transform duration-200 ease-out` | (none, defaults to 0) |
| Non-top screen | `absolute inset-0 bg-surface-base z-10` | (none) |

### Root Screen Visibility

The root screen (spaces/dms/you) is always rendered but has `visibility: hidden` when `renderStack.length > 0`. This avoids unmount/remount when returning to root.

### Animation Timing

| Phase | Duration | Mechanism |
|-------|----------|-----------|
| Push: off-screen paint | ~2 frames (via double rAF) | `requestAnimationFrame` x2 |
| Push: slide in | 200ms | CSS `transition-transform duration-200 ease-out` |
| Pop: slide out | 200ms | CSS `transition-transform duration-200 ease-out` |
| Pop: DOM cleanup | 200ms | `setTimeout(200)` after which `renderStack` is updated |

---

## MobileBottomNav — Tab Bar

File: `MobileBottomNav.tsx`

### Visibility

Returns `null` when `mobileStack.length > 0` — hidden whenever a pushed screen is active.

### Tabs

| Tab | Badge Type | Badge Source |
|-----|-----------|--------------|
| Spaces | Dot (red) | `unreadChannels` has any non-voice channel |
| DMs | Numeric count | Count of DM channels where `lastMessage.id > readStates[dmId]` |
| You | Dot (red) | Pending incoming friend requests (`status === 'pending'` and `fromId !== authUser.id`) |

Badge caps at `99+` for numeric badges.

### Tab Tap Behavior

| Tab | Navigation |
|-----|------------|
| Spaces | Navigates to last known space route, or `/` |
| DMs | Navigates to `/channels/@me` |
| You | No navigation (stays on current route) |

All tabs call `setMobileTab(tab)` which clears the mobile stack.

### Styling

- Container: `glass-bubble` surface tier
- Height: `calc(56px + env(safe-area-inset-bottom))`
- Active tab: `text-accent-primary`; Inactive: `text-txt-secondary`

---

## Edge Swipe-Back Gesture (`useSwipeGesture`)

File: `hooks/useSwipeGesture.ts`

### Parameters

| Param | Default | Description |
|-------|---------|-------------|
| `onSwipeRight` | — | Callback fired on successful swipe |
| `edgeThreshold` | `20` (px) | Touch must start within this distance from the left edge |
| `swipeThreshold` | `50` (px) | Horizontal movement required to trigger |
| `enabled` | `true` | Disables all event listeners when false |

### Algorithm

1. `touchstart`: If `touch.clientX <= 20`, record start position
2. `touchmove`: If vertical movement exceeds horizontal (and not already swiping), cancel. If horizontal dx > 50px, set swiping flag and `preventDefault()`
3. `touchend` / `touchcancel`: If swiping flag is set, fire `onSwipeRight`

### Usage in MobileShell

```ts
useSwipeGesture({
  onSwipeRight: () => {
    if (mobileStack.length > 0) popMobileScreen();
  },
  enabled: mobileStack.length > 0,
});
```

Only active when there are pushed screens to pop. Document-level event listeners are added/removed based on `enabled`.

Event options: `touchstart` is `{ passive: true }`, `touchmove` is `{ passive: false }` (allows `preventDefault` to block scroll during swipe).

---

## Screen Map

`MobileShell` defines a `screenMap` that maps screen keys to render functions:

| Screen Key | Component | Params |
|------------|-----------|--------|
| `channel-chat` | `MobileChatScreen` | `{ channelId, spaceId }` |
| `friends` | `FriendsPage` (with `mobile` prop) | — |
| `settings` | `MobileSettingsScreen` | — |
| `settings-account` | `MobileSettingsScreen` | `initialPanel="account"` |
| `settings-voice` | `MobileSettingsScreen` | `initialPanel="voice"` |
| `settings-privacy` | `MobileSettingsScreen` | `initialPanel="privacy"` |
| `settings-connections` | `MobileSettingsScreen` | `initialPanel="connections"` |
| `settings-instance` | `MobileInstancePanel` | — |
| `settings-instance-general` | `GeneralPanel` (wrapped) | — |
| `settings-instance-registration` | `RegistrationPanel` (wrapped) | — |
| `settings-instance-federation` | `FederationPanel` (wrapped, forwards `onApprovalCountChange` → `uiStore.setFederationApprovalCount`) | — |
| `settings-instance-streaming` | `StreamingPanel` (wrapped) | — |
| `settings-instance-storage` | `StoragePanel` (wrapped) | — |
| `settings-instance-users` | `UsersPanel` (wrapped) | — |
| `members` | `MobileMembersScreen` | `{ spaceId? }` |
| `voice-full` | `MobileVoiceFullScreen` | — |
| `explore` | `ExplorePage` | — |
| `user-profile` | `UserProfileModal` | `{ userId }` (opens modal via `openModal('userProfile', ...)`) |

Instance settings sub-panels (`settings-instance-*`) are wrapped inline with `MobileScreenHeader` + scrollable container + `bg-surface-base`.

---

## Root Screens

### MobileSpacesScreen

Split-pane layout: 60px `glass-strip` space strip on the left + channel list on the right.

**Space strip features:**
- Home/DMs button at top (navigates to DMs tab)
- Folder-aware layout via `spaceLayout` and `folders` from spaceStore
- Unread pill indicator on left edge (8px dot for unread, 32px bar for selected)
- Federation badge on space icons (globe icon, amber dot if disconnected)
- Context menu: Invite, Create Folder, Move to Folder, Remove from Folder, Transfer Ownership, Leave
- Add Space button at bottom (opens bottom sheet: Create / Join / Explore)

**Channel list features:**
- Channels grouped by categories (collapsible)
- Uncategorized channels rendered first
- Text channels: `#` prefix, unread dot, selected highlight
- Voice channels: speaker icon, inline `VoiceUserRow` for connected users with context menus
- Voice channel tap opens `MobileVoiceJoinSheet` (not direct join)
- Text channel tap: navigates via router + pushes `channel-chat` screen
- Channel/category context menus for management (guarded by `MANAGE_CHANNELS` permission)

**Layout resolution:**
- `spaceLayout` array items can be `{ t: 's', id }` (space) or `{ t: 'f', id }` (folder)
- Spaces not in the layout are appended at the end
- Folder items render as folder icon buttons that open `MobileFolderSheet`

### MobileDmsScreen

- Header: "Messages" title + "Friends" button
- Online friends activity row (horizontal scroll, shows avatar + status dot)
- DM list sorted by last message time (newest first)
- Each DM row: avatar, name, message preview, timestamp, unread dot
- Group DMs: group icon instead of avatar, context menu with "Leave Group"
- Federated users: `@domain` subtitle below username
- Empty state: sleeping mascot
- FAB: New DM button (opens `newDm` modal), positioned `bottom-20 right-4`

### MobileYouScreen

- Settings gear in header (pushes `settings`)
- Profile card: banner/accent background, avatar (-10 overlap), display name, username, custom status, bio
- Action rows (each pushes a settings sub-screen): Edit Profile, Friends, Connections, Voice & Video
- Log Out button with `ConfirmDialog`

---

## Pushed Screen Components

### MobileChatScreen

Params: `{ channelId, spaceId }`

- Loads messages and sets current channel on mount via `useChatStore`
- Resolves channel name: DM names from member list (group: comma-separated), space channels by `#name`
- Custom header with back button + channel name + members button (space channels only)
- Members button pushes `members` screen (not shown for DMs)
- Renders `MessageList`, `TypingIndicator`, `MessageInput`

### MobileSettingsScreen

Two modes controlled by `initialPanel` prop:

1. **Hub mode** (`initialPanel` undefined): List of setting sections (Account, Voice & Video, Privacy, Connections, Instance for admins). Each pushes `settings-{id}`.
2. **Direct panel mode** (`initialPanel` set): Renders the corresponding panel component (AccountPanel, VoicePanel, PrivacyPanel, ConnectionsPanel) directly with a back header.

### MobileInstancePanel

Admin-only instance settings hub. Pre-fetches instance settings and streaming limits on mount. Lists six sub-sections (General, Registration, Federation, Streaming, Storage, Users), each pushing `settings-instance-{id}`. Mirrors the desktop `InstancePanel` exactly.

The Federation row carries a numeric badge driven by `uiStore.federationApprovalCount` (capped at `99+`, styled like the unread-DM badge in `MobileBottomNav`). The badge source has two paths:

1. **Initial / standalone fetch:** `MobileInstancePanel` calls `api.federation.approvalRequests()` on mount and re-fetches when `onFederationPeersChanged` fires (mirrors what `FederationPanel`'s internal `PendingApprovals` component does). This makes the badge accurate before the admin enters the Federation panel.
2. **Live updates while inside the panel:** the wrapper around `FederationPanel` in `MobileShell.tsx` forwards the panel's `onApprovalCountChange` callback into `uiStore.setFederationApprovalCount`. As the admin approves/denies requests inside the panel, the count drops and the badge in the parent hub stays in sync.

`MobileInstancePanel` is rendered behind a top-level `isAdmin` guard from `MobileSettingsScreen` — non-admin users cannot reach it.

### MobileMembersScreen

Params: `{ spaceId? }` (falls back to `currentSpaceId`)

- Groups online members by their highest-positioned role
- Owner gets special `__owner__` group (position Infinity)
- Offline members in separate section
- Each member row: avatar with status, role-colored name, federated domain, activity card
- Tap opens `user-profile` screen

Member group resolution (`getMemberGroup`):
1. Owner: `{ key: '__owner__', label: 'OWNER', position: Infinity }`
2. Has roles: top role by position `{ key: roleId, label: ROLE_NAME, position }`
3. No roles: `{ key: '__online__', label: 'ONLINE', position: -1 }`

### MobileScreenHeader

Reusable header component used by `MobileInstancePanel`, `MobileMembersScreen`, and inline in screenMap wrappers.

```ts
interface MobileScreenHeaderProps {
  title: string;
  rightActions?: React.ReactNode;
}
```

- Height: 48px (`h-12`)
- Back button calls `popMobileScreen()`
- Bottom border: `border-border-soft`
- Background: `bg-surface-base`

---

## Voice Overlay

### MobileVoiceMiniBar

File: `MobileVoiceMiniBar.tsx`

**Visibility rules:**
- Shown when `currentVoiceChannelId` is truthy
- Hidden when `voice-full` is the top screen in `mobileStack`

**Layout:** `glass-bubble` container, `mx-2 mb-1 rounded-2xl`. Positioned between `MobileScreenStack` and `MobileBottomNav` in the DOM.

**Content:**
- Left: mint circle icon + channel name + participant count (tap expands to `voice-full`)
- Right: mute toggle, deafen toggle, disconnect button
- Quick controls use `e.stopPropagation()` to prevent expanding on control taps

**Disconnect logic:** Handles both DM calls (`dm_call_end` WS event) and space voice channels (`voice_leave` WS event), calls `disconnectFn`, clears `activeDmCall`.

### MobileVoiceFullScreen

File: `MobileVoiceFullScreen.tsx`

**Header:** Collapse chevron (down arrow, pops screen), channel name, space name subtitle, participant count, members button (space channels only).

**Participant grid:**
- `grid-cols-1` for 1-2 participants, `grid-cols-2` for 3+
- Avatar size: 80px for 1-2 participants, 56px for 3+
- Mute/deafen badge overlay on avatar (bottom-right, rose circle with icon)
- Shows self-mute, space mute, permission mute, self-deafen, space deafen
- Context menu on other participants: voice mod items, local mute checkbox, volume slider

**Control bar:** `glass-bubble` container with safe area padding.

| Button | State Colors |
|--------|-------------|
| Mute | Active: `bg-accent-rose/20 text-accent-rose`, Inactive: `bg-surface-elevated text-txt-primary` |
| Deafen | Same as mute |
| Camera | Active: `bg-accent-mint/20 text-accent-mint`, Inactive: same |
| Screen share | Same as camera |
| Disconnect | Always `bg-accent-rose text-white` |

**Disconnect:** Same logic as mini-bar (handles DM calls and space voice, calls `disconnectFn`, pops screen).

**Guard:** If `currentVoiceChannelId` is falsy, calls `popMobileScreen()` and returns null.

---

## MobileFolderSheet

File: `MobileFolderSheet.tsx`

Bottom sheet for viewing and managing space folders.

**Presentation:**
- Fixed overlay: `z-[300]` backdrop + `z-[301]` sheet
- Glass: `glass-modal` surface tier
- Animation: `animate-slide-up-sheet` (200ms ease-out translateY)
- Max height: `60vh`
- Drag handle: 10x1 rounded pill

**Props:**

```ts
interface MobileFolderSheetProps {
  folder: SpaceFolder;
  onClose: () => void;
  onSelectSpace: (spaceId: string) => void;
  onUpdateFolder: (folderId: string, updates: { name?: string | null; color?: string | null }) => void;
  onUngroup: (folderId: string) => void;
}
```

**Features:**
- Folder header with color swatch, name (inline editable), space count
- Context menu: Rename, Color picker (7 accent colors + clear), Ungroup (danger)
- Space list with gradient/icon thumbnails, tap selects space and closes sheet

**Folder colors:**

| Name | Value |
|------|-------|
| Mint | `rgb(var(--accent-mint))` |
| Peach | `rgb(var(--accent-peach))` |
| Lavender | `rgb(var(--accent-lavender))` |
| Sky | `rgb(var(--accent-sky))` |
| Amber | `rgb(var(--accent-amber))` |
| Rose | `rgb(var(--accent-rose))` |
| Coral | `rgb(var(--accent-coral))` |

---

## MobileNav (Legacy)

File: `MobileNav.tsx`

A hamburger-menu component that predates `MobileShell`. It renders a fixed-position toggle button (`z-[120]`) and a backdrop overlay (`z-[35]`). Only renders when `isMobile === true` (via `if (!isMobile) return null`).

This component provides sidebar toggle functionality for contexts where `MobileShell` is not the active layout. It is separate from the MobileShell tab-based navigation.

---

## Safe Area Handling

Several mobile components respect the iOS safe area inset:

| Component | CSS |
|-----------|-----|
| MobileBottomNav | `paddingBottom: env(safe-area-inset-bottom)`, height includes inset |
| MobileVoiceFullScreen control bar | `marginBottom: calc(0.5rem + env(safe-area-inset-bottom))` |
| MobileFolderSheet | `paddingBottom: env(safe-area-inset-bottom)` |
| MobileSpacesScreen add sheet | `paddingBottom: env(safe-area-inset-bottom)` |

The root MobileShell uses `height: 100dvh` (dynamic viewport height) to account for mobile browser chrome.

---

## Z-Index Layers

| Layer | Z-Index | Component |
|-------|---------|-----------|
| Stacked screens | `z-10` | MobileScreenStack pushed screens |
| MobileNav backdrop | `z-[35]` | MobileNav sidebar overlay |
| MobileNav hamburger | `z-[120]` | MobileNav toggle button |
| DMs FAB | `z-20` | MobileDmsScreen new DM button |
| Bottom sheets (backdrop) | `z-[300]` | MobileFolderSheet, Add Space sheet, ContextMenu |
| Bottom sheets (content) | `z-[301]` | MobileFolderSheet, Add Space sheet, ContextMenu |

---

## LocalStorage Persistence

The uiStore uses `zustand/persist` with `partialize`:

```ts
partialize: (state) => ({
  memberListOpen: state.memberListOpen,
  lastChannelPerSpace: state.lastChannelPerSpace,
})
```

Only `memberListOpen` and `lastChannelPerSpace` persist. Mobile navigation state (`mobileScreen`, `mobileStack`) is ephemeral and resets on page reload.

`lastChannelPerSpace` is used by `MobileBottomNav` to navigate to the last-viewed channel when the Spaces tab is tapped, and by `MobileSpacesScreen` when a text channel is opened (via `setLastChannel`).
