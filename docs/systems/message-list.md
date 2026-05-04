# Message List & Auto-Scroll

The chat message list (`packages/web/src/components/chat/MessageList.tsx`) is responsible for rendering the message stream, auto-scrolling to follow new content, restoring per-channel scroll positions during a session, dispatching jump-to-message scrolls from search, and triggering load-more pagination at the top.

## Files

| File | Responsibility |
|---|---|
| `packages/web/src/components/chat/MessageList.tsx` | Render the message stream and own all scroll behavior. |
| `packages/web/src/stores/chatStore.ts` | `messages`, `hasMore`, `scrollPositions` (in-memory, session-scoped). |
| `packages/web/src/components/chat/embeds/*.tsx` | Embed renderers — must obey the dimension reservation contract below. |
| `packages/web/src/components/chat/AttachmentRenderer.tsx` | Reference for the dimension reservation pattern (`AttachmentRenderer.tsx:81-100`). |

## ContainerRef invariant

`containerRef.current` (and `contentRef.current`) MUST be non-null for the entire lifetime of any chat view where messages may arrive or scroll-affecting effects can run. Every effect in this file (initial snap A, ResizeObserver B, capture-phase load handler C, scrollend final-pin D, jump-to-message) reads these refs and bails on a null guard. Each of those effects is keyed on `[messages.length, channelId]` or `[hasMessages, channelId]`, and the inbound transition (`0 → N` / `false → true`) is the *only* re-fire signal during a channel-load lifecycle. If a ref is null at the moment that signal fires, the effect bails — and no later dep change will retry it, leaving the channel permanently broken (initial scroll never lands at bottom, ResizeObserver never observes, scrollend never registers, saved-anchor restore never happens).

**Implication for loading UI:** the initial-load skeleton is rendered as an absolutely-positioned overlay on top of the scroll container, NOT as an early return that replaces it. See `MessageList.tsx` (the `showInitialSkeleton` overlay block) for the canonical pattern. Any future loading/empty/error UI added to this component must follow the same rule — overlay, never replace — or the scroll model breaks under slow loads where the skeleton is visible at the moment messages arrive.

## Auto-scroll model

Three effects cooperate. Their ordering is established by the 2026-03-25 race-fix and the 2026-04-25 sentinel addendum.

**Effect A — initial snap / restore.** Runs once when `messages.length` transitions from 0 to N for a channel. Reads `chatStore.scrollPositions.get(channelId)`. If a saved anchor exists, scrolls that message into view and computes the resulting `isAtBottomRef` from actual distance. Otherwise, sets `container.scrollTop = container.scrollHeight`, captures the post-clamp value into `lastProgrammaticBottomScrollRef`, and sets `isAtBottomRef.current = true`. On subsequent message arrivals (`messages.length > prev`), if `isAtBottomRef.current`, sets the typed smooth-scroll intent (`'bottom'`) and smooth-scrolls via `bottomRef.scrollIntoView({ behavior: 'smooth' })`. The smooth animation lands asynchronously across many frames; the intent ref keeps the at-bottom gate open during that window so late-loading media can re-pin (see "Smooth-scroll intent" below), and Effect D delivers a final defensive instant pin when the animation completes.

**Effect B — ResizeObserver.** Observes the message-list content container. When height grows and `isAtBottomRef.current === true`, re-pins to bottom and updates the sentinel. Gated on `isAtBottomRef.current` so it cannot interfere when the user has scrolled away.

**Effect C — capture-phase `load` listener.** Catches image/iframe load completions that ResizeObserver suppresses due to its layout-loop limit. Same gate, same re-pin, same sentinel update.

