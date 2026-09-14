import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, render } from '@testing-library/react';
import { useSharedSecondBeat } from './useSharedSecondBeat';

function Probe() {
  useSharedSecondBeat();
  return null;
}

function setVisibility(value: DocumentVisibilityState): void {
  Object.defineProperty(document, 'visibilityState', { value, configurable: true });
}

afterEach(() => {
  setVisibility('visible');
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe('useSharedSecondBeat', () => {
  it('uses one interval for every mounted subscriber', () => {
    vi.useFakeTimers();
    const setInterval = vi.spyOn(window, 'setInterval');

    const view = render(<><Probe /><Probe /></>);

    expect(setInterval).toHaveBeenCalledTimes(1);
    view.unmount();
  });

  it('pauses while the document is hidden and resumes when it becomes visible', () => {
    vi.useFakeTimers();
    setVisibility('visible');
    const setInterval = vi.spyOn(window, 'setInterval');
    const clearInterval = vi.spyOn(window, 'clearInterval');
    const view = render(<Probe />);

    act(() => {
      setVisibility('hidden');
      document.dispatchEvent(new Event('visibilitychange'));
    });
    expect(clearInterval).toHaveBeenCalledTimes(1);

    act(() => {
      setVisibility('visible');
      document.dispatchEvent(new Event('visibilitychange'));
    });
    expect(setInterval).toHaveBeenCalledTimes(2);
    view.unmount();
  });
});
