import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { KeybindsPanel } from './KeybindsPanel';
import { useKeybindStore } from '../../../stores/keybindStore';

const mock = vi.hoisted(() => ({ status: null as KeybindPortalStatus | null }));
vi.mock('../../../hooks/useKeybindPortalStatus', () => ({ useKeybindPortalStatus: () => mock.status }));
vi.mock('../../../platform/platform', () => ({ isElectron: () => true, isElectronMac: () => false }));
const retry = vi.fn();
beforeEach(() => {
  retry.mockClear();
  window.backspace = { retryKeybindPortal: retry } as unknown as BackspaceElectronAPI;
  useKeybindStore.setState({ keybinds: [{ actionId: 'pushToTalk', keys: [123], displayLabel: 'STALE LOCAL KEY' }] });
});
afterEach(() => { cleanup(); delete window.backspace; mock.status = null; });

describe('system-managed Wayland shortcuts panel', () => {
  it('requests first registration on opening idle settings, not on ordinary rerenders', () => {
    mock.status = { state: 'idle', shortcuts: {} };
    const { rerender } = render(<KeybindsPanel />);
    expect(retry).toHaveBeenCalledOnce();
    rerender(<KeybindsPanel />);
    expect(retry).toHaveBeenCalledOnce();
    expect(screen.queryByText('STALE LOCAL KEY')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Delete' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Edit' })).not.toBeInTheDocument();
  });
  it('shows all six actions read-only and follows system assignment changes', () => {
    mock.status = { state: 'ready', shortcuts: { pushToTalk: 'F9' } };
    const { rerender, container } = render(<KeybindsPanel />);
    expect(container.querySelectorAll('dt')).toHaveLength(6);
    expect(screen.getByText('System shortcut: F9')).toBeInTheDocument();
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
    mock.status = { state: 'ready', shortcuts: { pushToTalk: 'F10' } };
    rerender(<KeybindsPanel />);
    expect(screen.queryByText('System shortcut: F9')).not.toBeInTheDocument();
    expect(screen.getByText('System shortcut: F10')).toBeInTheDocument();
    mock.status = { state: 'ready', shortcuts: {} };
    rerender(<KeybindsPanel />);
    expect(screen.queryByText('System shortcut: F10')).not.toBeInTheDocument();
    expect(retry).not.toHaveBeenCalled();
    expect(useKeybindStore.getState().keybinds[0]?.displayLabel).toBe('STALE LOCAL KEY');
  });
  it('does not loop after denial and offers an explicit retry', () => {
    mock.status = { state: 'unavailable', shortcuts: {} };
    render(<KeybindsPanel />);
    expect(retry).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Register or reconnect shortcuts' }));
    expect(retry).toHaveBeenCalledOnce();
  });
  it('preserves the recorder and delete button on other platforms', () => {
    mock.status = null;
    render(<KeybindsPanel />);
    expect(screen.getByText('STALE LOCAL KEY')).toBeInTheDocument();
    act(() => fireEvent.click(screen.getByRole('button', { name: 'Delete' })));
    expect(useKeybindStore.getState().keybinds).toEqual([]);
  });
});
