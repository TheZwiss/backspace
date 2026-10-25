import { create } from 'zustand';
import type { Activity } from '@backspace/shared';
import { wsSendAll } from '../hooks/useWebSocket';
import { api } from '../api/client';
import { userKey, type PresenceSubject } from '../utils/identity';
import {
  addManualGame,
  boundGames,
  renameKey,
  renameKeyIn,
  renameManualGame,
  clearOverrides,
  loadOverrides,
  removeManualGame,
  saveOverrides,
  setHidden,
  setRename,
  withManualGames,
  withOrder,
  withoutHidden,
  withRenames,
  type ManualGame,
} from '../utils/gameOverrides';
import { ACTIVITY_LIMITS } from '@backspace/shared/src/activities';
import { syncManualBindings } from '../platform/manualGameBinding';

let pushTimer: ReturnType<typeof setTimeout> | null = null;
/** Monotonic push generation: a debounce that fired but is still enriching must not send after a newer push arrived. */
let pushSeq = 0;
/** Activities already converted from transport progress to this client's clock. */
let locallyAnchoredActivities = new WeakSet<Activity>();
const ACTIVITY_PUSH_DELAY_MS = 5_000;
const MEDIA_ACTIVITY_PUSH_DELAY_MS = 500;
const PLAYBACK_SYNC_TOLERANCE_MS = 2_000;

function anchoredPlaybackPosition(activity: Activity): number | null {
  const playback = activity.playback;
  if (!playback) return null;
  const positionMs = Math.max(0, playback.positionMs);
  return playback.durationMs === undefined
    ? positionMs
    : Math.min(playback.durationMs, positionMs);
}

/**
 * Convert the sender's clock-independent playback position into a timeline on
 * this client's clock. This is what makes remote progress immune to skew
 * between the Windows machine and the device showing the Web client.
 */
function anchorActivityPlayback(
  activity: Activity,
  now: number,
  existingList?: Activity[],
): Activity {
  if (locallyAnchoredActivities.has(activity)) {
    return refreshActivityPlayback(activity, now);
  }

  const positionMs = anchoredPlaybackPosition(activity);
  if (positionMs === null) return activity;

  const existing = existingList?.find((a) => a.type === activity.type && a.name === activity.name);
  const existingStart = existing?.timestamps?.start;

  let start: number;
  if (typeof existingStart === 'number') {
    const elapsed = now - existingStart;
    // If incoming position is 0 (typical Chrome SMTC stale snapshot), or
    // within tolerance of current progress, preserve existing timeline.
    if (positionMs === 0 || Math.abs(positionMs - elapsed) <= PLAYBACK_SYNC_TOLERANCE_MS) {
      start = existingStart;
    } else {
      start = now - positionMs;
    }
  } else if (
    typeof activity.timestamps?.start === 'number' &&
    activity.timestamps.start > 0 &&
    (positionMs === 0 || Math.abs((now - positionMs) - activity.timestamps.start) <= PLAYBACK_SYNC_TOLERANCE_MS)
  ) {
    // Preserve valid start timestamp from reporter when within clock tolerance
    start = activity.timestamps.start;
  } else {
    start = now - positionMs;
  }

  const durationMs = activity.playback?.durationMs;
  const anchored = {
    ...activity,
    timestamps: {
      ...activity.timestamps,
      start,
      ...(durationMs === undefined ? {} : { end: start + durationMs }),
    },
    playback: {
      ...activity.playback!,
      positionMs: durationMs === undefined
        ? Math.max(0, now - start)
        : Math.min(durationMs, Math.max(0, now - start)),
    },
  };
  locallyAnchoredActivities.add(anchored);
  return anchored;
}

function anchorActivitiesPlayback(
  activities: Activity[],
  now: number,
  existingList?: Activity[],
): Activity[] {
  return activities.map((activity) => anchorActivityPlayback(activity, now, existingList));
}

