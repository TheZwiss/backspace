import React from 'react';
import { useLeftPanelResize } from '../../hooks/useLeftPanelResize';

/**
 * The drag handle on the left column's right border, shared by the space
 * channel list and the home DM list. ChannelSidebar mounts it inside the
 * sized column and passes the translated label for whichever list is showing
 * ("Resize channel list" / "Resize direct messages"), keeping the aria name
 * specific to what the user is actually looking at.
 *
 * A 4px hit strip laid over the column's border line, following the ARIA
 * window-separator pattern: it is focusable and exposes aria-valuenow/min/max
 * in the same unit as the stored width (layout pixels). Keyboard users resize
 * with ArrowLeft/ArrowRight (Shift for a bigger step), and a double-click
 * restores the default width. Visual states stay quiet per the design system:
 * invisible at rest, a subtle brand-accent tint on hover/focus, stronger while
 * the drag is active.
 *
 * z-20 (one notch above the right-column handle's z-10): the channel sidebar's
 * sticky header row sits at z-10 and must not swallow the top of the strip.
 */
export function LeftPanelResizeHandle({ label }: { label: string }) {
  const { width, isResizing, min, max, handleProps } = useLeftPanelResize();

  return (
    <div
      data-left-panel-resize-handle
      role="separator"
      aria-orientation="vertical"
      aria-label={label}
      aria-valuemin={min}
      aria-valuemax={max}
      aria-valuenow={width}
      tabIndex={0}
      title={label}
      className={[
        'absolute inset-y-0 right-0 z-20 w-1 cursor-col-resize touch-none',
        'outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent-primary/60',
        isResizing
          ? 'bg-accent-primary/70'
          : 'hover:bg-accent-primary/40 focus-visible:bg-accent-primary/40',
      ].join(' ')}
      {...handleProps}
    />
  );
}
