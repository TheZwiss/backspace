import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { ContextMenuRenderer } from '../ContextMenuRenderer';
import { useContextMenuStore } from '../../../stores/contextMenuStore';
import { useUIStore } from '../../../stores/uiStore';
const pick = vi.fn();
beforeEach(() => {
 vi.useFakeTimers(); pick.mockClear(); useUIStore.setState({ isMobile: false });
 render(<ContextMenuRenderer />);
 act(() => useContextMenuStore.getState().open({ x: 40, y: 80 }, [
  { type: 'submenu', key: 'mute', label: 'Mute attention', children: [{ type: 'action', key: '15m', label: '15 minutes', onClick: pick }] },
  { type: 'submenu', key: 'other', label: 'Other options', children: [{ type: 'action', key: 'other-action', label: 'Another action', onClick: pick }] },
 ]));
});
afterEach(() => { act(() => useContextMenuStore.getState().close()); vi.clearAllTimers(); vi.useRealTimers(); });
describe('desktop submenu pointer transition', () => {
 it('keeps the flyout above the menu and accepts a click after crossing from the trigger', () => {
  const trigger = screen.getByRole('menuitem', { name: /Mute attention/ });
  fireEvent.mouseEnter(trigger); act(() => vi.advanceTimersByTime(150));
  const flyout = screen.getByRole('menu', { name: 'Mute attention' });
  expect(flyout).toHaveClass('z-menu-submenu');
  fireEvent.mouseLeave(trigger); act(() => vi.advanceTimersByTime(100)); fireEvent.mouseEnter(flyout);
  act(() => vi.advanceTimersByTime(1000));
  fireEvent.click(screen.getByRole('menuitem', { name: '15 minutes' }));
  expect(pick).toHaveBeenCalledOnce();
 });
 it('does not let a delayed close from another trigger close the newly opened submenu', () => {
  const first = screen.getByRole('menuitem', { name: /Mute attention/ });
  fireEvent.mouseEnter(first); act(() => vi.advanceTimersByTime(150)); fireEvent.mouseLeave(first);
  fireEvent.click(screen.getByRole('menuitem', { name: /Other options/ }));
  act(() => vi.advanceTimersByTime(300));
  expect(screen.getByRole('menu', { name: 'Other options' })).toBeInTheDocument();
 });
});