function refreshActivityPlayback(activity: Activity, now: number): Activity {
  const start = activity.timestamps?.start;
  const playback = activity.playback;
  if (typeof start !== 'number' || !playback) return activity;

  const durationMs = playback.durationMs;
  const positionMs = durationMs === undefined
    ? Math.max(0, now - start)
    : Math.min(durationMs, Math.max(0, now - start));

  const refreshed = {
    ...activity,
    playback: {
      ...playback,
      positionMs,
    },
  };
  locallyAnchoredActivities.add(refreshed);
  return refreshed;
}

/** Keep the transport position current when a debounced send happens. */
function refreshActivitiesPlayback(activities: Activity[], now: number): Activity[] {
  return activities.map((activity) => refreshActivityPlayback(activity, now));
}

// ─── Game icon enrichment ─────────────────────────────────────────────────

/**
 * The desktop client extracts game icons from the player's own machine and
 * hands them to the renderer, which uploads them to the user's own instance
 * and caches the instance URL by game name. The next activity for the same
 * game carries the URL without another upload.
 */
const GAME_ICON_CACHE_KEY = 'backspace_game_icons';
const GAME_ICON_TYPES = new Set(['playing']);
const GAME_ICON_ENRICH_TIMEOUT_MS = 4000;
/** A name that failed to resolve is not retried for this long (the desktop warms its cache in the background). */
const GAME_ICON_RETRY_MS = 60_000;
const iconMissAges = new Map<string, number>();
/**
 * When each cached URL was last uploaded. The server drops an icon nobody
 * uploaded for a year (retention, server utils/gameIconAssets.ts), so a game
 * that is still played uploads its icon again once this long has passed; the
 * upload is idempotent and renews the claim.
 */
const GAME_ICON_SEEN_KEY = 'backspace_game_icons_seen';
const GAME_ICON_RENEW_MS = 30 * 24 * 60 * 60 * 1000;
const iconRenewing = new Set<string>();

function cachedIconUrl(name: string): string | null {
  try {
    const raw = localStorage.getItem(GAME_ICON_CACHE_KEY);
    if (!raw) return null;
    const map = JSON.parse(raw) as Record<string, unknown>;
    const url = map[name];
    return typeof url === 'string' && /^https?:\/\//.test(url) ? url : null;
  } catch {
    return null;
  }
}

function iconSeenAt(name: string): number {
  try {
    const seen = JSON.parse(localStorage.getItem(GAME_ICON_SEEN_KEY) ?? '{}') as Record<string, unknown>;
    const at = seen[name];
    return typeof at === 'number' ? at : 0;
  } catch {
    return 0;
  }
}

function rememberIconUrl(name: string, url: string): void {
  try {
    const map = JSON.parse(localStorage.getItem(GAME_ICON_CACHE_KEY) ?? '{}') as Record<string, string>;
    map[name] = url;
    localStorage.setItem(GAME_ICON_CACHE_KEY, JSON.stringify(map));
    const seen = JSON.parse(localStorage.getItem(GAME_ICON_SEEN_KEY) ?? '{}') as Record<string, number>;
    seen[name] = Date.now();
    localStorage.setItem(GAME_ICON_SEEN_KEY, JSON.stringify(seen));
  } catch {
    // Storage unavailable: the icon re-uploads next session
  }
}

/** Fetch the locally extracted icon, upload it to the instance, return the URL. Null on any failure. */
async function resolveGameIconUrl(name: string): Promise<string | null> {
  const getGameIcon = window.backspace?.getGameIcon;
  if (!getGameIcon) return null;
  try {
    const icon = await getGameIcon(name);
    if (!icon?.data) return null;
    const { url } = await api.gameIcons.upload({ image: icon.data });
    rememberIconUrl(name, url);
    return url;
  } catch {
    return null;
  }
}

function withTimeout(promise: Promise<string | null>, ms: number): Promise<string | null> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(null), ms);
    promise.then((url) => {
      clearTimeout(timer);
      resolve(url);
    }, () => {
      clearTimeout(timer);
      resolve(null);
    });
  });
}

