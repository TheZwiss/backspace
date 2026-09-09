import React, { useRef, useEffect } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import { useFloatingPosition } from '../../hooks/useFloatingPosition';
import { usePortalContainer } from '../../hooks/usePortalContainer';
import { StreamQualityControls, StreamSummary } from './StreamQualityControls';

interface ScreenShareSettingsPopoverProps {
  open: boolean;
  onClose: () => void;
  anchorRef: React.RefObject<HTMLElement | null>;
  /**
   * When provided, the popover ends with a destructive "Stop Sharing" action.
   * The control bars pass this because the screen-share button is their only
   * entry point to these settings while a share is live; the stream-tile
   * context menu omits it because it already carries its own stop item.
   */
  onStopSharing?: () => void;
}

export function ScreenShareSettingsPopover({ open, onClose, anchorRef, onStopSharing }: ScreenShareSettingsPopoverProps) {
  const { t } = useTranslation(['voice', 'common']);
  const popoverRef = useRef<HTMLDivElement>(null);
  const portalContainer = usePortalContainer();

  const { style } = useFloatingPosition(anchorRef, popoverRef, {
    placement: 'top',
    offset: 12,
    enabled: open,
  });

  useEffect(() => {
    if (!open) return;
    const handleClick = (e: MouseEvent) => {
      const target = e.target as Node;
      // The anchor owns its own toggle: closing here on its mousedown would
      // make the following click re-open the popover instead of closing it.
      if (anchorRef.current?.contains(target)) return;
      if (popoverRef.current && !popoverRef.current.contains(target)) {
        onClose();
      }
    };
    document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, [open, onClose, anchorRef]);

  if (!open) return null;

  return createPortal(
    <div
      ref={popoverRef}
      style={style}
      className="w-[260px] glass rounded-lg overflow-hidden"
    >
      <div className="px-3 py-2 border-b border-border-hard">
        <span className="text-[14px] font-bold text-txt-primary">{t('voice:streamSettings.title')}</span>
      </div>

      <div className="px-3 py-3">
        <StreamQualityControls />
      </div>

      {/* Footer — computed stats */}
      <div className="px-3 py-2 border-t border-border-hard">
        <StreamSummary />
      </div>

      {/* Stop sharing — only when the host surface has no other stop control */}
      {onStopSharing && (
        <div className="px-3 pb-3 pt-1">
          <button
            onClick={onStopSharing}
            className="w-full flex items-center justify-center gap-2 px-3 py-2 rounded-lg bg-accent-rose hover:bg-accent-rose/80 text-white text-[13px] font-semibold transition-colors"
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" className="flex-shrink-0">
              <path d="M21 3H3c-1.1 0-2 .9-2 2v12c0 1.1.9 2 2 2h7v2H8v2h8v-2h-2v-2h7c1.1 0 2-.9 2-2V5c0-1.1-.9-2-2-2zm0 14H3V5h18v12z" />
              <line x1="4" y1="4" x2="20" y2="20" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
            </svg>
            {t('voice:controls.stopSharing')}
          </button>
        </div>
      )}
    </div>,
    portalContainer,
  );
}
