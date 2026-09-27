import { afterEach, describe, expect, it, vi } from 'vitest';
import type { User } from '@backspace/shared';

vi.mock('../audio/AudioManager', () => ({
  AudioManager: { getInstance: vi.fn().mockReturnValue({ setOutputDevice: vi.fn(), setVolume: vi.fn() }) },
}));

import { renderHook } from '@testing-library/react';
import { useAuthStore } from '../stores/authStore';
import { clearSelfIds, registerSelfId } from '../utils/identity';
import { useShownStatus } from './useShownStatus';

function user(fields: Partial<User> & Pick<User, 'id' | 'username'>): User {
  return {
    displayName: null, avatar: null, banner: null, accentColor: null, avatarColor: null,
    bio: null, status: 'online', customStatus: null, isAdmin: false, createdAt: 1, homeInstance: null,
    homeUserId: null, replicatedInstances: [], ...fields,
  } as User;
}

/** erin@nova signed in directly on this page's instance: a replicated row. */
const erinHere = user({
  id: 'erin-here', username: 'erin@nova.example', homeInstance: 'nova.example', homeUserId: 'erin-nova',
});
/** Her own row on nova, as a space there lists her. */
const erinOnNova = user({ id: 'erin-nova', username: 'erin', status: 'online' });
const ada = user({ id: 'ada', username: 'ada', status: 'online' });

afterEach(() => {
  useAuthStore.setState({ user: null, trueHomeStatus: null });
  clearSelfIds();
});

describe('useShownStatus', () => {
  it("shows the signed-in user's chosen status over an instance's view of them", () => {
    useAuthStore.setState({ user: erinHere, trueHomeStatus: 'dnd' });

    const { result } = renderHook(() => useShownStatus(erinHere, 'online'));

    expect(result.current).toBe('dnd');
  });

  it("recognises the user's row on another instance as the same person", () => {
    useAuthStore.setState({ user: erinHere, trueHomeStatus: 'dnd' });
    registerSelfId('erin-nova');

    const { result } = renderHook(() => useShownStatus(erinOnNova, erinOnNova.status));

    expect(result.current).toBe('dnd');
  });

  it('never takes a different user with the same name for the signed-in user', () => {
    // The page's own native erin, as nova lists her: erin@<page host>, homed on
    // the page's instance, a different person from the signed-in erin@nova.
    const pageHost = window.location.host;
    const otherErin = user({
      id: 'erin-native-seen-on-nova', username: `erin@${pageHost}`,
      homeInstance: pageHost, homeUserId: 'erin-native', status: 'online',
    });
    useAuthStore.setState({ user: erinHere, trueHomeStatus: 'dnd' });

    const { result } = renderHook(() => useShownStatus(otherErin, otherErin.status));

    expect(result.current).toBe('online');
  });

  it('keeps the given status while the choice is not known', () => {
    useAuthStore.setState({ user: erinHere, trueHomeStatus: null });

    const { result } = renderHook(() => useShownStatus(erinHere, 'online'));

    expect(result.current).toBe('online');
  });

  it('never changes what another user shows', () => {
    useAuthStore.setState({ user: erinHere, trueHomeStatus: 'dnd' });

    const { result } = renderHook(() => useShownStatus(ada, 'idle'));

    expect(result.current).toBe('idle');
  });

  it('shows nothing for an unresolved subject', () => {
    useAuthStore.setState({ user: erinHere, trueHomeStatus: 'dnd' });

    const { result } = renderHook(() => useShownStatus(null, undefined));

    expect(result.current).toBeUndefined();
  });
});