/** Attach cached instance URLs to icon-able activities that lack art. Returns the input when nothing changed. */
function attachCachedIcons(activities: Activity[]): Activity[] {
  let changed = false;
  const result = activities.map((activity) => {
    if (!GAME_ICON_TYPES.has(activity.type) || activity.assets?.largeImage) return activity;
    const cached = cachedIconUrl(activity.name);
    if (!cached) return activity;
    changed = true;
    return { ...activity, assets: { ...activity.assets, largeImage: cached } };
  });
  return changed ? result : activities;
}

/**
 * Upload again the icons of games being played whose last upload is a month
 * old, so the server's retention never drops an icon that is still in use.
 * Never awaited: the activity goes out with the cached URL either way.
 */
function renewStaleIcons(activities: Activity[]): void {
  if (!window.backspace?.getGameIcon) return;
  for (const activity of activities) {
    if (!GAME_ICON_TYPES.has(activity.type)) continue;
    const name = activity.name;
    if (!cachedIconUrl(name) || iconRenewing.has(name)) continue;
    if (Date.now() - iconSeenAt(name) < GAME_ICON_RENEW_MS) continue;
    const missedAt = iconMissAges.get(name);
    if (missedAt !== undefined && Date.now() - missedAt <= GAME_ICON_RETRY_MS) continue;
    iconRenewing.add(name);
    void withTimeout(resolveGameIconUrl(name), GAME_ICON_ENRICH_TIMEOUT_MS)
      .then((url) => { if (!url) iconMissAges.set(name, Date.now()); })
      .finally(() => { iconRenewing.delete(name); });
  }
}

/** Names that would benefit from an icon upload: game activity, no art, no cached URL, no fresh miss, and a desktop bridge to ask. */
function pendingIconNames(activities: Activity[]): string[] {
  if (!window.backspace?.getGameIcon) return [];
  const names: string[] = [];
  for (const activity of activities) {
    if (!GAME_ICON_TYPES.has(activity.type) || activity.assets?.largeImage) continue;
    if (cachedIconUrl(activity.name)) continue;
    const missedAt = iconMissAges.get(activity.name);
    if (missedAt !== undefined && Date.now() - missedAt <= GAME_ICON_RETRY_MS) continue;
    names.push(activity.name);
  }
  return names;
}

/** Upload the icons for `names` and attach the instance URLs they resolve to. */
async function uploadAndAttachIcons(activities: Activity[], names: string[]): Promise<Activity[]> {
  const urls = new Map<string, string>();
  await Promise.all(names.map(async (name) => {
    const url = await withTimeout(resolveGameIconUrl(name), GAME_ICON_ENRICH_TIMEOUT_MS);
    if (url) {
      urls.set(name, url);
    } else {
      iconMissAges.set(name, Date.now());
    }
  }));
  if (urls.size === 0) return activities;
  return activities.map((activity) => {
    const url = urls.get(activity.name);
    return url && !activity.assets?.largeImage
      ? { ...activity, assets: { ...activity.assets, largeImage: url } }
      : activity;
  });
}

/** An activity list delivered for one user by one origin. */
export interface ActivityEntry {
  subject: PresenceSubject;
  activities: Activity[];
}

export const EMPTY_ACTIVITIES: Activity[] = [];

/**
 * The activities held for `subject` as delivered or listed by `origin`.
 * Every reader goes through this, so all views of one person agree.
 */
export function activitiesFor(
  userActivities: Map<string, Activity[]>,
  subject: PresenceSubject,
  origin: string,
): Activity[] {
  return userActivities.get(userKey(subject, origin)) ?? EMPTY_ACTIVITIES;
}

