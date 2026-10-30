import { afterEach, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render } from '@testing-library/react';
import { useState } from 'react';
import { useNavigationMotion } from './useNavigationMotion';

function Probe({ route }: { route: string }) {
  const ref = useNavigationMotion(route);
  const [draft, setDraft] = useState('');
  return <div ref={ref}><input aria-label="draft" value={draft} onChange={(e) => setDraft(e.target.value)} /></div>;
}

afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

function setup(reduced = false) {
  const cancel = vi.fn();
  const animate = vi.fn(() => ({ cancel }));
  Object.defineProperty(HTMLElement.prototype, 'animate', { configurable: true, value: animate });
  const preference = new EventTarget() as EventTarget & { matches: boolean };
  preference.matches = reduced;
  vi.stubGlobal('matchMedia', vi.fn(() => preference));
  return { cancel, animate, preference };
}

it('cancels rapid navigation animations without remounting the editor', () => {
  const { cancel, animate } = setup();
  const view = render(<Probe route="a" />);
  const input = view.getByLabelText('draft');
  fireEvent.change(input, { target: { value: 'unsent message' } });
  expect(animate).toHaveBeenCalledTimes(1);
  view.rerender(<Probe route="b" />);
  expect(cancel).toHaveBeenCalledTimes(1);
  expect(animate).toHaveBeenCalledTimes(2);
  expect(view.getByLabelText('draft')).toBe(input);
  expect(input).toHaveValue('unsent message');
  view.unmount();
  expect(cancel).toHaveBeenCalledTimes(2);
});

it('skips animations with reduced motion and cancels when the preference changes', () => {
  const { animate, cancel, preference } = setup(true);
  const view = render(<Probe route="a" />);
  expect(animate).not.toHaveBeenCalled();
  preference.matches = false;
  view.rerender(<Probe route="b" />);
  expect(animate).toHaveBeenCalledTimes(1);
  act(() => { preference.matches = true; preference.dispatchEvent(new Event('change')); });
  expect(cancel).toHaveBeenCalledTimes(1);
});
