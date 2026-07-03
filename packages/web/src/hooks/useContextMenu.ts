// packages/web/src/hooks/useContextMenu.ts
import { useCallback, useRef } from 'react';
import { useContextMenuStore, type ContextMenuItem } from '../stores/contextMenuStore';

/**
 * Returns an onContextMenu handler that opens the centralized context menu.
 *
 * Items are captured via a ref so the callback identity is stable regardless
 * of whether the caller memoises the array. The ref is updated every render,
 * so items are always fresh at event-fire time.
 */
export function useContextMenu(items: ContextMenuItem[]) {
  const itemsRef = useRef(items);
  itemsRef.current = items;

  const onContextMenu = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    useContextMenuStore.getState().open(
      { x: e.clientX, y: e.clientY },
      itemsRef.current,
    );
  }, []);

  return { onContextMenu };
}
