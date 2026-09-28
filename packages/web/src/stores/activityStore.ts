import { create } from 'zustand';
import type { Activity } from '@backspace/shared';
import { wsSendAll } from '../hooks/useWebSocket';
import { activityKey, type PresenceSubject } from '../utils/identity';

let pushTimer: ReturnType<typeof setTimeout> | null = null;

/** An activity list delivered for one user by one origin. */
export interface ActivityEntry {
  subject: PresenceSubject;
  activities: Activity[];
}

/**
 * The activities held for `subject` as delivered or listed by `origin`.
 * Every reader goes through this, so all views of one person agree.
 */
export function activitiesFor(
  userActivities: Map<string, Activity[]>,
  subject: PresenceSubject,
  origin: string,
): Activity[] {
  return userActivities.get(activityKey(subject, origin)) ?? [];
}

interface ActivityState {
  /** Keyed by `activityKey` (the person's home identity), never by a raw row id. */
  userActivities: Map<string, Activity[]>;
  showActivity: boolean;
  myActivities: Activity[] | null;

  setUserActivities: (subject: PresenceSubject, origin: string, activities: Activity[]) => void;
  clearUserActivities: (subject: PresenceSubject, origin: string) => void;
  initActivities: (entries: ActivityEntry[], origin: string) => void;
  setShowActivity: (show: boolean) => void;
  pushActivities: (activities: Activity[]) => void;
  reset: () => void;
}

export const useActivityStore = create<ActivityState>((set, get) => ({
  userActivities: new Map(),
  showActivity: true,
  myActivities: null,

  setUserActivities: (subject, origin, activities) => {
    const key = activityKey(subject, origin);
    set((state) => {
      const next = new Map(state.userActivities);
      if (activities.length === 0) {
        next.delete(key);
      } else {
        next.set(key, activities);
      }
      return { userActivities: next };
    });
  },

  clearUserActivities: (subject, origin) => {
    const key = activityKey(subject, origin);
    set((state) => {
      const next = new Map(state.userActivities);
      next.delete(key);
      return { userActivities: next };
    });
  },

  initActivities: (entries, origin) => {
    set((state) => {
      const next = new Map(state.userActivities);
      for (const { subject, activities } of entries) {
        const key = activityKey(subject, origin);
        if (activities.length > 0) {
          next.set(key, activities);
        } else {
          next.delete(key);
        }
      }
      return { userActivities: next };
    });
  },

  setShowActivity: (show) => {
    set({ showActivity: show });
    if (!show) {
      if (pushTimer) { clearTimeout(pushTimer); pushTimer = null; }
      wsSendAll({ type: 'activity_update', activities: [] });
      set({ myActivities: null });
    }
  },

  pushActivities: (activities) => {
    if (!get().showActivity) return;
    set({ myActivities: activities });
    if (pushTimer) clearTimeout(pushTimer);
    pushTimer = setTimeout(() => {
      wsSendAll({ type: 'activity_update', activities });
      pushTimer = null;
    }, 5000);
  },

  reset: () => {
    if (pushTimer) { clearTimeout(pushTimer); pushTimer = null; }
    set({ userActivities: new Map(), showActivity: true, myActivities: null });
  },
}));
