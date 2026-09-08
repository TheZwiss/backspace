import React from 'react';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render } from '@testing-library/react';
import type { InstanceUpdateStatus } from '@backspace/shared';
import { InstanceUpdateToast } from './InstanceUpdateToast';
import { useSettingsStore } from '../../stores/settingsStore';
import { useUIStore } from '../../stores/uiStore';
import { EMPTY_ACK } from '../../utils/updateAck';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string, opts?: Record<string, unknown>) => `${key}:${opts?.version ?? ''}` }),
}));

const available: InstanceUpdateStatus = {
  current: { version: '1.2.1', commit: null },
  latest: { version: '1.3.0', url: 'https://example.invalid', publishedAt: '' },
  state: 'update-available',
  checkedAt: 1,
  checkEnabled: true,
  reason: null,
  channel: 'prebuilt',
};

describe('InstanceUpdateToast', () => {
  beforeEach(() => {
    useSettingsStore.setState({ isAdmin: true, updateStatus: null, updateAck: EMPTY_ACK });
    useUIStore.setState({ toasts: [], isMobile: false });
  });

  it('renders nothing and raises no toast without an update', () => {
    const { container } = render(<InstanceUpdateToast />);
    expect(container.firstChild).toBeNull();
    expect(useUIStore.getState().toasts).toHaveLength(0);
  });

  it('raises one actionable toast for an available update', () => {
    useSettingsStore.setState({ updateStatus: available });
    render(<InstanceUpdateToast />);
    const toasts = useUIStore.getState().toasts;
    expect(toasts).toHaveLength(1);
    expect(toasts[0]?.message).toContain('1.3.0');
    expect(toasts[0]?.action).toBeDefined();
  });

  it('marks the version as toasted so it does not repeat', () => {
    useSettingsStore.setState({ updateStatus: available });
    render(<InstanceUpdateToast />);
    expect(useSettingsStore.getState().updateAck.toastShownFor).toBe('1.3.0');
  });

  it('does not toast a version already toasted', () => {
    useSettingsStore.setState({ updateStatus: available, updateAck: { seenVersion: null, toastShownFor: '1.3.0' } });
    render(<InstanceUpdateToast />);
    expect(useUIStore.getState().toasts).toHaveLength(0);
  });

  it('does not toast a non-admin', () => {
    useSettingsStore.setState({ updateStatus: available, isAdmin: false });
    render(<InstanceUpdateToast />);
    expect(useUIStore.getState().toasts).toHaveLength(0);
  });

  it('opens instance settings when the action is taken on desktop', () => {
    useSettingsStore.setState({ updateStatus: available });
    render(<InstanceUpdateToast />);
    useUIStore.getState().toasts[0]?.action?.onClick();
    expect(useUIStore.getState().activeModal).toBe('userSettings');
    expect(useUIStore.getState().modalData.tab).toBe('instance');
  });

  it('pushes the mobile updates screen when the action is taken on mobile', () => {
    useUIStore.setState({ isMobile: true });
    useSettingsStore.setState({ updateStatus: available });
    render(<InstanceUpdateToast />);
    useUIStore.getState().toasts[0]?.action?.onClick();
    expect(useUIStore.getState().mobileStack.at(-1)?.screen).toBe('settings-instance-updates');
  });

  it('routes by viewport at click time, not at toast-creation time', () => {
    // The toast is sticky (duration 0) and can survive a resize across the
    // mobile breakpoint, which mounts a different shell than the one active
    // when the toast was raised. The action must read `isMobile` fresh
    // rather than closing over the value captured when the toast was made.
    // (activeModal reset explicitly: a prior test in this file leaves it
    // set to 'userSettings' and the shared beforeEach does not touch it.)
    useUIStore.setState({ activeModal: null });
    useSettingsStore.setState({ updateStatus: available });
    render(<InstanceUpdateToast />);
    expect(useUIStore.getState().toasts).toHaveLength(1);

    // Resize to mobile after the toast has already been raised on desktop.
    useUIStore.setState({ isMobile: true });

    useUIStore.getState().toasts[0]?.action?.onClick();
    expect(useUIStore.getState().mobileStack.at(-1)?.screen).toBe('settings-instance-updates');
    expect(useUIStore.getState().activeModal).not.toBe('userSettings');
  });

  it('does not double-toast under StrictMode when a version is already pending unacknowledged at mount', () => {
    // React.StrictMode double-invokes a mount effect against the same render
    // (no re-render happens in between), so a guard that reads the value
    // closed over at render time cannot see the first invocation's write.
    // The guard must re-read the store live so the second invocation
    // observes the first invocation's `markUpdateToastShown()`.
    useSettingsStore.setState({ updateStatus: available });
    render(
      <React.StrictMode>
        <InstanceUpdateToast />
      </React.StrictMode>,
    );
    expect(useUIStore.getState().toasts).toHaveLength(1);
    expect(useSettingsStore.getState().updateAck.toastShownFor).toBe('1.3.0');
  });
});
