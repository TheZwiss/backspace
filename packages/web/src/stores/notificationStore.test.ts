import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useNotificationStore, notificationKey } from './notificationStore';
import type { SpaceWithChannelsAndMembers } from '@backspace/shared';
const { update, resolve } = vi.hoisted(() => ({ update: vi.fn(), resolve: vi.fn() }));
vi.mock('../utils/crossStoreResolvers', () => ({ getApiForOrigin: resolve }));
const setting = { targetType: 'space' as const, targetId: 'same-id', level: 'mentions' as const, mutedUntil: null, suppressEveryone: false, suppressRoles: false };
const target = { origin: 'https://a.test', targetType: 'space' as const, targetId: 'same-id' };
beforeEach(() => { useNotificationStore.getState().reset(); vi.clearAllMocks(); resolve.mockReturnValue({ notificationSettings: { update } }); });
describe('instance-scoped notification snapshots', () => {
  it('replaces only the ready instance and records own role membership', () => {
    const store = useNotificationStore.getState();
    store.apply('https://a.test', setting);
    store.apply('https://b.test', setting);
    const spaces = [{ id: 'same-id', roles: [{ id: 'everyone', isEveryone: true }], members: [{ userId: 'me', roles: [{ id: 'team' }] }, { userId: 'other', roles: [{ id: 'other-role' }] }] }] as SpaceWithChannelsAndMembers[];
    store.hydrate({ origin: target.origin, userId: 'me', spaces, settings: [] });
    expect(useNotificationStore.getState().settings[notificationKey(target)]).toBeUndefined();
    expect(Object.values(useNotificationStore.getState().settings)).toEqual([setting]);
    expect(useNotificationStore.getState().roleIds[notificationKey(target)]).toEqual(['everyone', 'team']);
    store.hydrate({ origin: target.origin, userId: 'me', spaces: [], settings: [setting] });
    expect(useNotificationStore.getState().roleIds).toEqual({});
  });
  it('uses the target instance API and waits for a confirmed write', async () => {
    update.mockResolvedValue(setting);
    await useNotificationStore.getState().save(target, setting);
    expect(resolve).toHaveBeenCalledWith(target.origin);
    expect(useNotificationStore.getState().settings[notificationKey(target)]).toEqual(setting);
    update.mockRejectedValue(new Error('offline'));
    await expect(useNotificationStore.getState().save(target, { ...setting, level: 'nothing' })).rejects.toThrow('offline');
    expect(useNotificationStore.getState().settings[notificationKey(target)]).toEqual(setting);
  });
  it('applies a remote-device event and clears user state on reset', () => {
    const store = useNotificationStore.getState();
    store.apply(target.origin, setting);
    store.open(target);
    store.apply(target.origin, { ...setting, level: 'nothing' });
    expect(useNotificationStore.getState().settings[notificationKey(target)].level).toBe('nothing');
    store.reset();
    expect(useNotificationStore.getState()).toMatchObject({ settings: {}, roleIds: {}, editing: null });
  });
});
