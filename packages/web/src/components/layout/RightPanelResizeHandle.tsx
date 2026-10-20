import React from 'react';
import { useRightPanelResize } from '../../hooks/useRightPanelResize';

/**
 * The drag handle on the right column's left border, shared by the space
 * member list, the group-DM roster, and the friends activity list. The
 * surface mounts it inside its sized container and passes its own translated
 * label (e.g. "Resize member list" / "Resize friends list"), keeping the
 * aria name specific to what the user is actually looking at.
 *
 * A 4px hit strip laid over the panel's border line, following the ARIA
 * window-separator pattern: it is focusable and exposes aria-valuenow/min/max
 * in the same unit as the stored width (layout pixels). Keyboard users resize
 * with ArrowLeft/ArrowRight (Shift for a bigger step), and a double-click
 * restores the default width. Visual states stay quiet per the design system:
 * invisible at rest, a subtle brand-accent tint on hover/focus, stronger while
 * the drag is active.
 */
export function RightPanelResizeHandle({ label }: { label: string }) {
  const { width, isResizing, min, max, handleProps } = useRightPanelResize();

  return (
    <div
      data-right-panel-resize-handle
      role="separator"
      aria-orientation="vertical"
      aria-label={label}
      aria-valuemin={min}
      aria-valuemax={max}
      aria-valuenow={width}
      tabIndex={0}
      title={label}
      className={[
        'absolute inset-y-0 left-0 z-10 w-1 cursor-col-resize touch-none',
        'outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent-primary/60',
        isResizing
          ? 'bg-accent-primary/70'
          : 'hover:bg-accent-primary/40 focus-visible:bg-accent-primary/40',
      ].join(' ')}
      {...handleProps}
    />
  );
}
