import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, render } from '@testing-library/react';
import { useRef } from 'react';
import { usePointerReveal } from './usePointerReveal';

const IDLE_MS = 2500;

function Probe({ active }: { active: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  const revealed = usePointerReveal(ref, active, IDLE_MS);
  return (
    <div ref={ref} data-testid="surface">
      <div data-testid="state">{revealed ? 'revealed' : 'hidden'}</div>
      <div data-voice-chrome data-testid="chrome">
        <button data-testid="button">stop sharing</button>
      </div>
      <div data-testid="video" />
    </div>
  );
}

function movePointerOver(el: Element): void {
  act(() => {
    el.dispatchEvent(new MouseEvent('pointermove', { bubbles: true }));
  });
}

afterEach(() => {
  vi.useRealTimers();
});

describe('usePointerReveal', () => {
  it('hides the chrome once the pointer has been still, which :hover cannot do', () => {
    vi.useFakeTimers();
    const view = render(<Probe active />);

    // Entering fullscreen shows the chrome, so the exit control is findable.
    expect(view.getByTestId('state')).toHaveTextContent('revealed');

    act(() => {
      vi.advanceTimersByTime(IDLE_MS);
    });

    expect(view.getByTestId('state')).toHaveTextContent('hidden');
    view.unmount();
  });

  it('brings the chrome back when the pointer moves, then hides it again', () => {
    vi.useFakeTimers();
    const view = render(<Probe active />);

    act(() => {
      vi.advanceTimersByTime(IDLE_MS);
    });
    expect(view.getByTestId('state')).toHaveTextContent('hidden');

    movePointerOver(view.getByTestId('video'));
    expect(view.getByTestId('state')).toHaveTextContent('revealed');

    act(() => {
      vi.advanceTimersByTime(IDLE_MS - 1);
    });
    expect(view.getByTestId('state')).toHaveTextContent('revealed');

    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(view.getByTestId('state')).toHaveTextContent('hidden');
    view.unmount();
  });

  it('does not hide while the pointer rests on the chrome itself', () => {
    vi.useFakeTimers();
    const view = render(<Probe active />);

    // Reaching for a button and stopping on it must not pull the bar away.
    movePointerOver(view.getByTestId('button'));

    act(() => {
      vi.advanceTimersByTime(IDLE_MS * 4);
    });

    expect(view.getByTestId('state')).toHaveTextContent('revealed');
    view.unmount();
  });

  it('resumes hiding after the pointer leaves the chrome', () => {
    vi.useFakeTimers();
    const view = render(<Probe active />);

    movePointerOver(view.getByTestId('button'));
    act(() => {
      vi.advanceTimersByTime(IDLE_MS * 2);
    });
    expect(view.getByTestId('state')).toHaveTextContent('revealed');

    movePointerOver(view.getByTestId('video'));
    act(() => {
      vi.advanceTimersByTime(IDLE_MS);
    });

    expect(view.getByTestId('state')).toHaveTextContent('hidden');
    view.unmount();
  });

  it('stays hidden while inactive, leaving the plain hover layout alone', () => {
    vi.useFakeTimers();
    const view = render(<Probe active={false} />);

    expect(view.getByTestId('state')).toHaveTextContent('hidden');

    movePointerOver(view.getByTestId('video'));
    expect(view.getByTestId('state')).toHaveTextContent('hidden');

    act(() => {
      vi.advanceTimersByTime(IDLE_MS * 2);
    });
    expect(view.getByTestId('state')).toHaveTextContent('hidden');
    view.unmount();
  });

  it('hides again when fullscreen is left', () => {
    vi.useFakeTimers();
    const view = render(<Probe active />);
    expect(view.getByTestId('state')).toHaveTextContent('revealed');

    view.rerender(<Probe active={false} />);

    expect(view.getByTestId('state')).toHaveTextContent('hidden');
    view.unmount();
  });

  it('drops its timer on unmount', () => {
    vi.useFakeTimers();
    const view = render(<Probe active />);

    view.unmount();

    // A timer surviving unmount would setState on a dead component.
    expect(() => {
      act(() => {
        vi.advanceTimersByTime(IDLE_MS * 2);
      });
    }).not.toThrow();
  });
});
