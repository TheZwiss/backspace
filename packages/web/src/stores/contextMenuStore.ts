// packages/web/src/stores/contextMenuStore.ts
import { create } from 'zustand';
import type { KeyboardEvent, MouseEvent, ReactNode } from 'react';

// ── Item types ────────────────────────────────────────────────────────────

interface ContextMenuItemBase {
  key: string;
  hidden?: boolean;
}

export interface ContextMenuAction extends ContextMenuItemBase {
  type: 'action';
  label: string;
  icon?: ReactNode;
  danger?: boolean;
  disabled?: boolean;
  onClick: () => void;
}

export interface ContextMenuCheckbox extends ContextMenuItemBase {
  type: 'checkbox';
  label: string;
  subscribe: (onStoreChange: () => void) => () => void;
  getChecked: () => boolean;
  /** Uses the same subscription as checked state so in-flight writes disable immediately. */
  getDisabled?: () => boolean;
  onChange: (checked: boolean) => void;
}

export interface ContextMenuCustom extends ContextMenuItemBase {
  type: 'custom';
  /**
   * Renders the item. `close` dismisses the menu; a control inside the item
   * that completes an action calls it, as an action item's click does.
   */
  render: (close: () => void) => ReactNode;
}

export interface ContextMenuSeparator extends ContextMenuItemBase {
  type: 'separator';
}

export type ContextMenuLeafItem =
  | ContextMenuAction
  | ContextMenuCheckbox
  | ContextMenuCustom
  | ContextMenuSeparator;

export interface ContextMenuSubmenu extends ContextMenuItemBase {
  type: 'submenu';
  label: string;
  icon?: ReactNode;
  children: ContextMenuLeafItem[];
}

export type ContextMenuItem =
  | ContextMenuAction
  | ContextMenuCheckbox
  | ContextMenuSubmenu
  | ContextMenuCustom
  | ContextMenuSeparator;

// ── Store ─────────────────────────────────────────────────────────────────

interface ContextMenuState {
  menu: {
    position: { x: number; y: number };
    items: ContextMenuItem[];
  } | null;
  openSubmenuKey: string | null;
  closeGuard: boolean;

  open: (position: { x: number; y: number }, items: ContextMenuItem[]) => void;
  close: () => void;
  setOpenSubmenu: (key: string | null) => void;
  setCloseGuard: (locked: boolean) => void;
}

export const useContextMenuStore = create<ContextMenuState>((set) => ({
  menu: null,
  openSubmenuKey: null,
  closeGuard: false,

  open: (position, items) =>
    set({ menu: { position, items }, openSubmenuKey: null, closeGuard: false }),

  close: () =>
    set({ menu: null, openSubmenuKey: null, closeGuard: false }),

  setOpenSubmenu: (key) =>
    set({ openSubmenuKey: key }),

  setCloseGuard: (locked) =>
    set({ closeGuard: locked }),
}));

// ── Utility: filter hidden items and collapse separators ──────────────────

export function filterMenuItems<T extends ContextMenuItemBase & { type: string }>(
  items: T[],
): T[] {
  // 1. Remove hidden items
  const visible = items.filter((item) => !item.hidden);

  // 2. Collapse adjacent separators + strip leading/trailing separators
  const result: T[] = [];
  for (const item of visible) {
    if (item.type === 'separator') {
      if (result.length === 0) continue; // leading
      if (result[result.length - 1]!.type === 'separator') continue; // adjacent
    }
    result.push(item);
  }
  // trailing
  while (result.length > 0 && result[result.length - 1]!.type === 'separator') {
    result.pop();
  }
  return result;
}

// ── Utility: where a menu opens ───────────────────────────────────────────

/**
 * Where the menu `event` opens appears: at the pointer for a right click, and
 * under the element for the keyboard (the menu key or Shift+F10, which some
 * browsers report as a contextmenu event at 0,0). Visual pixels, like
 * `clientX`; the renderer converts them.
 */
export function menuPositionFor(event: MouseEvent | KeyboardEvent): { x: number; y: number } {
  if ('clientX' in event && (event.clientX !== 0 || event.clientY !== 0)) {
    return { x: event.clientX, y: event.clientY };
  }
  const anchor = event.currentTarget.getBoundingClientRect();
  return { x: anchor.left + 16, y: anchor.bottom };
}
