import { describe, it, expect, afterEach } from 'vitest';
import { act, render, screen } from '@testing-library/react';

import { Tooltip } from './Tooltip';
import { useUIStore } from '../../stores/uiStore';

afterEach(() => {
  act(() => {
    useUIStore.getState().setIsMobile(false);
  });
});

/**
 * `isMobile` is reactive: the viewport listener flips it whenever the window
 * crosses the mobile breakpoint, and the same Tooltip instance stays mounted
 * across the flip. While the early return sat above the six hook calls, that
 * re-render called a different number of hooks than the previous one and React
 * threw "Rendered fewer hooks than expected". Both directions have to survive.
 */
describe('Tooltip across the mobile breakpoint', () => {
  it('stays mounted when the viewport becomes mobile', () => {
    render(
      <Tooltip content="Mute">
        <button type="button">Toggle</button>
      </Tooltip>,
    );

    expect(screen.getByRole('button', { name: 'Toggle' })).toBeInTheDocument();

    expect(() => {
      act(() => {
        useUIStore.getState().setIsMobile(true);
      });
    }).not.toThrow();

    // The wrapper is gone, the children are not.
    const child = screen.getByRole('button', { name: 'Toggle' });
    expect(child).toBeInTheDocument();
    expect(child.closest('.relative.inline-flex')).toBeNull();
  });

  it('stays mounted when the viewport stops being mobile', () => {
    act(() => {
      useUIStore.getState().setIsMobile(true);
    });

    render(
      <Tooltip content="Mute">
        <button type="button">Toggle</button>
      </Tooltip>,
    );

    expect(screen.getByRole('button', { name: 'Toggle' }).closest('.relative.inline-flex')).toBeNull();

    expect(() => {
      act(() => {
        useUIStore.getState().setIsMobile(false);
      });
    }).not.toThrow();

    // The hover wrapper is back, which is what the desktop tooltip hangs off.
    expect(screen.getByRole('button', { name: 'Toggle' }).closest('.relative.inline-flex')).not.toBeNull();
  });
});
