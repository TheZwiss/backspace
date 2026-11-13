import React, { useRef, useEffect } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import { useFloatingPosition } from '../../hooks/useFloatingPosition';
import { usePortalContainer } from '../../hooks/usePortalContainer';
import { StreamQualityControls, StreamSummary, StreamHostSubtitle } from './StreamQualityControls';

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
  /**
   * When provided, a "Change screen or window" action sits above the quality
   * controls: it opens the source picker and swaps the live share in place,
   * without stopping it. Same host rule as `onStopSharing`.
   */
  onChangeSource?: () => void;
}

export function ScreenShareSettingsPopover({ open, onClose, anchorRef, onStopSharing, onChangeSource }: ScreenShareSettingsPopoverProps) {
  const { t } = useTranslation(['voice', 'common']);
  const popoverRef = useRef<HTMLDivElement>(null);
  const defaultPortalContainer = usePortalContainer();
  const anchorDocument = anchorRef.current?.ownerDocument ?? document;
  const portalContainer = anchorDocument === document ? defaultPortalContainer : anchorDocument.body;

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
    const handleKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      event.stopImmediatePropagation();
      onClose();
    };
    anchorDocument.addEventListener('mousedown', handleClick);
    anchorDocument.addEventListener('keydown', handleKey, true);
    return () => {
      anchorDocument.removeEventListener('mousedown', handleClick);
      anchorDocument.removeEventListener('keydown', handleKey, true);
    };
  }, [open, onClose, anchorRef, anchorDocument]);

  if (!open) return null;

  return createPortal(
    <div
      ref={popoverRef}
      data-dialog-portal
      style={{ ...style, maxHeight: 'calc(100 * var(--app-vh) - var(--titlebar-inset, 0px) - 16px)' }}
      className="w-[260px] max-w-[calc(100*var(--app-vw)-16px)] glass rounded-lg overflow-hidden flex flex-col"
    >
      <div className="px-3 py-2 border-b border-border-hard shrink-0">
        <div className="text-ui-body font-bold text-txt-primary">{t('voice:streamSettings.title')}</div>
        <StreamHostSubtitle className="mt-0.5" />
      </div>

      {onChangeSource && (
        <div className="px-3 pt-3 shrink-0">
          <button data-icon-motion="press"
            onClick={onChangeSource}
            className="ui-button ui-button-secondary w-full flex items-center justify-center gap-2 transition-colors"
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" className="flex-shrink-0">
              <path d="M17.65 6.35C16.2 4.9 14.21 4 12 4c-4.42 0-7.99 3.58-7.99 8s3.57 8 7.99 8c3.73 0 6.84-2.55 7.73-6h-2.08c-.82 2.33-3.04 4-5.65 4-3.31 0-6-2.69-6-6s2.69-6 6-6c1.66 0 3.14.69 4.22 1.78L13 11h7V4l-2.35 2.35z" />
            </svg>
            {t('voice:stream.change')}
          </button>
        </div>
      )}

      <div className="px-3 py-3 min-h-0 overflow-y-auto scrollbar-thin">
        <StreamQualityControls />
      </div>

      {/* Footer — computed stats */}
      <div className="px-3 py-2 border-t border-border-hard shrink-0">
        <StreamSummary />
      </div>

      {/* Stop sharing — only when the host surface has no other stop control */}
      {onStopSharing && (
        <div className="px-3 pb-3 pt-1 shrink-0">
          <button data-icon-motion="press"
            onClick={onStopSharing}
            className="ui-button ui-button-danger w-full flex items-center justify-center gap-2 transition-colors"
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
