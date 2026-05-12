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
- `packages/web/src/hooks/useDragToClose.ts` — Bottom-sheet drag-down-to-dismiss gesture hook (shared by `InputPopover.MobileSheet`, `MobileVoiceJoinSheet`, `MobileFolderSheet`)
- `packages/web/src/hooks/useVisualViewportInset.ts` — Returns the bottom inset that floating overlays must use to sit above the iOS soft keyboard (when open) or above the home-indicator safe area (when closed). Used by `MessageInput` for the floating composer-bubble's `bottom` value.
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
| Spaces | Navigates to `/channels/<currentSpaceId ?? lastSelectedSpaceId>` if either is set, otherwise `/` (which redirects to `/channels/@me`) |
| DMs | Navigates to `/channels/@me` |
| You | No navigation (stays on current route) |

All tabs call `setMobileTab(tab)` which clears the mobile stack.

The Spaces tab prefers `useSpaceStore.getState().currentSpaceId` — the canonical "currently selected space" — and falls back to `lastSelectedSpaceId`, a sticky memory in `useSpaceStore` that survives `@me` navigation. `currentSpaceId` is the canonical answer when available (URL routing, the space strip, SpaceInviteCard joins all set it), but `AppLayout`'s URL effect clears `currentSpaceId` to null whenever the URL is `/channels/@me`. Without the sticky fallback, returning to Spaces after a DMs/Friends/Settings detour would have nothing to anchor to and `MobileSpacesScreen`'s auto-select would fall back to `spaces[0]`. The previous `Object.keys(lastChannelPerSpace)[0]` approach was wrong for a different reason (it returned the first-inserted key, locking the tab to whichever space the user opened first in their session); `lastChannelPerSpace` is still used by `MobileSpacesScreen.setLastChannel` for the per-space last-channel-jump-on-channel-tap feature — that remains a separate concern.

`MobileSpacesScreen` mirrors the same fallback at mount: `useState(currentSpaceId ?? lastSelectedSpaceId)`. After a DM detour the screen remounts with `currentSpaceId === null` (cleared by AppLayout) but the sticky memory still resolves to the previously-selected space. The local `setCurrentSpace(selectedSpaceId)` effect then restores `currentSpaceId` to that value, so the rest of the app sees a consistent selection.

`lastSelectedSpaceId` lifecycle (defined in `useSpaceStore`):

- Updated on every `setCurrentSpace(non-null)` call and on `loadSpaceDetail` success.
- NOT cleared by `setCurrentSpace(null)` — that's the whole point.
- Cleared to null only when the remembered space is actually removed: `deleteSpace`, `leaveSpace`, `removeSpace` (kicked / WS event), `removeInstanceSpaces` (instance disconnect/removal), `reset` (logout).
- Ephemeral — not persisted to localStorage. On page reload the URL drives initial state; the sticky memory only matters within a session, between tab cycles.

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
| `settings-keybinds` | `MobileSettingsScreen` | `initialPanel="keybinds"` (Electron-only entry; map row always present) |
| `settings-desktop` | `MobileSettingsScreen` | `initialPanel="desktop"` (Electron-only entry; map row always present) |
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
- **Loading skeleton:** while `useSpaceStore.loadingSpaceId === selectedSpaceId`, the channel-list area renders a shimmer skeleton (uncategorized rows + category header + categorized rows). Gated through `useDelayedLoading` so cached/fast loads don't flash the placeholder. Mirrors desktop `ChannelSidebar`'s `showChannelSkeleton`. Skeleton row geometry matches the real channel rows (`px-3 py-2` with `w-4 h-4` icon → ~36px row).
- **Empty-state mascot — settle gate:** the "No channels yet." mascot must NOT render during the pre-skeleton load window (the < 200 ms threshold of `useDelayedLoading`). Without a settle gate, every space switch flashes the mascot for ~50–200 ms because `state.channels` only ever holds the most-recently loaded space's channels — `spaceChannels` filters to `[]` immediately on selection change while `loadSpaceDetail` is still in flight. The mascot is gated on `isSpaceSettledEmpty = !isLoadingSelectedSpace && loadedSpaceIds.has(selectedSpaceId) && spaceChannels.length === 0`. `loadedSpaceIds` is a `Set<string>` on `useSpaceStore`, populated only on successful `loadSpaceDetail` completion (not on failed loads), and pruned on `deleteSpace` / `leaveSpace` / `removeSpace` / `removeInstanceSpaces` / `reset`. Render order is therefore: skeleton (loading, > threshold) → blank (loading, < threshold) → mascot (settled empty) → real channel list. Desktop `ChannelSidebar` has no empty-state branch, so this asymmetry is mobile-only.

**Layout resolution:**
- `spaceLayout` array items can be `{ t: 's', id }` (space) or `{ t: 'f', id }` (folder)
- Spaces not in the layout are appended at the end
- Folder items render as folder icon buttons that open `MobileFolderSheet`

### MobileDmsScreen

