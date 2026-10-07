import React, { useEffect } from 'react';
import { createPortal } from 'react-dom';
import { useDragToClose } from '../../hooks/useDragToClose';

interface MobilePickerSheetProps {
  onClose: () => void;
  /** Rendered in the drag area under the handle (the composer's tab bar). */
  header?: React.ReactNode;
  /** Names the sheet for assistive technology. */
  label?: string;
  /** The picker. It fills the sheet's width and the height left under the header. */
  children: React.ReactNode;
}

/**
 * A picker on a phone: a bottom sheet over a dimmed backdrop. It spans the
 * viewport's width and at most 60% of its height, sits above the soft
 * keyboard and the home indicator, and closes on a tap on the backdrop, on
 * Escape, or on a drag down from its handle. Used by the composer's emoji
 * and GIF picker and by the reaction picker the message menu opens.
 */
export function MobilePickerSheet({ onClose, header, label, children }: MobilePickerSheetProps) {
  // Escape to close (parity with desktop)
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        onClose();
      }
    };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [onClose]);

  // Drag-down-to-close. Only the handle + header area receives the touch;
  // the picker grids manage their own scrolling and keep their touches.
  // `hasInteracted` flips true on the first touchstart and stays true. We
  // use it to suppress the `animate-slide-up-sheet` keyframe from re-running
  // during snap-back / close-out, which would otherwise fight the inline
  // transform the hook is animating.
  const { sheetStyle, handleProps, hasInteracted } = useDragToClose({ onClose });

  return createPortal(
    <>
      {/* Backdrop: a single tap (mousedown or touchstart) closes */}
      <div
        data-testid="picker-sheet-backdrop"
        className="fixed inset-0 z-[300] bg-black/30"
        onMouseDown={onClose}
        onTouchStart={onClose}
      />
      {/* Sheet */}
      <div
        role={label ? 'dialog' : undefined}
        aria-label={label}
        className={`fixed left-0 right-0 z-[301] rounded-t-2xl glass-modal flex flex-col ${
          hasInteracted ? '' : 'animate-slide-up-sheet'
        }`}
        style={{
          // Sit at the bottom of the visible viewport. On iOS 16.4+ the
          // `keyboard-inset-height` env var lifts us above the soft keyboard;
          // on older iOS the 100dvh-based MobileShell layout already shrinks
          // the visual viewport when the keyboard is open, so bottom:0 lands
          // just above the keyboard naturally.
          bottom: 'var(--keyboard-inset)',
          paddingBottom: 'var(--safe-bottom)',
          maxHeight: 'min(calc(60*var(--app-dvh)), calc(60*var(--app-vh)))',
          ...sheetStyle,
        }}
        onMouseDown={(e) => e.stopPropagation()}
        onTouchStart={(e) => e.stopPropagation()}
      >
        {/* Drag handle and header: both belong to the "header" drag area.
            Spreading `handleProps` here means the user can grab anywhere in
            this top region (handle pill, padding around it, header buttons'
            interstitial space) to dismiss; header buttons themselves still
            receive their own clicks because clicks aren't blocked, only
            vertical drag past the dead-zone is. */}
        <div {...handleProps} className="shrink-0 touch-none">
          <div className="w-10 h-1 bg-txt-tertiary/30 rounded-full mx-auto mt-2 mb-1" />
          {header}
        </div>

        {/* Content */}
        <div className="flex-1 min-h-0 overflow-hidden flex flex-col">
          {children}
        </div>
      </div>
    </>,
    document.body,
  );
}
