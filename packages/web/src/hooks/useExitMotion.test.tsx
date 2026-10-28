import { StrictMode, useRef } from 'react';
import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { useExitMotion } from './useExitMotion';

const originalAnimate = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'animate');
function Probe() {
  const ref = useRef<HTMLDivElement>(null);
  useExitMotion(ref);
  return <div ref={ref} id="dialog"><button id="action">Close</button><video src="movie.webm" autoPlay /></div>;
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  if (originalAnimate) Object.defineProperty(HTMLElement.prototype, 'animate', originalAnimate);
  else Reflect.deleteProperty(HTMLElement.prototype, 'animate');
  document.querySelectorAll('[data-motion-exit]').forEach((node) => node.remove());
});

function setup(reduced = false) {
  const animation = { cancel: vi.fn(), onfinish: null as null | (() => void), oncancel: null as null | (() => void) };
  const animate = vi.fn(() => animation);
  Object.defineProperty(HTMLElement.prototype, 'animate', { configurable: true, value: animate });
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({ left: 10, top: 20, width: 100, height: 60 } as DOMRect);
  const preference = Object.assign(new EventTarget(), { matches: reduced });
  vi.stubGlobal('matchMedia', vi.fn(() => preference));
  return { animation, animate, preference };
}

it('dismisses the interactive surface immediately and cleans up its inert visual copy', async () => {
  const { animation } = setup();
  const view = render(<Probe />);
  view.unmount();
  await act(async () => {});
  const copy = document.querySelector('[data-motion-exit]')!;
  expect(copy).toHaveAttribute('inert');
  expect(copy).toHaveAttribute('aria-hidden', 'true');
  expect(screen.queryByRole('button')).toBeNull();
  expect(copy.querySelector('[id]')).toBeNull();
  expect(copy.querySelector('video')).not.toHaveAttribute('src');
  animation.onfinish?.();
  expect(document.querySelector('[data-motion-exit]')).toBeNull();
});

it('does not leave copies during StrictMode replay or with reduced motion', async () => {
  const { animate, preference } = setup();
  const view = render(<StrictMode><Probe /></StrictMode>);
  await act(async () => {});
  expect(animate).not.toHaveBeenCalled();
  preference.matches = true;
  view.unmount();
  await act(async () => {});
  expect(animate).not.toHaveBeenCalled();
});

it('removes an exit immediately when reduced motion becomes enabled', async () => {
  const { animation, preference } = setup();
  const view = render(<Probe />);
  view.unmount();
  await act(async () => {});
  preference.matches = true;
  preference.dispatchEvent(new Event('change'));
  expect(animation.cancel).toHaveBeenCalledOnce();
  expect(document.querySelector('[data-motion-exit]')).toBeNull();
});
