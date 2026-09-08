import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { InstanceUpdateStatus } from '@backspace/shared';
import { api } from '../api/client';
import { useSettingsStore, UPDATE_STATUS_REFRESH_MS } from './settingsStore';
import { EMPTY_ACK, ackStorageKey } from '../utils/updateAck';

function status(over: Partial<InstanceUpdateStatus> = {}): InstanceUpdateStatus {
  return {
    current: { version: '1.2.1', commit: 'abc1234' },
    latest: { version: '1.3.0', url: 'https://example.invalid', publishedAt: '2026-09-08T00:00:00Z' },
    state: 'update-available',
    checkedAt: 1_757_000_000_000,
    checkEnabled: true,
    reason: null,
    channel: 'prebuilt',
    ...over,
  };
}

describe('settingsStore update status', () => {
  beforeEach(() => {
    // Block body, not an expression body: a value returned from beforeEach is
    // treated by vitest as a teardown callback.
    localStorage.clear();
    useSettingsStore.getState().stopUpdateStatusRefresh();
    useSettingsStore.setState({
      updateStatus: null,
      updateStatusLoading: false,
      updateStatusError: '',
      updateAck: EMPTY_ACK,
      updateAckUserId: 'u1',
      isAdmin: true,
    });
  });

  afterEach(() => {
    useSettingsStore.getState().stopUpdateStatusRefresh();
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it('stores the fetched status and hydrates the ack from localStorage', async () => {
    localStorage.setItem(ackStorageKey('u1'), JSON.stringify({ seenVersion: '1.2.9', toastShownFor: null }));
    const spy = vi.spyOn(api.admin, 'updateStatus').mockResolvedValue(status());

    await useSettingsStore.getState().fetchUpdateStatus();

    expect(spy).toHaveBeenCalledWith(false);
    expect(useSettingsStore.getState().updateStatus?.latest?.version).toBe('1.3.0');
    expect(useSettingsStore.getState().updateAck).toEqual({ seenVersion: '1.2.9', toastShownFor: null });
    expect(useSettingsStore.getState().updateStatusLoading).toBe(false);
    expect(useSettingsStore.getState().updateStatusError).toBe('');
  });

  it('passes refresh through', async () => {
    const spy = vi.spyOn(api.admin, 'updateStatus').mockResolvedValue(status());
    await useSettingsStore.getState().fetchUpdateStatus(true);
    expect(spy).toHaveBeenCalledWith(true);
  });

  it('coalesces concurrent calls into one request', async () => {
    const spy = vi.spyOn(api.admin, 'updateStatus').mockResolvedValue(status());
    await Promise.all([
      useSettingsStore.getState().fetchUpdateStatus(),
      useSettingsStore.getState().fetchUpdateStatus(),
      useSettingsStore.getState().fetchUpdateStatus(),
    ]);
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('does not let an explicit refresh join a cached fetch already in flight', async () => {
    const spy = vi.spyOn(api.admin, 'updateStatus').mockResolvedValue(status());
    await Promise.all([
      useSettingsStore.getState().fetchUpdateStatus(false),
      useSettingsStore.getState().fetchUpdateStatus(true),
    ]);
    expect(spy).toHaveBeenCalledWith(false);
    expect(spy).toHaveBeenCalledWith(true);
  });

  it('hydrates the ack when the ack user is set', () => {
    localStorage.setItem(ackStorageKey('u2'), JSON.stringify({ seenVersion: '1.4.0', toastShownFor: null }));
    useSettingsStore.getState().setUpdateAckUser('u2');
    expect(useSettingsStore.getState().updateAck.seenVersion).toBe('1.4.0');
  });

  it('records the error and clears loading on failure', async () => {
    vi.spyOn(api.admin, 'updateStatus').mockRejectedValue(new Error('boom'));
    await useSettingsStore.getState().fetchUpdateStatus();
    expect(useSettingsStore.getState().updateStatusError).not.toBe('');
    expect(useSettingsStore.getState().updateStatusLoading).toBe(false);
    expect(useSettingsStore.getState().updateStatus).toBeNull();
  });

  it('re-fetches after the refresh interval', async () => {
    vi.useFakeTimers();
    const spy = vi.spyOn(api.admin, 'updateStatus').mockResolvedValue(status());

    await useSettingsStore.getState().fetchUpdateStatus();
    expect(spy).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(UPDATE_STATUS_REFRESH_MS + 10);
    expect(spy).toHaveBeenCalledTimes(2);
  });

  it('stops re-fetching once the refresh is stopped', async () => {
    vi.useFakeTimers();
    const spy = vi.spyOn(api.admin, 'updateStatus').mockResolvedValue(status());

    await useSettingsStore.getState().fetchUpdateStatus();
    useSettingsStore.getState().stopUpdateStatusRefresh();

    await vi.advanceTimersByTimeAsync(UPDATE_STATUS_REFRESH_MS * 2);
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('markUpdateSeen persists and exposes the seen version', async () => {
    vi.spyOn(api.admin, 'updateStatus').mockResolvedValue(status());
    await useSettingsStore.getState().fetchUpdateStatus();

    useSettingsStore.getState().markUpdateSeen();

    expect(useSettingsStore.getState().updateAck.seenVersion).toBe('1.3.0');
    expect(JSON.parse(localStorage.getItem(ackStorageKey('u1')) ?? '{}').seenVersion).toBe('1.3.0');
  });

  it('markUpdateToastShown persists without touching seenVersion', async () => {
    vi.spyOn(api.admin, 'updateStatus').mockResolvedValue(status());
    await useSettingsStore.getState().fetchUpdateStatus();

    useSettingsStore.getState().markUpdateToastShown();

    expect(useSettingsStore.getState().updateAck).toEqual({ seenVersion: null, toastShownFor: '1.3.0' });
  });

  it('marking is a no-op when no update is pending', async () => {
    vi.spyOn(api.admin, 'updateStatus').mockResolvedValue(status({ state: 'up-to-date' }));
    await useSettingsStore.getState().fetchUpdateStatus();

    useSettingsStore.getState().markUpdateSeen();

    expect(useSettingsStore.getState().updateAck).toEqual(EMPTY_ACK);
  });
});

describe('resetUpdateState (what authStore.logout calls)', () => {
  it('stops the refresh timer and clears admin/update state, leaving no leak for the next session', async () => {
    vi.useFakeTimers();
    const spy = vi.spyOn(api.admin, 'updateStatus').mockResolvedValue(status());

    localStorage.setItem(ackStorageKey('u1'), JSON.stringify({ seenVersion: '1.2.9', toastShownFor: null }));
    useSettingsStore.getState().setUpdateAckUser('u1');
    useSettingsStore.setState({ isAdmin: true });
    await useSettingsStore.getState().fetchUpdateStatus();

    // Sanity check: the admin session state is actually established before
    // the reset, so clearing it below is a meaningful assertion.
    expect(useSettingsStore.getState().isAdmin).toBe(true);
    expect(useSettingsStore.getState().updateStatus).not.toBeNull();
    expect(useSettingsStore.getState().updateAck.seenVersion).toBe('1.2.9');
    expect(useSettingsStore.getState().updateAckUserId).toBe('u1');

    useSettingsStore.getState().resetUpdateState();

    expect(useSettingsStore.getState().isAdmin).toBe(false);
    expect(useSettingsStore.getState().updateStatus).toBeNull();
    expect(useSettingsStore.getState().updateStatusLoading).toBe(false);
    expect(useSettingsStore.getState().updateStatusError).toBe('');
    expect(useSettingsStore.getState().updateAck).toEqual(EMPTY_ACK);
    expect(useSettingsStore.getState().updateAckUserId).toBeNull();

    // The six-hour timer scheduled by the fetch above must be dead: without
    // this, a tab that ever hosted an admin session keeps hitting the
    // update-status endpoint forever, 403'ing as a non-admin or triggering
    // handleUnauthorized's top-level navigation once the token is gone.
    spy.mockClear();
    await vi.advanceTimersByTimeAsync(UPDATE_STATUS_REFRESH_MS * 3);
    expect(spy).not.toHaveBeenCalled();
  });
});
