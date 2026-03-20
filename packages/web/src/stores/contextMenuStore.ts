// packages/web/src/stores/contextMenuStore.ts
import { create } from 'zustand';
import type { ReactNode } from 'react';

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
  checked: boolean;
  onChange: (checked: boolean) => void;
}

export interface ContextMenuCustom extends ContextMenuItemBase {
  type: 'custom';
  render: () => ReactNode;
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
