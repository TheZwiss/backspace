import { describe, it, expect, afterEach, vi } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';

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

describe('Tooltip dismissal (WCAG 1.4.13, #329)', () => {
  function renderTooltip(): HTMLElement {
    vi.useFakeTimers();
    render(
      <Tooltip content="Mute microphone" delay={200}>
        <button type="button">Toggle</button>
      </Tooltip>,
    );
    return screen.getByRole('button', { name: 'Toggle' }).closest('.relative.inline-flex') as HTMLElement;
  }

  afterEach(() => {
    vi.useRealTimers();
  });

  it('closes on Escape while hovered, and stays closed until the pointer leaves and returns', () => {
    const anchor = renderTooltip();
    fireEvent.mouseEnter(anchor);
    act(() => { vi.advanceTimersByTime(250); });
    expect(screen.getByText('Mute microphone')).toBeInTheDocument();

    // The pointer is over the anchor, focus is elsewhere: Escape reaches the document.
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByText('Mute microphone')).not.toBeInTheDocument();
    act(() => { vi.advanceTimersByTime(1000); });
    expect(screen.queryByText('Mute microphone')).not.toBeInTheDocument();

    fireEvent.mouseLeave(anchor);
    fireEvent.mouseEnter(anchor);
    act(() => { vi.advanceTimersByTime(250); });
    expect(screen.getByText('Mute microphone')).toBeInTheDocument();
  });

  it('cancels a tooltip still waiting out its delay on Escape', () => {
    const anchor = renderTooltip();
    fireEvent.mouseEnter(anchor);
    act(() => { vi.advanceTimersByTime(100); });
    fireEvent.keyDown(document, { key: 'Escape' });
    act(() => { vi.advanceTimersByTime(1000); });
    expect(screen.queryByText('Mute microphone')).not.toBeInTheDocument();
  });

  it('marks the floating text as a tooltip', () => {
    const anchor = renderTooltip();
    fireEvent.mouseEnter(anchor);
    act(() => { vi.advanceTimersByTime(250); });
    expect(screen.getByRole('tooltip')).toHaveTextContent('Mute microphone');
  });
});
