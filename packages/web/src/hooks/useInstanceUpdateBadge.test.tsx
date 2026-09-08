import { describe, it, expect, beforeEach } from 'vitest';
import { renderHook } from '@testing-library/react';
import type { InstanceUpdateStatus } from '@backspace/shared';
import { useInstanceUpdateBadge } from './useInstanceUpdateBadge';
import { useSettingsStore } from '../stores/settingsStore';
import { EMPTY_ACK } from '../utils/updateAck';

const available: InstanceUpdateStatus = {
  current: { version: '1.2.1', commit: null },
  latest: { version: '1.3.0', url: 'https://example.invalid', publishedAt: '' },
  state: 'update-available',
  checkedAt: 1,
  checkEnabled: true,
  reason: null,
  channel: 'prebuilt',
};

describe('useInstanceUpdateBadge', () => {
  beforeEach(() => {
    useSettingsStore.setState({ isAdmin: true, updateStatus: null, updateAck: EMPTY_ACK });
  });

  it('is false before the status loads', () => {
    const { result } = renderHook(() => useInstanceUpdateBadge());
    expect(result.current).toBe(false);
  });

  it('is true for an admin with an unseen update', () => {
    useSettingsStore.setState({ updateStatus: available });
    const { result } = renderHook(() => useInstanceUpdateBadge());
    expect(result.current).toBe(true);
  });

  it('is false for a non-admin', () => {
    useSettingsStore.setState({ updateStatus: available, isAdmin: false });
    const { result } = renderHook(() => useInstanceUpdateBadge());
    expect(result.current).toBe(false);
  });

  it('clears once the version is marked seen', () => {
    useSettingsStore.setState({ updateStatus: available, updateAck: { seenVersion: '1.3.0', toastShownFor: null } });
    const { result } = renderHook(() => useInstanceUpdateBadge());
    expect(result.current).toBe(false);
  });
});
