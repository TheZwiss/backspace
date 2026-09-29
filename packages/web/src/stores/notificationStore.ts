import { create } from 'zustand';
import type { NotificationSetting, NotificationTargetType, SpaceWithChannelsAndMembers, UpdateNotificationSettingRequest } from '@backspace/shared';
import { getApiForOrigin } from '../utils/crossStoreResolvers';

export interface NotificationTarget {
  origin: string;
  targetType: NotificationTargetType;
  targetId: string;
}
export const notificationKey = (target: NotificationTarget): string => JSON.stringify([target.origin, target.targetType, target.targetId]);
export const emptyNotificationSetting = { level: null, mutedUntil: null, suppressEveryone: false, suppressRoles: false } as const;

interface NotificationState {
  settings: Record<string, NotificationSetting>;
  roleIds: Record<string, string[]>;
  editing: NotificationTarget | null;
  open: (target: NotificationTarget | null) => void;
  apply: (origin: string, setting: NotificationSetting) => void;
  hydrate: (snapshot: { origin: string; userId: string; spaces: SpaceWithChannelsAndMembers[]; settings: NotificationSetting[] }) => void;
  save: (target: NotificationTarget, setting: UpdateNotificationSettingRequest) => Promise<void>;
  reset: () => void;
}
export const useNotificationStore = create<NotificationState>((set, get) => ({
  settings: {}, roleIds: {}, editing: null,
  open: (editing) => set({ editing }),
  apply: (origin, setting) => set(s => ({ settings: { ...s.settings, [notificationKey({ origin, ...setting })]: setting } })),
  hydrate: ({ origin, userId, spaces, settings }) => {
    // Replace only this instance's snapshot; never erase another instance's preferences.
    const next = Object.fromEntries(Object.entries(get().settings).filter(([key]) => JSON.parse(key)[0] !== origin));
    const roles = Object.fromEntries(Object.entries(get().roleIds).filter(([key]) => JSON.parse(key)[0] !== origin));
    for (const setting of settings) next[notificationKey({ origin, ...setting })] = setting;
    for (const space of spaces) {
      const member = space.members.find(m => m.userId === userId);
      roles[notificationKey({ origin, targetType: 'space', targetId: space.id })] = [
        ...space.roles.filter(r => r.isEveryone).map(r => r.id),
        ...(member?.roles ?? []).map(r => r.id),
      ];
    }
    set({ settings: next, roleIds: roles });
  },
  save: async (target, setting) => {
    // No optimistic success: failed writes leave the last confirmed preferences intact.
    const saved = await getApiForOrigin(target.origin).notificationSettings.update(target, setting);
    get().apply(target.origin, saved);
  },
  reset: () => set({ settings: {}, roleIds: {}, editing: null }),
}));
