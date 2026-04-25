# Message List & Auto-Scroll

The chat message list (`packages/web/src/components/chat/MessageList.tsx`) is responsible for rendering the message stream, auto-scrolling to follow new content, restoring per-channel scroll positions during a session, dispatching jump-to-message scrolls from search, and triggering load-more pagination at the top.

## Files

| File | Responsibility |
|---|---|
| `packages/web/src/components/chat/MessageList.tsx` | Render the message stream and own all scroll behavior. |
| `packages/web/src/stores/chatStore.ts` | `messages`, `hasMore`, `scrollPositions` (in-memory, session-scoped). |
| `packages/web/src/components/chat/embeds/*.tsx` | Embed renderers — must obey the dimension reservation contract below. |
| `packages/web/src/components/chat/AttachmentRenderer.tsx` | Reference for the dimension reservation pattern (`AttachmentRenderer.tsx:81-100`). |

## Auto-scroll model

Three effects cooperate. Their ordering is established by the 2026-03-25 race-fix and the 2026-04-25 sentinel addendum.

**Effect A — initial snap / restore.** Runs once when `messages.length` transitions from 0 to N for a channel. Reads `chatStore.scrollPositions.get(channelId)`. If a saved anchor exists, scrolls that message into view and computes the resulting `isAtBottomRef` from actual distance. Otherwise, sets `container.scrollTop = container.scrollHeight`, captures the post-clamp value into `lastProgrammaticBottomScrollRef`, and sets `isAtBottomRef.current = true`. On subsequent message arrivals (`messages.length > prev`), if `isAtBottomRef.current`, smooth-scrolls via `bottomRef.scrollIntoView({ behavior: 'smooth' })` — this path deliberately does *not* update the sentinel, because the smooth animation lands asynchronously across many frames and no single intermediate `scrollTop` is worth pinning to. The path is already gated on `isAtBottomRef.current`, so it cannot fire while the user is scrolled away; the rare image-load growth during a smooth scroll is tolerated.

**Effect B — ResizeObserver.** Observes the message-list content container. When height grows and `isAtBottomRef.current === true`, re-pins to bottom and updates the sentinel. Gated on `isAtBottomRef.current` so it cannot interfere when the user has scrolled away.

**Effect C — capture-phase `load` listener.** Catches image/iframe load completions that ResizeObserver suppresses due to its layout-loop limit. Same gate, same re-pin, same sentinel update.

**`handleScroll`.** Runs on every scroll event. **First check:** if `container.scrollTop === lastProgrammaticBottomScrollRef.current`, the event was queued by our own command — re-affirm the at-bottom flags, re-pin defensively (layout may have grown since the command), update the sentinel, and return early. Otherwise, **invalidate the sentinel immediately** (a non-matching event means the user has moved away from the position we last commanded; leaving the stale value live would let a coincidental future scroll-through of the same `scrollTop` falsely match and yank the user to bottom). Then recompute `distanceFromBottom`, update `isAtBottomRef` and `isNearBottomRef`, track `visibleMsgIdRef` (for position memory), and trigger `loadMoreMessages` when scrolled near the top.

**Invariant:** `isAtBottomRef` flips from `true` to `false` only when the user genuinely scrolls away. Layout growth, our own programmatic scrolls, and queued scroll events from those programmatic scrolls do not flip it.

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
