import { create } from 'zustand';
import type { Activity } from '@backspace/shared';
import { wsSend } from '../hooks/useWebSocket';

let pushTimer: ReturnType<typeof setTimeout> | null = null;

interface ActivityState {
  userActivities: Map<string, Activity[]>;
  showActivity: boolean;

  setUserActivities: (userId: string, activities: Activity[]) => void;
  clearUserActivities: (userId: string) => void;
  initActivities: (activityMap: Record<string, Activity[]>) => void;
  setShowActivity: (show: boolean) => void;
  pushActivities: (activities: Activity[]) => void;
  reset: () => void;
}

export const useActivityStore = create<ActivityState>((set, get) => ({
  userActivities: new Map(),
  showActivity: true,

  setUserActivities: (userId, activities) => {
    set((state) => {
      const next = new Map(state.userActivities);
      if (activities.length === 0) {
        next.delete(userId);
      } else {
        next.set(userId, activities);
      }
      return { userActivities: next };
    });
  },

  clearUserActivities: (userId) => {
    set((state) => {
      const next = new Map(state.userActivities);
      next.delete(userId);
      return { userActivities: next };
    });
  },

  initActivities: (activityMap) => {
    set((state) => {
      const next = new Map(state.userActivities);
      for (const [userId, activities] of Object.entries(activityMap)) {
        if (activities.length > 0) {
          next.set(userId, activities);
        } else {
          next.delete(userId);
        }
      }
      return { userActivities: next };
    });
  },

  setShowActivity: (show) => {
    set({ showActivity: show });
    if (!show) {
      if (pushTimer) { clearTimeout(pushTimer); pushTimer = null; }
      wsSend({ type: 'activity_update', activities: [] });
    }
  },

  pushActivities: (activities) => {
    if (!get().showActivity) return;
    if (pushTimer) clearTimeout(pushTimer);
    pushTimer = setTimeout(() => {
      wsSend({ type: 'activity_update', activities });
      pushTimer = null;
    }, 5000);
  },

  reset: () => {
    if (pushTimer) { clearTimeout(pushTimer); pushTimer = null; }
    set({ userActivities: new Map(), showActivity: true });
  },
}));