- Header: "Messages" title + "Friends" button
- Online friends activity row (horizontal scroll, shows avatar + status dot)
- DM list sorted by last message time (newest first)
- Each DM row: avatar, name, message preview, timestamp, unread dot
- Group DMs: rendered via the shared `<AvatarStack>` (size 40, `border="channel"`, `iconUrl={dm.icon}`) so single-other-member groups, 2-member overlap, and 3+ grids match the desktop sidebar; group name uses `dm.name ?? otherMembers.map(displayName).join(', ')`. A federation globe renders next to the name when any group member is federated. Context menu: "Leave Group".
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
- Custom header with back button + channel name + members/group-info button
- Members button shows for space channels AND group DMs; hidden for 1-on-1 DMs (no roster). Space channels push the `members` screen; group DMs push the `group-dm-info` screen so the user lands on the full info + management surface (`MobileGroupDmInfo`).
- Renders `MessageList`, `TypingIndicator`, `MessageInput`

### MobileSettingsScreen

Two modes controlled by `initialPanel` prop:

1. **Hub mode** (`initialPanel` undefined): List of setting sections (Account, Voice & Video, Privacy, Connections, Keybinds + Desktop when in Electron, Instance for admins). Each pushes `settings-{id}`.
2. **Direct panel mode** (`initialPanel` set): Renders the corresponding panel component (AccountPanel, VoicePanel, PrivacyPanel, ConnectionsPanel, KeybindsPanel, DesktopPanel) directly with a back header.

