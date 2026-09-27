import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
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
import { useInstanceStore } from './instanceStore';
import { api } from '../api/client';

function user(fields: Partial<User> & Pick<User, 'id'>): User {
  return {
    username: fields.id, displayName: null, avatar: null, banner: null, accentColor: null, avatarColor: null,
    bio: null, status: 'online', customStatus: null, isAdmin: false, createdAt: 1, homeInstance: null,
    homeUserId: null, replicatedInstances: [], ...fields,
  } as User;
}

/** erin@nova signed in directly on this page's instance: a replicated row. */
const erinHere = user({ id: 'erin-here', homeInstance: 'nova.example', homeUserId: 'erin-nova' });
/** The same person's account seen from another instance: same true home account. */
const erinElsewhere = user({ id: 'erin-elsewhere', homeInstance: 'nova.example', homeUserId: 'erin-nova' });
/** A different nova account signed in on this page's instance. */
const tomHere = user({ id: 'tom-here', homeInstance: 'nova.example', homeUserId: 'tom-nova' });

/** A page load: the in-memory store starts empty, localStorage survives. */
function reload(): void {
  useAuthStore.setState({ token: 'page-token', user: null, trueHomeStatus: null });
}

beforeEach(() => {
  localStorage.clear();
  vi.spyOn(useInstanceStore.getState(), 'autoConnectAll').mockResolvedValue(undefined);
});

afterEach(() => {
  useAuthStore.setState({ token: null, user: null, trueHomeStatus: null });
  localStorage.clear();
  vi.restoreAllMocks();
});

describe("a replicated session's chosen status before the true home reports", () => {
  it('starts from the last status the true home reported, after a page load', async () => {
    useAuthStore.setState({ user: erinHere });
    useAuthStore.getState().applyOwnStatus({ owner: 'trueHome', status: 'dnd' });

    reload();
    vi.spyOn(api.users, 'me').mockResolvedValue(erinHere);
    await useAuthStore.getState().loadUser();

    expect(selectMyChosenStatus(useAuthStore.getState())).toBe('dnd');
  });

  it('starts from it on a fresh sign-in on another instance of the same home account', () => {
    useAuthStore.setState({ user: erinHere });
    useAuthStore.getState().applyOwnStatus({ owner: 'trueHome', status: 'idle' });

    reload();
    useAuthStore.getState().initSession('new-token', erinElsewhere);

    expect(selectMyChosenStatus(useAuthStore.getState())).toBe('idle');
  });

  it("never takes another account's last status", () => {
    useAuthStore.setState({ user: erinHere });
    useAuthStore.getState().applyOwnStatus({ owner: 'trueHome', status: 'dnd' });

    reload();
    useAuthStore.getState().initSession('new-token', tomHere);

    expect(selectMyChosenStatus(useAuthStore.getState())).toBeNull();
  });

  it("gives way to the true home's next report", async () => {
    useAuthStore.setState({ user: erinHere });
    useAuthStore.getState().applyOwnStatus({ owner: 'trueHome', status: 'dnd' });

    reload();
    vi.spyOn(api.users, 'me').mockResolvedValue(erinHere);
    await useAuthStore.getState().loadUser();
    useAuthStore.getState().applyOwnStatus({ owner: 'trueHome', status: 'online' });

    expect(selectMyChosenStatus(useAuthStore.getState())).toBe('online');
  });

  it('is unknown when nothing was ever reported on this device', async () => {
    reload();
    vi.spyOn(api.users, 'me').mockResolvedValue(erinHere);
    await useAuthStore.getState().loadUser();

    expect(selectMyChosenStatus(useAuthStore.getState())).toBeNull();
  });

  it('is unknown, without failing, when storage cannot be read', async () => {
    useAuthStore.setState({ user: erinHere });
    useAuthStore.getState().applyOwnStatus({ owner: 'trueHome', status: 'dnd' });

    reload();
    vi.spyOn(localStorage, 'getItem').mockImplementation(() => { throw new Error('blocked'); });
    vi.spyOn(api.users, 'me').mockResolvedValue(erinHere);
    await useAuthStore.getState().loadUser();

    expect(selectMyChosenStatus(useAuthStore.getState())).toBeNull();
  });

  it('keeps a native session on its own status, which the cache never touches', () => {
    const jannis = user({ id: 'jannis', status: 'idle' });
    useAuthStore.getState().initSession('new-token', jannis);

    expect(useAuthStore.getState().trueHomeStatus).toBeNull();
    expect(selectMyChosenStatus(useAuthStore.getState())).toBe('idle');
  });
});
