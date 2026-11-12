import type { Activity } from '@backspace/shared';

/**
 * Whether the player's own choice to keep browser tabs out of "listening" is on.
 * Kept apart from the game overrides (`gameOverrides.ts`): it is one flag, not a
 * list, and old stored overrides must keep loading unchanged.
 *
 * Like the game choices it lives in this browser's storage only; the server and
 * federation just see the activities that are left.
 */
export const HIDE_BROWSER_MEDIA_KEY = 'backspace_hide_browser_media';

/**
 * Words that identify a browser in the player name the desktop reports
 * (`assets.smallText` of a listening/watching activity). Windows SMTC reports
 * "Chrome" or "Edge"; Linux MPRIS reports the bus name capitalised, which for a
 * browser carries an instance suffix ("Chromium.instance4821", "Google-chrome").
 * Matching whole words keeps music apps whose names merely contain letters of a
 * browser ("Archive Player", "Yandex Music") out of the set.
 */
const BROWSER_WORDS = new Set([
  'chrome', 'chromium', 'edge', 'msedge', 'firefox', 'brave', 'opera', 'vivaldi', 'arc',
  'safari', 'librewolf', 'waterfox', 'floorp', 'zen', 'epiphany', 'falkon', 'thorium',
]);

/** True when a player name (as shown on the activity) belongs to a web browser. */
export function isBrowserPlayerName(player: string | undefined | null): boolean {
  if (!player) return false;
  return player
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .some((word) => BROWSER_WORDS.has(word));
}

/** A listening/watching activity whose player is a web browser (a tab, not a music app). */
export function isBrowserMediaActivity(activity: Activity): boolean {
  if (activity.type !== 'listening' && activity.type !== 'watching') return false;
  return isBrowserPlayerName(activity.assets?.smallText);
}

/** The list without browser-tab media, or the same list when the choice is off. */
export function withoutBrowserMedia(activities: Activity[], hide: boolean): Activity[] {
  if (!hide) return activities;
  return activities.filter((activity) => !isBrowserMediaActivity(activity));
}

export function loadHideBrowserMedia(): boolean {
  try {
    return localStorage.getItem(HIDE_BROWSER_MEDIA_KEY) === '1';
  } catch {
    return false;
  }
}

export function saveHideBrowserMedia(hide: boolean): void {
  try {
    if (hide) localStorage.setItem(HIDE_BROWSER_MEDIA_KEY, '1');
    else localStorage.removeItem(HIDE_BROWSER_MEDIA_KEY);
  } catch {
    // Storage can be unavailable (private window, blocked site data): the choice then lasts for the session only
  }
}

export function clearHideBrowserMedia(): void {
  try {
    localStorage.removeItem(HIDE_BROWSER_MEDIA_KEY);
  } catch {
    // Nothing stored to clear
  }
}