**Effect D — `scrollend` listener (final defensive pin).** Native `scrollend` event (Chrome 114+, Safari 18+) fires once when a smooth scroll's animation completes. When `smoothScrollIntentRef.current === 'bottom'` at that moment, performs an instant `container.scrollTop = container.scrollHeight`, refreshes the sentinel, sets `isAtBottomRef = true`, and clears the intent. This is the catch-all for layout that grew during the smooth animation but after the animation's terminal target was computed. For browsers without `scrollend`, `beginSmoothScrollIntent` arms a `setTimeout(800ms)` fallback instead — exactly one of the two paths fires per intent. If the user has wheeled away mid-animation past the 5000px threshold (`SMOOTH_SCROLL_USER_INTENT_THRESHOLD`), the final pin is skipped (we honor the user's gesture).

**`handleScroll`.** Runs on every scroll event. **First check:** if `container.scrollTop === lastProgrammaticBottomScrollRef.current`, the event was queued by our own command — re-affirm the at-bottom flags, re-pin defensively (layout may have grown since the command), update the sentinel, and return early. Otherwise, **invalidate the sentinel immediately** (a non-matching event means the user has moved away from the position we last commanded; leaving the stale value live would let a coincidental future scroll-through of the same `scrollTop` falsely match and yank the user to bottom). Then check the smooth-scroll intent: if `intent === 'bottom'`, the deadline hasn't elapsed, AND the user hasn't wheeled away past the 5000px threshold, **suppress the at-bottom flip** — keep `isAtBottomRef = true` so Effects B/C stay open. Otherwise (no intent, expired intent, `intent === 'message'`, or user wheeled away), recompute `distanceFromBottom`, update `isAtBottomRef` and `isNearBottomRef` honestly, track `visibleMsgIdRef` (for position memory), and trigger `loadMoreMessages` when scrolled near the top. **`isNearBottomRef` is always updated honestly** even during suppression — only the at-bottom gate is held open, never the Jump-to-Present visibility.

**Invariant:** `isAtBottomRef` flips from `true` to `false` only when (a) the user genuinely scrolls away outside any active smooth-scroll-to-bottom intent, OR (b) a smooth scroll with `intent === 'message'` legitimately moves the user away from bottom. Layout growth, our own programmatic scrolls, queued scroll events from those programmatic scrolls, and intermediate frames of a smooth-scroll-to-bottom animation do not flip it.

## Smooth-scroll intent

Bottom-bound smooth scrolls (new-message arrival in Effect A, Jump-to-Present click) and jump-to-message smooth scrolls (search result click — animates to a non-bottom target) both run `scrollIntoView({behavior:'smooth'})`, which animates `scrollTop` over many frames. Each intermediate frame fires `handleScroll` with a measured `distanceFromBottom` that does *not* match the smooth animation's terminal frame. Without intent tracking, those intermediate measurements would flip `isAtBottomRef` to false, closing the Effect B/C gates so any media (avatars, embeds, attachment images, Spotify thumbs) that finishes loading mid-animation grows `scrollHeight` while the gate is closed — the smooth scroll then lands at the originally computed (now stale) target, leaving the user above the true bottom.

The fix is a typed intent ref:

| Field | Type | Set by |
|---|---|---|
| `smoothScrollIntentRef` | `'bottom' \| 'message' \| null` | `beginSmoothScrollIntent(intent, label)` |
| `smoothScrollDeadlineRef` | `number` (`performance.now()` ms) | `beginSmoothScrollIntent` (`now + 800`) |

Behavior by intent:

- **`'bottom'`**: `handleScroll` suppresses the at-bottom flip while the deadline hasn't elapsed and the user hasn't wheeled away past 5000px (`SMOOTH_SCROLL_USER_INTENT_THRESHOLD`). Effect D fires the final defensive pin via `scrollend` (or its timeout fallback). Set by: new-message smooth scroll in Effect A, Jump-to-Present `onClick`.
- **`'message'`**: NO suppression — the jump-to-message animation legitimately moves the user away from bottom and `isAtBottomRef` should flip honestly. Effect D clears the intent at scrollend (no defensive pin). Set by: `scrollToMessage` in the jump-to-message effect.

The 5000px user-intent threshold matches the `nearBottom` band: distances larger than that signal a deliberate user gesture (mouse-wheel away mid-animation), and we let the gate flip honestly so the smooth scroll's terminal frames don't fight the user.

## Position memory

- **Storage:** `chatStore.scrollPositions: Map<channelId, messageId>` — in-memory Zustand state.
- **Tracking:** `handleScroll` updates `visibleMsgIdRef.current` to the topmost visible message in real time on every scroll event (when not near bottom).
- **Commit:** the channel-change effect commits `visibleMsgIdRef.current` to `chatStore.scrollPositions` for the *outgoing* channel before resetting state for the incoming one. If the user was at the bottom (`visibleMsgIdRef.current === null`), the entry is removed so the next visit snaps to bottom.
- **Lifetime:** session-only. Lost on reload, app restart, tab close. This is a deliberate design choice — restoring a scroll position from a previous session would be disorienting and would silently swallow new messages the user hasn't seen.
- **Eviction:** scroll positions are evicted alongside messages when `MAX_CACHED_CHANNELS` (`chatStore.ts:10`) is exceeded.

## Embed renderer contract

Every renderer that contains an image, iframe, or video MUST reserve dimensions when they are known. The reference pattern is `AttachmentRenderer.tsx:81-100`. See `docs/systems/embeds.md` for the bidirectional server-and-client contract.

When dimensions are not known (probe failed, no OG tags, non-image type), the renderer must rely on a structurally fixed layout (iframe with hardcoded height, fixed-size thumbnail) rather than a dimension-fallback wrapper. Fallback wrappers using a default `aspect-ratio` (e.g. 4/3) cause visible letterbox bars on content whose true ratio differs — that exact failure caused the revert in commit `0c84029`. The sentinel and Effects B/C absorb residual layout shift from un-reserved content.

Renderers known to satisfy the contract today:
- `AttachmentRenderer.tsx` — reserves from `attachment.width/height`.
- `embeds/ImageEmbed.tsx` — reserves from `embed.width/height` when populated.
- `embeds/VideoEmbed.tsx` — fixed 16:9 reservation for both branches: `aspectRatio: '16/9'` for the direct-video container, `paddingBottom: 56.25%` for the provider-iframe container.
- `embeds/RichEmbed.tsx` — explicit `height` from `getIframeHeight()`; fixed 80×80 thumbnail in collapsed state.
- `embeds/GenericEmbed.tsx` — fixed 80×80 thumbnail.

Renderers that do not reserve (residual shift, sentinel-covered):
- Bare GIF URLs in `Message.tsx` — Tenor/Klipy URLs are not embed records, no dims.
- Markdown inline images in `MarkdownRenderer.tsx` — `![](url)` syntax carries no dims.

## Known limitations

- Bare GIFs and markdown images shift on load. The sentinel keeps the auto-scroll system from being disabled by their shifts; ResizeObserver/load handlers re-pin to bottom while the user is at the bottom.
- The 150px at-bottom tolerance is generous — sending a new message while the user is reading the last few messages 100px up from the bottom yanks them down. This is intentional today; if changed, update this doc and the spec history.
- The smooth-scroll UX is preserved deliberately for both new-message arrival and Jump-to-Present per UX call. The 2026-04-27 fix (smooth-scroll intent + scrollend final pin) closes the residual above-bottom-landing race without removing the animation.

## Out of scope (deferred)

These items were considered and rejected for the 2026-04-25 work; they live here so their failure modes are findable when they actually occur:

- **Persisting `scrollPositions` across reloads.** Rejected — would silently hide new messages and confuse users returning to old context.
- **Explicit `{ atBottom: true }` flag in `scrollPositions`.** The current "absence of entry = at bottom" coupling is structurally fragile (LRU eviction silently turns "scrolled up" state into "at bottom"), but `MAX_CACHED_CHANNELS = 20` makes this rare in practice and there is no verified user-visible failure today.
- **Save-on-unmount of the visible-message anchor.** The current commit-on-channel-switch path doesn't fire if the component unmounts via route change or tab close. No verified user-visible failure today.
- **Tightening the 150px at-bottom tolerance.** Separate UX decision, not driven by any current bug.

## History

- 2026-03-25 — `chat-scroll-race-fix` spec: removed `isAtBottom` from Effect A's deps, gated Effects B and C on `isAtBottomRef`, set the ref after initial snap. Shipped.
- 2026-03-25 — `embed-dimension-reservation` spec: server probes image embeds for dimensions; client renderers reserve via `aspect-ratio`. Server side shipped. Client side partly shipped, then reverted in `0c84029` because the 4/3 fallback caused dark letterbox bars.
- 2026-04-25 — `message-list-scroll-completion-and-addendum` spec: restored the *known-dimension-only* branch of the client reservation in `ImageEmbed.tsx`; added the `lastProgrammaticBottomScrollRef` sentinel to close the residual `handleScroll` race; created this file.
- 2026-04-27 — smooth-scroll intent + `scrollend` final pin: typed `smoothScrollIntentRef` (`'bottom' | 'message' | null`) with an 800ms deadline. `handleScroll` suppresses the at-bottom flip while a `'bottom'` intent is active and the user hasn't wheeled past the 5000px threshold; the gate stays open so Effects B/C re-pin to bottom as media loads mid-animation. Effect D fires a final defensive instant pin via the native `scrollend` event (Chrome 114+, Safari 18+) or a `setTimeout(800)` fallback. `'message'` intent (jump-to-message from search) does NOT suppress — the gate flips honestly so the user is left at the targeted message. Closes the "Jump to Present doesn't fully reach the bottom" residue reproducible on `nova.ddns.net` Orbit → general. UX call: smooth-scroll animation preserved, not replaced with an instant jump.
- 2026-05-05 — skeleton-as-overlay fix: the initial-load skeleton was rendered as an early return that replaced the JSX containing `containerRef` / `contentRef`. On slow loads (mobile hotspot, throttled connection), `useDelayedLoading`'s 200ms threshold flipped `showInitialSkeleton=true` before messages arrived, unmounting the scroll container. When messages then arrived (`messages.length` 0→N), Effect A's rAF ran against `containerRef.current === null` and bailed at the null guard at the top of its callback. Effects B/C/D and the scrollend listener — all keyed on `[hasMessages, channelId]` — re-fired exactly once when `hasMessages` flipped false→true (which happened *while the skeleton was still up* due to `useDelayedLoading.minDisplay`'s 300ms enforcement), hit the same null guard, and never re-attached because no dep changed when the skeleton finally cleared. Net effect: chat opened scrolled to the top instead of the bottom; ResizeObserver never observed the content; scrollend never registered; saved-anchor restore was equally broken. Fix: render the skeleton as an `absolute inset-0 z-10 bg-surface-chat pointer-events-none` overlay alongside the (always-mounted) scroll container, so all refs stay live across the loading transition. Added the "ContainerRef invariant" section above to encode the constraint for future loading-UI additions. **Manual repro recipe** (regression check): DevTools → Network tab → throttle to "Slow 3G" → click into a channel that hasn't been opened this session → pre-fix: list lands scrolled to the top; post-fix: list lands at the bottom. Saved-anchor variant: scroll up in a channel, switch away, return under throttle — pre-fix: lands at top; post-fix: lands at the saved anchor.
- 2026-04-27 — pagination cross-channel race fix: `handleScroll`'s load-more block (`scrollTop < 50 && hasMore`) leaked `isLoadingMore = true` and the `prevScrollHeight` value across channel switches that raced the async `loadMoreMessages` await. The `useState` slot is the same component instance across channel changes, so the new channel inherited the flag (phantom pagination skeleton) and the post-await `requestAnimationFrame` applied the outgoing channel's `prevScrollHeight` to the incoming channel's container DOM (wrong-position scroll). Fix: capture `channelId` into a `requestChannelId` local at the start of the load block, mirror the live `channelId` prop into `currentChannelIdRef` synchronously each render, and compare twice — once before scheduling the rAF and once *inside* the rAF callback (the ~16ms gap between scheduling and firing is enough time for a click to switch channels). Wrap the await in `try/finally` so `setIsLoadingMore(false)` always runs even on throw. Belt-and-suspenders: the channel-switch effect (Effect 3) also calls `setIsLoadingMore(false)` so a never-resolving await (network hang) cannot strand the flag on the new channel. The store's `currentChannelId` was rejected as the live source — it lags one render behind a URL-driven channel switch (set in an `AppLayout` effect that fires after `MessageList` renders with the new prop), which would let the guard mis-fire during that one-frame window. Request cancellation was deliberately deferred — the channelId guard already silently drops stale results, and `AbortController` plumbing through `chatStore.loadMoreMessages` is a larger refactor; network waste on an abandoned page is not a correctness issue.
