import React from 'react';
import { useTranslation } from 'react-i18next';

/**
 * Scrim shown over a chat region while files are dragged onto it. Purely
 * visual: it takes no pointer events, so the drag keeps targeting the elements
 * underneath (the drop zone listens on the region, not on this overlay), and
 * it is hidden from assistive tech because a drag has no keyboard equivalent
 * (the attach button and paste remain).
 *
 * The parent must be `position: relative`; the composer's own region already is.
 */
export function ChatDropOverlay(): React.ReactElement {
  const { t } = useTranslation('chat');

  return (
    <div
      data-testid="chat-drop-overlay"
      aria-hidden="true"
      className="drop-scrim absolute inset-0 z-[140] flex items-center justify-center p-3 pointer-events-none animate-fade-in"
    >
      <div className="w-full h-full rounded-[14px] border-2 border-dashed border-accent-primary/50 flex items-center justify-center">
        <div className="glass-bubble rounded-[14px] px-6 py-4 flex flex-col items-center gap-2 text-center">
          <svg
            width="32"
            height="32"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth={1.75}
            strokeLinecap="round"
            strokeLinejoin="round"
            className="text-accent-primary"
          >
            <path d="M12 16V4" />
            <path d="M7 9l5-5 5 5" />
            <path d="M5 16v2a2 2 0 002 2h10a2 2 0 002-2v-2" />
          </svg>
          <span className="text-[16px] font-semibold text-txt-primary">{t('composer.dropTitle')}</span>
          <span className="text-[13px] text-txt-tertiary">{t('composer.dropHint')}</span>
        </div>
      </div>
    </div>
  );
}
