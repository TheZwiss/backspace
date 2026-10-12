import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { useContextMenuStore, type ContextMenuItem } from '../../../stores/contextMenuStore';
import { useUIStore } from '../../../stores/uiStore';
import { ContextMenuRenderer } from '../ContextMenuRenderer';

const reply = vi.fn();

function items(): ContextMenuItem[] {
  return [
    { type: 'action', key: 'reply', label: 'Reply', onClick: reply },
    { type: 'separator', key: 'sep' },
    {
      type: 'submenu', key: 'roles', label: 'Roles',
      children: [{ type: 'action', key: 'pilot', label: 'Pilot', onClick: vi.fn() }],
    },
    { type: 'custom', key: 'row', render: () => <button type="button">Thumbs up</button> },
    { type: 'action', key: 'delete', label: 'Delete', danger: true, onClick: vi.fn() },
  ];
}

function open(isMobile: boolean) {
  useUIStore.setState({ isMobile });
  render(<ContextMenuRenderer />);
  act(() => useContextMenuStore.getState().open({ x: 10, y: 10 }, items()));
  return screen.getByRole('menu');
}

beforeEach(() => {
  reply.mockClear();
});

afterEach(() => {
  act(() => useContextMenuStore.getState().close());
  useUIStore.setState({ isMobile: false });
});

describe.each([['desktop', false], ['mobile sheet', true]])('the %s context menu', (_name, isMobile) => {
  it('exposes actions and the submenu trigger as menu items, the separator as a separator, a custom row as a group', () => {
    const menu = open(isMobile);
    expect(within(menu).getAllByRole('menuitem').map(item => item.textContent)).toEqual(['Reply', 'Roles›', 'Delete']);
    expect(within(menu).getByRole('menuitem', { name: /Roles/ })).toHaveAttribute('aria-haspopup', 'menu');
    expect(within(menu).getByRole('separator')).toBeInTheDocument();
    expect(within(within(menu).getByRole('group')).getByRole('button', { name: 'Thumbs up' })).toBeInTheDocument();

    fireEvent.click(within(menu).getByRole('menuitem', { name: 'Reply' }));
    expect(reply).toHaveBeenCalledOnce();
    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
  });
});

describe('the desktop context menu from the keyboard', () => {
  it('moves through the items with the arrow keys and activates one with Enter', () => {
    const menu = open(false);
    fireEvent.keyDown(menu, { key: 'ArrowDown' });
    expect(screen.getByRole('menuitem', { name: 'Reply' })).toHaveFocus();
    fireEvent.keyDown(menu, { key: 'ArrowDown' });
    expect(screen.getByRole('menuitem', { name: /Roles/ })).toHaveFocus();
    fireEvent.keyDown(menu, { key: 'ArrowUp' });
    fireEvent.keyDown(menu, { key: 'Enter' });
    expect(reply).toHaveBeenCalledOnce();
  });

  it('opens the submenu with ArrowRight as a menu of menu items', () => {
    open(false);
    const trigger = screen.getByRole('menuitem', { name: /Roles/ });
    trigger.focus();
    fireEvent.keyDown(trigger, { key: 'ArrowRight' });
    const flyout = screen.getByRole('menu', { name: 'Roles' });
    expect(within(flyout).getByRole('menuitem', { name: 'Pilot' })).toHaveFocus();
    expect(trigger).toHaveAttribute('aria-expanded', 'true');
  });
});

describe('the desktop context menu and the browser menu', () => {
  it('keeps the browser menu shut for a contextmenu event on the panel or the submenu, as the Menu key fires on keyup', () => {
    const menu = open(false);
    expect(fireEvent.contextMenu(menu)).toBe(false);

    const trigger = screen.getByRole('menuitem', { name: /Roles/ });
    trigger.focus();
    fireEvent.keyDown(trigger, { key: 'ArrowRight' });
    const flyout = screen.getByRole('menu', { name: 'Roles' });
    expect(fireEvent.contextMenu(within(flyout).getByRole('menuitem', { name: 'Pilot' }))).toBe(false);
    expect(screen.getByRole('menu', { name: 'Roles' })).toBeInTheDocument();
  });
});
