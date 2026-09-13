/**
 * Screen-share policy — the decisions behind the screen-share IPC, kept pure
 * so they can be tested without an Electron session.
 *
 * `main.ts` owns the state (the pending preselection, the last enumeration and
 * its timestamp) and the side effects (`desktopCapturer`, the display-media
 * callback); this module only answers the questions.
 */

export type ScreenSharePickerMode = 'app' | 'system';

/**
 * Who picks the source. On a Wayland session the compositor's screencast
 * portal does: `desktopCapturer.getSources()` opens the portal dialog and
 * returns only what the user chose there, so an in-app grid is pointless and
 * listing sources up front would prompt the user on every open. The renderer
 * then shows a "choose" card that triggers the portal on click, like a browser.
 * X11, macOS and Windows list everything without a prompt.
 *
 * This reads the session type, which is a guess: the app can run under XWayland
 * inside a Wayland session, where the capture stack behaves like X11. A wrong
 * guess costs one extra click — the renderer's prompted fallback handles the
 * source list arriving after the request instead of before it.
 */
export function screenSharePickerMode(
  platform: NodeJS.Platform,
  env: NodeJS.ProcessEnv,
): ScreenSharePickerMode {
  if (platform !== 'linux') return 'app';
  const sessionType = (env.XDG_SESSION_TYPE ?? '').toLowerCase();
  if (sessionType === 'wayland' || (!!env.WAYLAND_DISPLAY && sessionType !== 'x11')) return 'system';
  return 'app';
}

export interface PendingScreenSelection {
  sourceId: string;
  shareAudio: boolean;
  at: number;
}

/** A preselection older than this is stale: the setup screen was closed without starting. */
export const PENDING_SCREEN_SELECTION_TTL_MS = 30_000;

/** A preselection is only good for the request it was armed for, and only briefly. */
export function isPendingSelectionFresh(
  pending: PendingScreenSelection | null,
  now: number,
): boolean {
  if (!pending) return false;
  return now - pending.at <= PENDING_SCREEN_SELECTION_TTL_MS;
}

/**
 * How long a serialized enumeration stands in for a fresh one. The setup screen
 * enumerates once per open, so no legitimate flow ever notices the window.
 */
export const SCREEN_SOURCES_CACHE_MS = 1_000;

export type ScreenEnumerationDecision = 'enumerate' | 'serve-cache' | 'deny';

/**
 * Whether a `get-screen-sources` call may take a fresh capture.
 *
 * Every enumeration returns thumbnail pixels of every open window, and the
 * renderer runs the instance's web client, which is remote code. Before the
 * setup screen existed that pixel data only ever reached the renderer as the
 * result of a `getDisplayMedia()` call, which Chromium gates behind transient
 * activation; an IPC handler has no such gate, so the policy is:
 *
 *   - only the app's own window may ask at all;
 *   - only while that window is focused, so a page polling on a timer cannot
 *     photograph whatever the user has since switched to;
 *   - and not faster than the cache window, so a poll that does slip through
 *     gets the snapshot it already has rather than a new one.
 *
 * None of this is a substitute for trusting the instance you connect to; it
 * bounds what a hostile or compromised web client can collect silently.
 */
export function screenEnumerationDecision(input: {
  fromMainWindow: boolean;
  windowFocused: boolean;
  lastEnumeratedAt: number | null;
  now: number;
}): ScreenEnumerationDecision {
  if (!input.fromMainWindow) return 'deny';
  if (!input.windowFocused) return 'serve-cache';
  if (input.lastEnumeratedAt !== null && input.now - input.lastEnumeratedAt < SCREEN_SOURCES_CACHE_MS) {
    return 'serve-cache';
  }
  return 'enumerate';
}
