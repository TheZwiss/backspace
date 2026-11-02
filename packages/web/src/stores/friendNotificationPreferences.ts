import { create } from 'zustand';
import { persist } from 'zustand/middleware';
export const useFriendNotificationPreferences = create<{ enabled: boolean; sound: boolean; desktop: boolean; update: (values: Partial<{ enabled: boolean; sound: boolean; desktop: boolean }>) => void }>()(persist(set => ({ enabled: true, sound: true, desktop: true, update: values => set(values) }), { name: 'backspace-friend-notifications' }));
