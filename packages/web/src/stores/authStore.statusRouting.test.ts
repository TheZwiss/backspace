import { afterEach, describe, expect, it, vi } from 'vitest';
import type { User } from '@backspace/shared';

vi.mock('../audio/AudioManager', () => ({
  AudioManager: { getInstance: vi.fn().mockReturnValue({ setOutputDevice: vi.fn(), setVolume: vi.fn() }) },
}));
vi.mock('../hooks/useWebSocket', () => ({
  connectInstance: vi.fn(),
  disconnectInstance: vi.fn(),
  disconnectAllRemote: vi.fn(),
}));

import { selectMyChosenStatus, useAuthStore } from './authStore';
import { useInstanceStore, type ConnectedInstance } from './instanceStore';
import { api } from '../api/client';

function user(fields: Partial<User> & Pick<User, 'id'>): User {
  return {
    username: fields.id, displayName: null, avatar: null, banner: null, accentColor: null, avatarColor: null,
    bio: null, status: 'online', customStatus: null, isAdmin: false, createdAt: 1, homeInstance: null,
    homeUserId: null, replicatedInstances: [], ...fields,
  } as User;
}

/** erin@nova signed in directly on this page's instance. */
const erinHere = user({ id: 'erin-here', homeInstance: 'nova.example', homeUserId: 'erin-nova' });

function connectNova(update: (data: object) => Promise<User>): void {
  useInstanceStore.setState({
    instances: [{
      origin: 'https://nova.example',
      label: 'nova',
      token: 't',
      user: user({ id: 'erin-nova' }),
      username: 'erin',
      status: 'connected',
      api: { users: { update } },
    } as unknown as ConnectedInstance],
  });
}

afterEach(() => {
  useAuthStore.setState({ user: null, trueHomeStatus: null });
  useInstanceStore.setState({ instances: [] });
  vi.restoreAllMocks();
});

describe('updateProfile: the status goes to the account that owns it', () => {
  it("sends a replicated session's status to its true home and the rest to the page's instance", async () => {
    useAuthStore.setState({ user: erinHere, trueHomeStatus: 'online' });
    const novaUpdate = vi.fn(async () => user({ id: 'erin-nova', status: 'dnd' }));
    connectNova(novaUpdate);
    const pageUpdate = vi.spyOn(api.users, 'update').mockResolvedValue({ ...erinHere, bio: 'hi' });

    await useAuthStore.getState().updateProfile({ status: 'dnd', bio: 'hi' });

    expect(novaUpdate).toHaveBeenCalledWith({ status: 'dnd' });
    expect(pageUpdate).toHaveBeenCalledWith({ bio: 'hi' });
    expect(selectMyChosenStatus(useAuthStore.getState())).toBe('dnd');
  });

  it("refuses to change a replicated session's status without a connection to the true home", async () => {
    useAuthStore.setState({ user: erinHere, trueHomeStatus: 'online' });
    const pageUpdate = vi.spyOn(api.users, 'update').mockResolvedValue(erinHere);

    await expect(useAuthStore.getState().updateProfile({ status: 'dnd' })).rejects.toThrow('nova.example');
    expect(pageUpdate).not.toHaveBeenCalled();
    expect(selectMyChosenStatus(useAuthStore.getState())).toBe('online');
  });

  it("keeps a native session's status on the page's own instance", async () => {
    const native = user({ id: 'jannis' });
    useAuthStore.setState({ user: native, trueHomeStatus: null });
    const pageUpdate = vi.spyOn(api.users, 'update').mockResolvedValue({ ...native, status: 'dnd' });

    await useAuthStore.getState().updateProfile({ status: 'dnd' });

    expect(pageUpdate).toHaveBeenCalledWith({ status: 'dnd' });
    expect(selectMyChosenStatus(useAuthStore.getState())).toBe('dnd');
  });
});
