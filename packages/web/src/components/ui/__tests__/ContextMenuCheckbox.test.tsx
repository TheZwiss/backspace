import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, act } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useContextMenuStore } from '../../../stores/contextMenuStore';
import { ContextMenuRenderer } from '../ContextMenuRenderer';

// Minimal mock for uiStore (ContextMenuRenderer reads isMobile)
vi.mock('../../../stores/uiStore', () => ({
  useUIStore: (selector: (s: { isMobile: boolean }) => unknown) =>
    selector({ isMobile: false }),
}));

beforeEach(() => {
  // Reset the context menu store to closed state between tests to prevent
  // state leaking from one test into the next.
  useContextMenuStore.getState().close();
});

describe('ContextMenu checkbox reactivity', () => {
  it('updates checkbox indicator when store value changes on click', async () => {
    const user = userEvent.setup();

    // External state the checkbox subscribes to
    let currentValue = false;
    const listeners = new Set<() => void>();

    const subscribe = (cb: () => void) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    };
    const getChecked = () => currentValue;
    const onChange = (checked: boolean) => {
      currentValue = checked;
      listeners.forEach((cb) => cb());
    };

    // Open context menu with a reactive checkbox
    useContextMenuStore.getState().open({ x: 100, y: 100 }, [
      {
        key: 'test-checkbox',
        type: 'checkbox',
        label: 'Test Mute',
        subscribe,
        getChecked,
        onChange,
      },
    ]);

    render(<ContextMenuRenderer />);

    const button = screen.getByText('Test Mute').closest('button')!;
    expect(button).toBeTruthy();

    // Checkbox should start unchecked — the indicator's inner SVG checkmark should not be present
    const getCheckmark = () => button.querySelector('svg[viewBox="0 0 24 24"]');
    expect(getCheckmark()).toBeNull();

    // Click to mute
    await user.click(button);

    // Checkbox should now be checked
    expect(currentValue).toBe(true);
    expect(getCheckmark()).not.toBeNull();

    // Click again to unmute
    await user.click(button);

    // Checkbox should be unchecked again
    expect(currentValue).toBe(false);
    expect(getCheckmark()).toBeNull();
  });

  it('does not close the menu after toggling a checkbox', async () => {
    const user = userEvent.setup();

    let currentValue = false;
    const listeners = new Set<() => void>();

    useContextMenuStore.getState().open({ x: 100, y: 100 }, [
      {
        key: 'test-checkbox',
        type: 'checkbox',
        label: 'Stay Open',
        subscribe: (cb: () => void) => {
          listeners.add(cb);
          return () => listeners.delete(cb);
        },
        getChecked: () => currentValue,
        onChange: (checked: boolean) => {
          currentValue = checked;
          listeners.forEach((cb) => cb());
        },
      },
    ]);

    render(<ContextMenuRenderer />);

    await user.click(screen.getByText('Stay Open'));

    // Menu should still be open (item still visible)
    expect(screen.getByText('Stay Open')).toBeTruthy();
    expect(useContextMenuStore.getState().menu).not.toBeNull();
  });

  it('updates checkbox when external code changes the store (not via click)', async () => {
    // External state the checkbox subscribes to
    let currentValue = false;
    const listeners = new Set<() => void>();

    const subscribe = (cb: () => void) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    };
    const getChecked = () => currentValue;

    useContextMenuStore.getState().open({ x: 100, y: 100 }, [
      {
        key: 'test-checkbox',
        type: 'checkbox',
        label: 'External Update',
        subscribe,
        getChecked,
        onChange: () => {},
      },
    ]);

    render(<ContextMenuRenderer />);

    const button = screen.getByText('External Update').closest('button')!;
    const getCheckmark = () => button.querySelector('svg[viewBox="0 0 24 24"]');

    // Starts unchecked
    expect(getCheckmark()).toBeNull();

    // Simulate external store change (e.g., another component or WebSocket event)
    act(() => {
      currentValue = true;
      listeners.forEach((cb) => cb());
    });

    // Checkbox should now show as checked without any click
    expect(getCheckmark()).not.toBeNull();
  });
});