**Electron-only entries.** The Keybinds and Desktop sections appear in the hub list only when `isElectron() === true` (mirrors the desktop `UserSettings` modal's gate on `DesktopPanel`). Rationale:
- `DesktopPanel` exposes auto-launch, app-version + update check, and "Change Instance" — all of which call `window.backspace.*` IPC and are meaningless on web/iOS PWA.
- `KeybindsPanel`'s value comes from the desktop app's `uiohook-napi`-backed global keybind manager. The web fallback (only-when-tab-focused, no global hooks, no recording flow on touch keyboards) has no useful surface for a phone-shaped viewport. Showing the panel anyway would mislead a mobile-web user into recording a binding that can never fire.

Both panels are mobile-fit at 360-390px viewports (single-column rows with `flex justify-between`, `min-w-0` on labels, small tap-target buttons). The gate is therefore a list-visibility decision, not a layout decision — once a desktop user happens to be on a narrow viewport (split-window, dock, etc.), the panels render correctly.

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

**Loading skeleton:** while `useSpaceStore.loadingSpaceId === spaceId` (the same flag that gates `MobileSpacesScreen`'s channel-list skeleton — `loadSpaceDetail` populates members alongside channels), the screen renders a shimmer skeleton (two role-section headers + circular avatar placeholders + name bars). Gated through `useDelayedLoading` so cached/fast loads don't flash the placeholder. Mirrors desktop `MemberSidebar`'s `showMemberSkeleton`. Skeleton row geometry matches the real member rows (`gap-2.5 px-2 py-2.5` with `w-9 h-9` avatar → ~52px row).

### MobileGroupDmInfo

Params: `{ channelId }`

Pushed by `MobileChatScreen`'s members button when the active channel is a group DM. Mirrors `MobileMembersScreen`'s scroll-body geometry and condenses the desktop `GroupDmSettings` modal + `DmRosterPanel` into a single column.

Layout:
- Header (`MobileScreenHeader`): "Group Info" + back button.
- Hero: `<AvatarStack size=80 border="modal" iconUrl={dm.icon}>` (or icon when set), large group name (`dm.name ?? comma-joined fallback`), `N members`, and an Edit button (owner-only) that toggles **inline edit mode** — name becomes a text input; tapping the icon opens the existing `ImageCropModal` (also used by `RegisterPage` and `CreateSpace`). Save/Cancel bar appears at the bottom of the screen, positioned via `useVisualViewportInset` so it rides above the iOS keyboard. Upload defers to Save (no orphan uploads).
- Actions row: Add Member (any-member; opens `AddDmMemberModal`).
- Members list: OWNER (crown badge), ONLINE, OFFLINE (dimmed). Uses the shared `DmMemberRow` component. Tap → `user-profile` screen. Long-press OR always-visible kebab → context menu (`Transfer Ownership` and `Remove from Group` are owner-only and hidden on self; `Remove Friend` shown when row user is a friend AND not self). The federation globe renders without a long-press tooltip — the per-row `@domain` subtitle already surfaces federated identity, so a tooltip would be redundant.
- Destructive footer: "Leave Group" (red).

Owner-only API calls (`updateMetadata`, `kickMember`, `transferOwnership`) route through `getApiForOrigin(getOwnerInstanceForDm(channelId))` — see `docs/systems/dm-system.md` "Owner-Only Routing Helper" for why this is distinct from `getChannelOrigin`.

### MobileScreenHeader

Reusable header component used by `MobileInstancePanel`, `MobileMembersScreen`, `MobileSettingsScreen`, and inline in screenMap wrappers.

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

**Canonical pattern — TransferIndicator in `rightActions`:** every settings/instance screen mounts `<TransferIndicator />` via the `rightActions` slot so an in-flight profile/banner upload (or any transfer initiated before navigating into settings) remains visible and controllable from the screen the user is currently on. Wired in: `MobileSettingsScreen` (hub + each direct panel mode), `MobileInstancePanel`, all six `settings-instance-*` wrappers in `MobileShell.tsx` (general / registration / federation / streaming / storage / users). The indicator is idle-cheap — a single Map subscription + small icon button when no transfers are active — so mounting it on every settings screen has no measurable performance cost. See `docs/systems/uploads.md` for the transfer-chrome surface inventory.

`MobileChatScreen` uses its own inline header (not `MobileScreenHeader`) and mounts `TransferIndicator` directly. The dropdown panel renders below the trigger via `absolute right-0 top-full mt-2` and is width-capped at `min(300px, calc(100vw - 16px))` to avoid clipping on narrow viewports. Click-outside dismissal listens to both `mousedown` and `touchstart` so iOS Safari closes the tray on a single tap.

---

## Voice Overlay

**Mobile is the sole owner of voice overlay chrome.** `<PictureInPicture />` is a desktop-only component; `AppLayout`'s mobile branch does NOT mount it. The mobile equivalents are `MobileVoiceMiniBar` (always-visible call-active overlay between the screen stack and bottom nav) and `MobileVoiceFullScreen` (pushed-screen full takeover). Mounting PiP on mobile would render its 320×180 floating box on top of the mobile shell whenever `currentVoiceChannelId` was set but `voice-full` was not on the stack — the symptom that triggered this split was a "PiP-style grey view" appearing immediately after `MobileVoiceJoinSheet`'s Join button (compounded by a misnamed screen key — see "Voice Join Flow" below).

### Voice Join Flow (Mobile)

`MobileSpacesScreen.handleVoiceJoin` is the single entry point on mobile:

1. Apply pre-mute if requested (`voiceStore.setMuted(true)`).
2. Call `joinVoiceChannel(channelId, connectFn)` (which sends `voice_join` WS, gets a LiveKit token, and connects the room).
3. Close the join sheet (`setVoiceJoinChannelId(null)`).
4. `pushMobileScreen('voice-full')` — must match the canonical key in `MobileShell.screenMap`. A historical bug passed `'voice'`, which had no entry; the renderer returned null while the root screen sat under `visibility: hidden`, making the (incorrectly mounted) desktop PiP the only visible UI. Both have been root-fixed.

The user lands directly in `MobileVoiceFullScreen` — there is no intermediate "connecting" screen. While LiveKit handshakes, the participant grid renders with whatever the WS `voice_users` map already contains (typically just the local user) and updates as remote participants arrive.

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

**Participant grid:** **Renders `<VoiceGrid participants={participants} />` from `packages/web/src/components/voice/VoiceGrid.tsx` — the same component desktop uses.** This is the source of the camera + screen-share rendering pipeline; mobile has no separate tile components. Reusing `VoiceGrid` gives mobile feature parity with desktop for free:

- Camera tracks (`p.videoTrack` from `ParticipantInfo`) attach to a `<video>` element via LiveKit's `Track.attach(el)` so the SFU adaptive-stream observer can downshift simulcast layers based on the tile's painted pixel size — automatically scaling quality down on phone-shaped tiles.
- Local camera: the local participant's `videoTrack` is attached identically, with `muted` on the `<video>` element so the user's own camera doesn't echo through their speakers. (`VoiceUser` sets `muted={isLocal}`.)
- Remote screen-share tracks render in their own `StreamTile` (one extra tile per streaming participant) — the user must tap "Watch Stream" or focus the tile to subscribe; until then it's an avatar placeholder. `setStreamSubscription` and the `stream_watch` data-channel protocol fire identically on mobile.
- Tap-to-focus: tapping any tile sets `voiceStore.focusedParticipantId` and the grid switches into the focused-publisher layout (one large tile + bottom strip of others). This works through touch events without modification.
- Mute / deafen / camera badges, speaking-ring, "(you)" suffix, context-menu (right-click on desktop, long-press on iOS — Safari fires `contextmenu` on long-press), local-mute/volume sliders, watch/unwatch — all carry over.

**Auto-focus on screen-share (mobile-only).** When `MobileVoiceFullScreen` mounts (or while it's already mounted) and a screen-share publication appears, the screen sets `focusedParticipantId` to the first live `${identity}:stream` tile so the user lands directly on the watchable stream. Two refs gate the behaviour:

- `userTouchedFocusRef` — flips `true` the first time `focusedParticipantId` changes to anything other than the auto-focused key, or to `null` after auto-focus had been set. Once flipped it stays flipped for the screen lifetime; auto-focus bails out. This means a user who explicitly dismisses focus via the Grid button never has it forced back on, even if a new screen-share starts.
- `lastAutoFocusedKeyRef` — records the key we last auto-focused so the user-interaction detection can distinguish "user picked a different tile" from "we just set it ourselves".

The unmount cleanup clears `focusedParticipantId` so re-entering the call screen is a clean slate. Desktop is unaffected — auto-focus lives in `MobileVoiceFullScreen`, not `VoiceGrid`.

**Control bar:** `glass-bubble` container with safe area padding. Five round buttons.

| Button | Action | State Colors |
|--------|--------|-------------|
| Mute | `voiceStore.toggleMic` | Active: `bg-accent-rose/20 text-accent-rose`, Inactive: `bg-surface-elevated text-txt-primary` |
| Deafen | `voiceStore.toggleDeafen` | Same as mute |
| Camera | `handleCameraAction` (canonical, from `utils/voiceActions`) | Active: `bg-accent-mint/20 text-accent-mint`, Inactive: same |
| Screen share | `handleScreenShareAction` (canonical, from `utils/voiceActions`) | Same as camera |
| Disconnect | DM call or space voice teardown + pop screen | Always `bg-accent-rose text-white` |

**Screen-share button wiring (load-bearing).** The button calls `handleScreenShareAction`, **not** `voiceStore.toggleScreenShare`. The store action only flips the boolean — it never calls `getDisplayMedia` or publishes a track. `handleScreenShareAction` is the canonical path (also used by `VoiceControlBar` and the keybind handler) that calls `startScreenShare(room)` / `stopScreenShare(room)` and broadcasts voice status. iOS Safari does not support `getDisplayMedia` and the call rejects there — that's a platform limitation, not a Backspace bug; the same call behaves identically on desktop and Android.

**In-call camera switcher (mobile-only).** When `isCameraOn === true` AND `enumerateDevices()` returns more than one `videoinput`, a small chevron pill ("Switch camera", `aria-haspopup="menu"`) is overlaid on the top-right corner of the camera control button. Tapping it opens an upward-expanding menu portaled to `document.body` (so the popup escapes the control bar's `glass-bubble` clipping), pinned to the chevron's screen rect via `getBoundingClientRect()` and re-pinned on resize / capturing scroll. The menu lists every videoinput plus an "Auto (system default)" entry; the current selection is highlighted via `aria-checked` + a `text-txt-primary` accent. Selecting an entry calls `voiceStore.setCameraDeviceId(deviceId)` and closes the picker. The `useLiveKit` `syncCamera` effect picks up the store change and calls `room.switchActiveDevice('videoinput', target)` for an in-place hot-swap (no republish) — see `docs/systems/voice.md` "Hot-swap mid-call". Click-outside dismissal listens to both `mousedown` AND `touchstart` (iOS Safari does not synthesize `mousedown` reliably from a single tap).

The chevron is gated on `isCameraOn && cameraDevices.length > 1` so single-camera phones / desktops never see it. On iOS Safari the videoinput list is populated only after the OS-level camera permission has been granted at least once in the current session — that grant happens when the user first turns on the camera via `handleCameraAction` (which calls `getUserMedia`), so by the time the chevron is eligible to show, labels and device IDs are available. Before grant, `enumerateDevices()` returns one entry with empty `deviceId` and no label; the gate (`length > 1`) keeps the chevron hidden, so the user sees no broken-state UI.

**Voice tile text-selection suppression.** `VoiceUser` and `StreamTile` outer containers carry `data-context-menu` attribute. The global `@media (max-width: 767px)` rule in `globals.css` applies `user-select: none` (and inheriting `-webkit-touch-callout: none` via the `*` rule) to every `[data-context-menu]` element, which also inherits to children. Without this, iOS Safari's long-press handler synthesizes the context menu correctly via `useGlobalLongPress`, but the OS *also* triggers native text selection during the 500 ms hold, leaving the entire page's text highlighted in the background after the menu opens. The `data-context-menu` opt-in is the established convention used by `Message.tsx`, `MobileDmsScreen.tsx`, `MobileFolderSheet.tsx`, and `MobileSpacesScreen.tsx`.

**Disconnect:** Same logic as mini-bar (handles DM calls and space voice, calls `disconnectFn`, pops screen).

**Guard:** If `currentVoiceChannelId` is falsy, calls `popMobileScreen()` and returns null.

**Layout sizing.** The grid body is `flex-1` between the 48 px header and the floating control bar; on a 390 × 844 viewport the body is roughly 390 × 720, so:

- **1 participant:** the lone tile fills the body minus padding (~366 × 206 at 16 : 9). Just the local user's avatar / camera with the standard speaking-ring + name overlay.
- **2 participants:** `useGridLayout` picks the configuration that maximises tile area. On a portrait phone that's `cols=1, rows=2` — two stacked 16 : 9 tiles ~366 × 200 each, vertically centred.
- **3–4 participants:** typically `cols=2, rows=2` (4) or `cols=1, rows=3` (3). The same area-maximising algorithm runs on mobile and desktop; nothing is mobile-specific.
- **Focused mode:** the focused tile fills the body minus the 120 px (max 20 vh) bottom strip; the strip horizontally scrolls if other-participant count exceeds the visible width.

No mobile-specific min-tile clamp exists. If the area-maximising solver picks an absurdly small tile for many participants, paginate-or-scroll is intentionally not added — the issue is symmetric with desktop and any future mobile-only paginator should land on desktop too.

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
| MessageInput | `bottom: calc(env(safe-area-inset-bottom) + 6px)` (keyboard closed) / `0px` (keyboard open) — see "Floating Composer" below |

The root `MobileShell` normally uses `height: 100dvh` (dynamic viewport height) to account for mobile browser chrome. **When the iOS soft keyboard is open** (detected via `useVisualViewportInset().keyboardOpen`), the shell switches to `height: ${visualViewport.height}px` so the visible region of the shell is exactly the area above the keyboard. This is the load-bearing mechanism for the floating composer landing flush against the keyboard top — see "Floating Composer" below.

---

## Floating Composer (Chat MessageInput)

The chat composer (`MessageInput.tsx`) is a `glass-bubble` floating overlay on **both** desktop and mobile — there is no flow-positioned mobile branch. The pattern is shared so feature parity is automatic.

### Layout model

```
┌──────────────────────────────────────────────┐
│  MobileChatScreen / MainContent              │  ← `relative flex flex-col`
│  ┌────────────────────────────────────────┐  │
│  │ <MessageList />                        │  │  ← fills the chat region
│  │   (scrolls; content's `paddingBottom`  │  │
│  │   = `var(--composer-clearance, 80px)`  │  │
│  │   so the last message always clears    │  │
│  │   the bubble with a 12px breathing gap)│  │
│  └────────────────────────────────────────┘  │
│  ┌────────────────────────────────────────┐  │
│  │ <MessageInput />                       │  │  ← `position: absolute`
│  │  glass-bubble, translucent             │  │     `left-2 right-2 z-[110]`
│  │  bottom = 0 (kbd open) / safe+6 (kbd   │  │     (mobile) / `md:left-3 md:right-3 md:bottom-3` (desktop)
│  │  closed). Writes --composer-clearance  │  │
│  │  on its parent via ResizeObserver.     │  │
│  └────────────────────────────────────────┘  │
└──────────────────────────────────────────────┘
```

The MessageList scroll region fills the entire chat area. The composer is `position: absolute` and overlays the bottom; messages scroll *behind* the translucent bubble. **Containers must declare `position: relative`** for the composer's absolute positioning to resolve correctly — `MainContent` does this on its outermost flex column; `MobileChatScreen` does this on the inner messages-and-composer wrapper.

### Last-message clearance — the `--composer-clearance` CSS variable

The MessageList content's `paddingBottom` is **dynamic**, driven by a CSS variable named `--composer-clearance` written to the chat region's wrapper element by `MessageInput` via a `ResizeObserver`:

```
--composer-clearance = composer.height + composer.bottom-offset + 12 px
```

Where `bottom-offset` is the gap between the wrapper's bottom edge and the composer's bottom edge (i.e. the resolved value of the composer's `bottom` style — `12 px` on desktop, `env(safe-area-inset-bottom) + 6` ≈ `40 px` on iPhone with keyboard closed, `0` on mobile with keyboard open). The `+12 px` constant is the desired breathing-room gap between the last message's bottom edge and the composer's top edge.

`MessageList` reads `var(--composer-clearance, 80px)` as `paddingBottom`. The `80px` fallback covers the brief mount window before the first measurement, plus any future surface that mounts a `MessageList` without a sibling `MessageInput`.

**Why dynamic?** The previous static `pb-20` (80 px) was sized for the desktop case (composer ≈ 50 px tall + 12 px bottom = 62 px, leaving 18 px of gap). On iPhone with the keyboard closed, the composer's bottom-offset is `env(safe-area-inset-bottom) + 6` ≈ 40 px, so `composer-height + bottom-offset` ≈ `44 + 40` = `84 px` — already exceeding the 80 px `pb-20`, with **negative** breathing room. The composer also grows when the user replies to a message (banner adds 36 px) or stages attachments (tile row adds 184 px), so any static value is wrong for some configurations. The ResizeObserver-driven CSS variable is the only correct model.

The variable is scoped to the chat region's wrapper rather than `:root` so future multi-pane layouts (e.g. side-by-side DM list + chat, voice chat side-panel) don't cross-talk; a wrapper-scoped variable inherits naturally to its `MessageList` descendant.

### `useVisualViewportInset()` — keyboard-aware geometry

iOS Safari's `env(safe-area-inset-bottom)` is defined relative to the **layout** viewport (full screen), not the **visual** viewport (the visible region above the soft keyboard). When the iOS soft keyboard slides up, the layout viewport stays the same height and `safe-area-inset-bottom` still reports ~34 px (the home-indicator inset). A composer pinned to `bottom: env(safe-area-inset-bottom) + 6 px` therefore ends up `~40 px` above the layout-bottom, which on iPhone 14 Pro is `300+ px` above the keyboard — there is a huge empty gap between the composer and the keyboard top.

The hook subscribes to `window.visualViewport.resize` / `scroll` and computes:

```
keyboardOcclusion = window.innerHeight - (visualViewport.offsetTop + visualViewport.height)
```

It returns `{ value, keyboardOpen, height, offsetTop }`:
- `value` — `'<n>px'` when the keyboard is open (the occlusion), or the literal `'env(safe-area-inset-bottom)'` string when it is not. Provided for legacy / fallback use.
- `keyboardOpen` — `true` when `keyboardOcclusion > 1`.
- `textInputFocused` — `true` while a text-entry element holds focus. Required for iOS PWA standalone where iOS itself shrinks the layout viewport for the keyboard, so `vv.height === innerHeight` and `keyboardOpen` stays `false` even though the keyboard IS up. Consumers OR `keyboardOpen || textInputFocused` to detect "keyboard probably open". The state-equality check inside the hook MUST include this field — historically it was missing, so on iOS PWA the hook silently dropped focus changes; the composer's `bottom` style stayed pinned to `env(safe-area-inset-bottom) + 6px` while the keyboard was open, the `--composer-clearance` ResizeObserver effect's deps fired stale values, and on close the last message overlapped the composer's top edge by ~4 px.
- `height` — live `visualViewport.height` in pixels (or `null` if `visualViewport` is unavailable).
- `offsetTop` — live `visualViewport.offsetTop` in pixels.

#### iOS PWA standalone — the load-bearing mechanism

`MobileShell` consumes `{ keyboardOpen, height }` and sets its own `style.height` to `${vv.height}px` whenever the keyboard is open. The chat region's `bottom` edge is therefore exactly the keyboard's top edge, and `<MessageInput style={{ bottom: 0 }}>` lands flush. **This is the primary mechanism, not the inset arithmetic** — sizing the container is far more robust than arithmetic on a `bottom` value, because the math depends on `vv.resize` events firing reliably (which they do not in iOS standalone PWA on several iOS versions). The composer's `bottom` is a simple binary toggle: `0` when keyboard open, `env(safe-area-inset-bottom) + 6 px` when closed.

To cover the case where `vv.resize` fails to fire on iOS PWA (a long-standing standalone-mode bug), the hook **also** listens to `focusin` / `focusout` on `window` for any text-entry element and **polls** `vv.height` at 32 ms intervals for up to 600 ms after the focus change. Polling exits early once the height is stable for two consecutive ticks. This catches the case where iOS silently updates `vv.height` without dispatching a `resize` event — the polling just re-reads the value and re-derives `keyboardOpen`, which then triggers the shell-height update.

When the keyboard is closed, `MobileShell` reverts to `height: 100dvh` so the shell again extends through the home-indicator safe area, and the composer reverts to `bottom: env(safe-area-inset-bottom) + 6 px` so it sits 6 px above the home indicator.

#### Viewport meta hint

`packages/web/index.html`'s viewport `<meta>` includes `interactive-widget=resizes-content`. Chrome (Android) honors this by resizing the layout viewport when the soft keyboard opens, which is the cleaner native equivalent of what `MobileShell` does manually. Safari iOS does not honor it, but it's harmless there.

### MessageInput's mobile vs. desktop class split

The component declares one `composerClass` shared by both modes. Differences:

- Mobile inline `style={{ bottom: keyboardOpen ? '0px' : 'calc(env(safe-area-inset-bottom) + 6px)' }}` — applied only when `useUIStore.isMobile === true`. The hook is safe to call on desktop (no-ops), but the `style` is only emitted on mobile so desktop's CSS-driven `md:bottom-3` (12 px) constant is unaffected by the inline override.
- Tailwind: `absolute left-2 right-2 z-[110] glass-bubble rounded-[14px] md:left-3 md:right-3 md:bottom-3`. The `left-2/right-2` 8 px inset is mobile; `md:left-3/right-3/bottom-3` overrides to 12 px on desktop. `bottom` is intentionally NOT in the Tailwind class on mobile — the inline `style.bottom` provides the dynamic value.

`TypingIndicator` is rendered inside `MessageInput` (anchored `absolute bottom-full` to the bubble) so it appears just above the composer. Mobile chat screens must NOT render an additional `TypingIndicator` themselves.

#### Composer-element ref shape

`MessageInput` tracks the live composer DOM element via a callback ref that fans out to (a) the existing imperative `popoverAnchorRef` (consumed by `InputPopover` and the mention popover for anchor positioning) AND (b) a state-backed `composerEl` slot that drives the `--composer-clearance` ResizeObserver effect. The state-backed slot is required because the component renders different JSX when `canSendMessages` is false (the no-permission early-return path) vs. true (the full composer): a plain `useEffect` keyed only on stable deps would not re-fire when the ref attaches as the JSX flips, leaving the CSS variable unset until the next dep change. Channel permissions arrive asynchronously, so the initial mount renders the no-permission JSX first and re-renders the full composer once permissions resolve — the callback ref's `setComposerEl` call re-fires the effect at that moment.

---

## Bottom-Sheet Drag-to-Close (`useDragToClose`)

File: `packages/web/src/hooks/useDragToClose.ts`

Three hand-rolled bottom sheets share this gesture hook so each surface gets identical iOS-native-feeling dismissal without depending on a third-party gesture library:

| Sheet | File | Drag-handle area |
|---|---|---|
| Emoji / GIF picker | `packages/web/src/components/chat/InputPopover.tsx` (`MobileSheet`) | Visible pill + tab bar |
| Voice-channel join sheet | `packages/web/src/components/voice/MobileVoiceJoinSheet.tsx` | Visible pill + title row |
| Space-folder sheet | `packages/web/src/components/layout/MobileFolderSheet.tsx` | Visible pill + folder header row |

### Hook contract

```ts
const { sheetStyle, handleProps, isDragging, isClosing, hasInteracted } = useDragToClose({
  onClose,                  // required
  closeThreshold = 100,     // px below resting → commits to close on release
  velocityThreshold = 0.5,  // px/ms downward → commits to close on release
  closeAnimationMs = 200,   // close-out transition duration (matches the open keyframe)
  enabled = true,
});
```

- `sheetStyle` — spread onto the sheet container's inline `style`. While dragging, applies `transform: translateY(<dy>px)` with `transition: none` so the sheet follows the finger 1:1. On release, `transition: transform <closeAnimationMs>ms cubic-bezier(0.22, 1, 0.36, 1)` engages and the inline `transform` glides smoothly. If the close gate is met, `dragOffset` is **animated from the current offset directly to viewport height** (no intermediate snap-back to 0), and `onClose` fires after the animation completes.
- `handleProps` — `{ onTouchStart }`. Spread onto the **drag-handle area** (the visible pill + the sheet's header row, never the scrollable content). Scrollable regions and tappable buttons inside the body are unaffected because the document-level `touchmove` / `touchend` listeners are only installed once a drag is in flight.
- `isDragging` — true between `touchstart` and `touchend`.
- `isClosing` — true during the close-out animation phase (after the threshold/velocity gate fires, until `onClose` fires).
- `hasInteracted` — flips `true` on the first touchstart and stays `true` for the lifetime of the consumer mount. **Consumers MUST gate their open-animation classes on `!hasInteracted`** (e.g. `${hasInteracted ? '' : 'animate-slide-up-sheet'}`) so the open keyframe doesn't re-run during snap-back / close-out and fight the inline `transform` driven by `sheetStyle`. Using `isDragging` alone is insufficient — once `isDragging` flips back to false (release), the keyframe re-applies on the next render and the `translateY(100%) → translateY(0)` ramp visually overrides the glide.

### Gesture behaviour

| Phase | Behaviour |
|---|---|
| Touch start on handle | Captures finger Y + `performance.now()`. No visible change yet. `hasInteracted` flips to `true`. |
| Move dy < 6 px | Dead-zone — ignored, native scrolling/pull-to-refresh still possible. |
| Move dy ≥ 6 px | Commits to drag. `e.preventDefault()` blocks scroll/pull-to-refresh. Sheet follows finger. |
| Release dy < 100 px and v < 0.5 px/ms | Snap back: `dragOffset → 0` via inline `transition: transform 200ms cubic-bezier(0.22, 1, 0.36, 1)`. Sheet stays open. |
| Release dy ≥ 100 px **or** v > 0.5 px/ms (and dy > 16 px) | Snap close: `isClosing` flips on, transition engages, `dragOffset` ramps from current value to `window.innerHeight` over `closeAnimationMs`, then `onClose()` fires. **No intermediate snap to 0.** |
| Touch cancel | Snap back to 0 with the same transition (consistent with release-without-commit). |

### Coexistence with other patterns

- **Tap-outside-to-close** stays wired via the existing backdrop `<div>` — independent code path, unaffected by the gesture hook.
- **Tap-on-handle** is treated as a no-op (touch starts and ends inside the dead-zone → no offset → no commit). `hasInteracted` does flip true, but with `dragOffset === 0` the inline transform stays at `translateY(0)` and the visible state matches the open state.
- **iOS pull-to-refresh** is blocked because `touchmove` is non-passive and calls `preventDefault()` once we cross the dead-zone.
- **Internal scrolling** (e.g. emoji grid, GIF results, folder space list) is **untouched** — `handleProps.onTouchStart` is bound to the header element only, so scroll containers below it never enter drag mode.
- **Open animation** (`animate-slide-up-sheet` for `MobileFolderSheet` / `InputPopover.MobileSheet`, the `translate-y-full → translate-y-0` flip for `MobileVoiceJoinSheet`) is gated by `!hasInteracted`. After the first touch, the open class never re-applies for the rest of the sheet's lifetime — the inline `transform` + transition becomes the sole animator for both snap-back and close-out.

---

## Z-Index Layers

| Layer | Z-Index | Component |
|-------|---------|-----------|
| Stacked screens | `z-10` | MobileScreenStack pushed screens |
| MobileNav backdrop | `z-[35]` | MobileNav sidebar overlay |
| MobileNav hamburger | `z-[120]` | MobileNav toggle button |
| DMs FAB | `z-20` | MobileDmsScreen new DM button |
| Toast container | `z-[300]` | ToastContainer (positioning differs by mobile state — see Toast Positioning) |
| Bottom sheets (backdrop) | `z-[300]` | MobileFolderSheet, Add Space sheet, ContextMenu |
| Bottom sheets (content) | `z-[301]` | MobileFolderSheet, Add Space sheet, ContextMenu |

---

## Toast Positioning

`packages/web/src/components/ui/ToastContainer.tsx` is a single shared component. On desktop it renders at `bottom-6 right-6` (anchored bottom-right). On mobile the container is repositioned to clear the bottom chrome and center horizontally so toasts don't get cropped against narrow viewports or hidden behind voice/nav controls.

The mobile bottom offset is computed via `resolveMobileBottomOffset(hasStack, topScreen, inVoice)` and added to `env(safe-area-inset-bottom)`:

| Mobile State | Bottom Offset (above `safe-area-inset-bottom`) | Rationale |
|---|---|---|
| `topScreen === 'voice-full'` | `72px + 12px` | Clears `MobileVoiceFullScreen` control bar (5 round buttons in `glass-bubble` with `mb-2`); bottom nav + mini-bar hidden in this mode |
| Stack non-empty + in voice | `64px + 12px` | Clears `MobileVoiceMiniBar` (sits above the stacked screen since the bottom nav is hidden when stack non-empty) |
| Stack non-empty + no voice | `12px` | Pushed screens have no bottom nav and no mini-bar |
| Root tab + in voice | `56px + 64px + 12px` | Clears `MobileBottomNav` (56px) + `MobileVoiceMiniBar` (~64px) stacked above |
| Root tab + no voice | `56px + 12px` | Clears `MobileBottomNav` only |

On mobile the container also uses `left-3 right-3` + `items-center` instead of `right-6` so toasts center horizontally with `max-w-[320px]`. This avoids horizontal overlap with bottom-bar controls (which span the full mobile width via `mx-2`) and stays inside the safe-tap zone on narrow screens.

The container subscribes to `useUIStore.isMobile`, `useUIStore.mobileStack`, and `useVoiceStore.currentVoiceChannelId`, so the offset re-computes reactively whenever any of those change — no manual repositioning needed when the user enters/exits voice or pushes/pops a screen while a toast is on screen.

---

## Loading Skeletons (Mobile Inventory)

Mobile uses the same `.skeleton` / `.skeleton-bar` / `.skeleton-circle` / `.skeleton-block` CSS primitives as desktop (see `docs/systems/design-system.md`) plus the shared `useDelayedLoading` hook (200 ms threshold + 300 ms minimum display time). All skeleton placements are content-plane elements rendered on the matte surface — never glass.

| Site | Loading source | Status |
|---|---|---|
| App boot (root layout pre-`useAuth.user`) | `useAuth.isLoading` (gated by `useDelayedLoading` in `AppLayout`) | Shared with desktop — `AppLayout` returns the boot skeleton before the mobile/desktop branch split, so both paths show it during cold start |
| `MessageList` initial + pagination | `chatStore` per-channel `isLoading` / `isLoadingMore` | Shared with desktop — `MessageList` is rendered inside both `MainContent` (desktop) and `MobileChatScreen` (mobile) |
| `MobileSpacesScreen` channel list | `useSpaceStore.loadingSpaceId === selectedSpaceId` | Mobile-specific render, mirrors desktop `ChannelSidebar`. Empty-state mascot is settle-gated on `loadedSpaceIds` to avoid flashing during the pre-skeleton load window (see "Empty-state mascot — settle gate" above) |
| `MobileMembersScreen` member list | `useSpaceStore.loadingSpaceId === spaceId` | Mobile-specific render, mirrors desktop `MemberSidebar` |
| `FriendsPage` (mobile) | `socialStore.isLoading && friends.length === 0 && requests.length === 0` | Shared component; renders `LoadingSpinner` (no skeleton) — used unchanged on mobile |
| `ExplorePage` (mobile) | `exploreStore.isLoading && spaces.length === 0` | Shared component; renders `LoadingSpinner` — used unchanged on mobile |
| `GifPicker` (mobile sheet) | per-fetch local state | Shared component; uses `animate-pulse` placeholder tiles — used unchanged on mobile |

**Sizing rule:** mobile skeleton rows must match the row geometry of the real content for that screen so the populate is smooth and no layout shift occurs. The `MobileSpacesScreen` channel-row skeleton is `px-3 py-2` with a `w-4 h-4` icon (~36 px row); the `MobileMembersScreen` row skeleton is `gap-2.5 px-2 py-2.5` with a `w-9 h-9` avatar (~52 px row). Both use staggered `animationDelay` so the shimmer cascades across rows rather than pulsing in lockstep.

**Why no shared `<Skeleton />` primitive:** the project's established pattern composes the existing CSS classes inline at each site (see `AppLayout.tsx`, `ChannelSidebar.tsx`, `MemberSidebar.tsx`, `MessageList.tsx`). Each site needs row geometry that matches its specific layout, so a parameterized component would either over-abstract (`<Row count={N} avatarSize={S} ...>`) or duplicate the inline approach. Adding a JSX wrapper over `<div className="skeleton">` would also obscure the visual diff between the placeholder and the real row it replaces.

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

`lastChannelPerSpace` is used by `MobileSpacesScreen` to remember the most-recent text channel for each space (via `setLastChannel`), and by `AppLayout`'s desktop auto-select effect to land on that channel when the user opens a space without a channelId. It is NOT what the mobile Spaces bottom-nav tap reads — that reads `useSpaceStore`'s `currentSpaceId ?? lastSelectedSpaceId` (see "Tab Tap Behavior" above). `lastSelectedSpaceId` itself lives in `useSpaceStore` and is intentionally NOT persisted — only the in-session sticky-memory semantic matters.