interface ActivityState {
  /** Keyed by `userKey` (the person's home identity), never by a raw row id. */
  userActivities: Map<string, Activity[]>;
  /**
   * `userKey` → the origin whose delivery set that entry last. A `ready`
   * is an origin's full snapshot, so it replaces exactly the entries that
   * origin set (`initActivities`); an entry another origin set last is that
   * origin's to change.
   */
  activityWriters: Map<string, string>;
  /**
   * origin → (row id → subject), from the members an older server's `ready`
   * listed. Such a server sends `presence_update` with its row id only; this
   * is how `presenceSubjectOf` names a row of a space that is not open
   * (`utils/presenceSubject.ts`). No entry for a server that sends the
   * identity fields itself.
   */
  originRows: Map<string, Map<string, PresenceSubject>>;
  showActivity: boolean;
  myActivities: Activity[] | null;
  /** What the machine detected, before the player's own choices (`utils/gameOverrides.ts`). */
  detectedActivities: Activity[];
  /** Games the player added by hand. One tied to a program is built by the desktop while it runs; one without is added here. */
  manualGames: ManualGame[];
  /** Name keys of games the player does not want shown. */
  hiddenGames: string[];
  /** Name keys in the player's priority order; the first shown leads the lists. */
  gameOrder: string[];
  /** Detected name (lowercased) → the name the player wants shown for it. */
  gameRenames: Record<string, string>;

  setUserActivities: (subject: PresenceSubject, origin: string, activities: Activity[]) => void;
  clearUserActivities: (subject: PresenceSubject, origin: string) => void;
  /**
   * Replace what `origin` set with its `ready` snapshot `entries`.
   * `coveredRows` is null for a current server, whose snapshot covers everyone
   * it reports on: every entry it set is replaced. An older server's snapshot
   * covered only the space and DM members its `ready` lists (`readyRowIndex`),
   * so only the entries of those rows are replaced; a friend it reports on
   * only live keeps what it last reported.
   */
  initActivities: (entries: ActivityEntry[], origin: string, coveredRows?: ReadonlyMap<string, PresenceSubject> | null) => void;
  /** Record (or, with null, drop) the rows an older server's `ready` listed. */
  setOriginRows: (origin: string, rows: Map<string, PresenceSubject> | null) => void;
  setShowActivity: (show: boolean) => void;
  pushActivities: (activities: Activity[]) => void;
  /** Add a game by hand (replacing one of the same name). With a `process` the desktop shows it while that program runs. */
  addManualGame: (name: string, process?: string | null) => void;
  removeManualGame: (name: string) => void;
  /** Give a manual game another name; its program, place and hidden state follow. */
  renameManualGame: (from: string, to: string) => void;
  /** Stop (or resume) showing one game; remembered. */
  setGameHidden: (name: string, hidden: boolean) => void;
  /** The priority order of games, by name key; remembered. */
  setGameOrder: (keys: string[]) => void;
  /** Show a detected game under another name from now on (null restores its own name). */
  setGameRename: (detectedName: string, chosen: string | null) => void;
  /** Push again what is currently effective, when there is something to show. */
  republish: () => void;
  reset: () => void;
}

const initialOverrides = loadOverrides();

type Choices = { manualGames: ManualGame[]; hiddenGames: string[]; gameOrder: string[]; gameRenames: Record<string, string> };

/**
 * What the player's choices make of a detected list, before icons and renames:
 * their name-only games added, hidden games left out, the rest in their order,
 * and no more than the server accepts. A tied game is already in the list: the
 * desktop reports it while its program runs.
 */
function applyChoices(list: Activity[], choices: Choices): Activity[] {
  return withOrder(
    withoutHidden(withManualGames(list, choices.manualGames), choices.hiddenGames),
    choices.gameOrder,
  ).slice(0, ACTIVITY_LIMITS.MAX_ACTIVITIES_PER_USER);
}

function persistChoices(choices: Choices): void {
  saveOverrides({
    manualGames: choices.manualGames,
    hidden: choices.hiddenGames,
    order: choices.gameOrder,
    renames: choices.gameRenames,
  });
}

export const useActivityStore = create<ActivityState>((set, get) => ({
  userActivities: new Map(),
  activityWriters: new Map(),
  originRows: new Map(),
  showActivity: true,
  myActivities: null,
  detectedActivities: [],
  manualGames: initialOverrides.manualGames,
  hiddenGames: initialOverrides.hidden,
  gameOrder: initialOverrides.order,
  gameRenames: initialOverrides.renames,

  setUserActivities: (subject, origin, activities) => {
    const key = userKey(subject, origin);
    const existing = get().userActivities.get(key);
    const anchored = anchorActivitiesPlayback(activities, Date.now(), existing);
    set((state) => {
      const next = new Map(state.userActivities);
      const writers = new Map(state.activityWriters);
      if (anchored.length === 0) {
        next.delete(key);
        writers.delete(key);
      } else {
        next.set(key, anchored);
        writers.set(key, origin);
      }
      return { userActivities: next, activityWriters: writers };
    });
  },

  clearUserActivities: (subject, origin) => {
    const key = userKey(subject, origin);
    set((state) => {
      const next = new Map(state.userActivities);
      const writers = new Map(state.activityWriters);
      next.delete(key);
      writers.delete(key);
      return { userActivities: next, activityWriters: writers };
    });
  },

  initActivities: (entries, origin, coveredRows) => {
    const now = Date.now();
    set((state) => {
      const next = new Map(state.userActivities);
      const writers = new Map(state.activityWriters);
      const covered = coveredRows
        ? new Set([...coveredRows.values()].map((subject) => userKey(subject, origin)))
        : null;
      // What this origin reported before and its snapshot no longer lists has
      // ended while the client was not hearing from it.
      for (const [key, writer] of state.activityWriters) {
        if (writer !== origin) continue;
        if (covered && !covered.has(key)) continue;
        next.delete(key);
        writers.delete(key);
      }
      for (const entry of entries) {
        const { subject } = entry;
        const key = userKey(subject, origin);
        const existing = state.userActivities.get(key);
        const activities = anchorActivitiesPlayback(entry.activities, now, existing);
        if (activities.length > 0) {
          next.set(key, activities);
          writers.set(key, origin);
        } else {
          next.delete(key);
          writers.delete(key);
        }
      }
      return { userActivities: next, activityWriters: writers };
    });
  },

  setOriginRows: (origin, rows) => {
    set((state) => {
      if (!rows && !state.originRows.has(origin)) return state;
      const originRows = new Map(state.originRows);
      if (rows) originRows.set(origin, rows);
      else originRows.delete(origin);
      return { originRows };
    });
  },

  setShowActivity: (show) => {
    set({ showActivity: show });
    if (!show) {
      if (pushTimer) { clearTimeout(pushTimer); pushTimer = null; }
      // A push still uploading its icon must not send after sharing was switched off
      pushSeq++;
      wsSendAll({ type: 'activity_update', activities: [] });
      set({ myActivities: null });
    } else {
      get().republish();
    }
  },

  pushActivities: (activities) => {
    const now = Date.now();
    const anchored = anchorActivitiesPlayback(activities, now, get().detectedActivities);
    set({ detectedActivities: anchored });
    if (!get().showActivity) return;
    const effective = (list: Activity[]) => withRenames(applyChoices(list, get()), get().gameRenames);
    const eff = effective(anchored);
    set({ myActivities: eff });
    if (pushTimer) {
      clearTimeout(pushTimer);
      pushTimer = null;
    }
    // When activities are cleared (e.g. music paused / stopped), broadcast immediately without 5s debounce
    if (eff.length === 0) {
      pushSeq++;
      wsSendAll({ type: 'activity_update', activities: [] });
      return;
    }
    const seq = ++pushSeq;
    // Media should appear promptly. Games keep the longer debounce because a
    // scan can briefly report the same process with different metadata.
    const pushDelay = anchored.some((activity) => activity.playback)
      ? MEDIA_ACTIVITY_PUSH_DELAY_MS
      : ACTIVITY_PUSH_DELAY_MS;
    pushTimer = setTimeout(() => {
      pushTimer = null;
      // Icons are looked up by the name the machine knows the game by, so the
      // player's rename is applied after they are attached, not before.
      const base = applyChoices(refreshActivitiesPlayback(anchored, Date.now()), get());
      // Cached icons attach synchronously, so a push that needs no upload
      // sends exactly as it did before icons existed.
      const withCached = attachCachedIcons(base);
      renewStaleIcons(withCached);
      const pending = pendingIconNames(withCached);
      if (pending.length === 0) {
        const final = withRenames(withCached, get().gameRenames);
        set({ myActivities: final });
        wsSendAll({ type: 'activity_update', activities: final });
        return;
      }
      void uploadAndAttachIcons(withCached, pending).then((enriched) => {
        // A newer push arrived while this one was uploading: it supersedes
        // this send, and its own timer will deliver the fresher list.
        if (seq !== pushSeq) return;
        const final = withRenames(enriched, get().gameRenames);
        set({ myActivities: final });
        wsSendAll({ type: 'activity_update', activities: final });
      });
    }, pushDelay);
  },

  addManualGame: (name, process = null) => {
    const manualGames = addManualGame(get().manualGames, name, process);
    if (manualGames === get().manualGames) return;
    set({ manualGames });
    persistChoices(get());
    syncManualBindings(boundGames(manualGames));
    get().republish();
  },

  removeManualGame: (name) => {
    const removed = get().manualGames.find((game) => renameKey(game.name) === renameKey(name));
    const manualGames = removeManualGame(get().manualGames, name);
    // A hidden game kept in the list only by the entry the player just removed goes away with it. A game
    // tied to a program is reported by the desktop for that very entry, so its detection is not a reason
    // to stay; a name-only entry that is also detected on its own is a real game and keeps its choices.
    const key = renameKey(name);
    const detectedOnItsOwn = removed?.process == null
      && get().detectedActivities.some((a) => a.type === 'playing' && renameKey(a.name) === key);
    // The tied entry's own report goes at once too, rather than at the desktop's next scan
    const detectedActivities = removed?.process == null
      ? get().detectedActivities
      : get().detectedActivities.filter((a) => !(a.type === 'playing' && renameKey(a.name) === key));
    set(detectedOnItsOwn
      ? { manualGames }
      : { manualGames, detectedActivities, hiddenGames: get().hiddenGames.filter((k) => k !== key), gameOrder: get().gameOrder.filter((k) => k !== key) });
    persistChoices(get());
    syncManualBindings(boundGames(manualGames));
    get().republish();
  },

  renameManualGame: (from, to) => {
    const manualGames = renameManualGame(get().manualGames, from, to);
    if (!manualGames) return;
    set({
      manualGames,
      hiddenGames: renameKeyIn(get().hiddenGames, from, to),
      gameOrder: renameKeyIn(get().gameOrder, from, to),
    });
    persistChoices(get());
    syncManualBindings(boundGames(manualGames));
    get().republish();
  },

  setGameHidden: (name, hidden) => {
    set({ hiddenGames: setHidden(get().hiddenGames, name, hidden) });
    persistChoices(get());
    get().republish();
  },

  setGameOrder: (keys) => {
    set({ gameOrder: keys.slice(0, 200) });
    persistChoices(get());
    get().republish();
  },

  setGameRename: (detectedName, chosen) => {
    set({ gameRenames: setRename(get().gameRenames, detectedName, chosen) });
    persistChoices(get());
    get().republish();
  },

  republish: () => {
    const { detectedActivities, myActivities, showActivity, manualGames } = get();
    if (!showActivity) return;
    // Nothing to show and nothing shown before: do not send an empty update.
    // With something shown before (a removed manual game), the empty list is
    // exactly what must reach the others.
    const hasNameOnlyGame = manualGames.some((game) => game.process === null);
    if (detectedActivities.length === 0 && !hasNameOnlyGame && (myActivities?.length ?? 0) === 0) return;
    get().pushActivities(detectedActivities);
  },

  reset: () => {
    if (pushTimer) { clearTimeout(pushTimer); pushTimer = null; }
    pushSeq++;
    locallyAnchoredActivities = new WeakSet();
    iconMissAges.clear();
    set({
      userActivities: new Map(),
      activityWriters: new Map(),
      originRows: new Map(),
      showActivity: true,
      myActivities: null,
      detectedActivities: [],
      manualGames: [],
      hiddenGames: [],
      gameOrder: [],
      gameRenames: {},
    });
    // The choices belong to the signed-in player; the next account starts clean
    clearOverrides();
    syncManualBindings([]);
  },
}));
