import React, { createContext, useContext, useEffect, useCallback } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import { useUIStore } from '../../stores/uiStore';
import { usePortalContainer } from '../../hooks/usePortalContainer';

interface ModalProps {
  isOpen: boolean;
  onClose: () => void;
  title?: string;
  children: React.ReactNode;
  maxWidth?: string;
  size?: 'settings';
  /** Mobile display style: 'fullscreen' fills the screen, 'sheet' anchors to bottom, 'default' stays centered */
  mobileStyle?: 'fullscreen' | 'sheet' | 'default';
}

/**
 * Shared dialog shell. It always renders through a portal into
 * `usePortalContainer()`, never in place. A `fixed inset-0` overlay is only
 * sized to the window while no ancestor sets `transform`, `filter` or
 * `backdrop-filter`; any of those makes the ancestor the containing block, and
 * the dialog is then sized and clipped to it (the 72px space strip is
 * `.glass-strip`, a dialog opened from its menu rendered inside the strip).
 * Callers mount a Modal wherever its state lives and do not portal it again.
 *
 * A Modal rendered inside another Modal's content stacks one level above it.
 * All overlays are siblings at the portal target, so document order alone
 * would decide, and a parent and child that open in the same render are
 * appended child first.
 */
export function Modal(props: ModalProps) {
  const portalContainer = usePortalContainer();
  const depth = useContext(ModalDepthContext);
  if (!props.isOpen) return null;
  return createPortal(
    <ModalDepthContext.Provider value={depth + 1}>
      <ModalSurface {...props} zIndex={MODAL_BASE_Z_INDEX + depth} />
    </ModalDepthContext.Provider>,
    portalContainer,
  );
}

/** The overlay z-index of a top-level Modal; nested ones add their depth. */
const MODAL_BASE_Z_INDEX = 200;

/** How many Modals enclose this point of the tree. */
const ModalDepthContext = createContext(0);

function ModalSurface({ onClose, title, children, maxWidth = 'max-w-md', size, mobileStyle = 'default', zIndex }: ModalProps & { zIndex: number }) {
  const { t } = useTranslation('common');
  const isMobile = useUIStore((s) => s.isMobile);
  const closeLabel = size === 'settings' ? t('chrome.closeSettings') : t('actions.close');

  const handleKeyDown = useCallback((e: KeyboardEvent) => {
    if (e.key === 'Escape') {
      onClose();
    }
  }, [onClose]);

  useEffect(() => {
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [handleKeyDown]);

  // Mobile fullscreen style
  if (isMobile && mobileStyle === 'fullscreen') {
    return (
      <div className="fixed inset-0 flex flex-col bg-surface-base animate-fade-in" style={{ zIndex }}>
        {(title || size === 'settings') && (
          <div className="flex items-center justify-between px-4 pt-4 flex-shrink-0" style={{ paddingTop: 'calc(16px + var(--safe-top))' }}>
            {title ? <h2 className="text-xl font-bold text-txt-primary">{title}</h2> : <div />}
            <button
              onClick={onClose}
              className="text-txt-tertiary hover:text-txt-primary transition-colors p-1"
              aria-label={closeLabel}
            >
              <svg width="24" height="24" viewBox="0 0 24 24" fill="currentColor">
                <path d="M18.4 4L12 10.4L5.6 4L4 5.6L10.4 12L4 18.4L5.6 20L12 13.6L18.4 20L20 18.4L13.6 12L20 5.6L18.4 4Z" />
              </svg>
            </button>
          </div>
        )}
        <div className={`${size === 'settings' ? '' : 'p-4 overflow-y-auto scrollbar-thin'} flex-1 min-h-0`} style={size === 'settings' ? undefined : { paddingBottom: 'calc(16px + var(--safe-bottom))' }}>
          {children}
        </div>
      </div>
    );
  }

  // Mobile bottom sheet style
  if (isMobile && mobileStyle === 'sheet') {
    return (
      <div className="fixed inset-0 flex items-end justify-center animate-fade-in" style={{ zIndex }}>
        <div
          className="absolute inset-0 bg-black/50"
          onClick={onClose}
        />
        <div className="relative w-full max-h-[calc(85*var(--app-vh))] flex flex-col glass-modal rounded-t-2xl animate-slide-up" style={{ paddingBottom: 'var(--safe-bottom)' }}>
          {title && (
            <div className="flex items-center justify-between px-4 pt-4 flex-shrink-0">
              <h2 className="text-xl font-bold text-txt-primary">{title}</h2>
              <button
                onClick={onClose}
                className="text-txt-tertiary hover:text-txt-primary transition-colors p-1"
                aria-label={closeLabel}
              >
                <svg width="24" height="24" viewBox="0 0 24 24" fill="currentColor">
                  <path d="M18.4 4L12 10.4L5.6 4L4 5.6L10.4 12L4 18.4L5.6 20L12 13.6L18.4 20L20 18.4L13.6 12L20 5.6L18.4 4Z" />
                </svg>
              </button>
            </div>
          )}
          <div className="p-4 overflow-y-auto scrollbar-thin flex-1 min-h-0">
            {children}
          </div>
        </div>
      </div>
    );
  }

  // Settings size variant — large glass overlay for settings screens
  if (size === 'settings') {
    return (
      <div className="fixed inset-0 flex items-center justify-center animate-fade-in" style={{ zIndex }}>
        <div
          className="absolute inset-0 bg-black/50"
          onClick={onClose}
        />
        <div className="relative w-[calc(90*var(--app-vw))] max-w-6xl h-[calc(85*var(--app-vh))] flex flex-col glass-modal rounded-xl animate-slide-up overflow-hidden">
          {/* Floating close button */}
          <button
            onClick={onClose}
            className="absolute top-4 right-4 z-10 p-1.5 rounded-full bg-surface-elevated/50 backdrop-blur-sm text-txt-tertiary hover:text-txt-primary transition-colors"
            aria-label={closeLabel}
          >
            <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor">
              <path d="M18.4 4L12 10.4L5.6 4L4 5.6L10.4 12L4 18.4L5.6 20L12 13.6L18.4 20L20 18.4L13.6 12L20 5.6L18.4 4Z" />
            </svg>
          </button>
          {children}
        </div>
      </div>
    );
  }

  // Default centered dialog (desktop and mobile default)
  return (
    <div className="fixed inset-0 flex items-center justify-center animate-fade-in" style={{ zIndex }}>
      <div
        className="absolute inset-0 bg-black/50"
        onClick={onClose}
      />
      <div className={`relative ${maxWidth} w-full mx-4 max-h-[calc(calc(100*var(--app-vh))-2rem)] flex flex-col glass-modal rounded-lg animate-slide-up`}>
        {title && (
          <div className="flex items-center justify-between px-4 pt-4 flex-shrink-0">
            <h2 className="text-xl font-bold text-txt-primary">{title}</h2>
            <button
              onClick={onClose}
              className="text-txt-tertiary hover:text-txt-primary transition-colors p-1"
              aria-label={closeLabel}
            >
              <svg width="24" height="24" viewBox="0 0 24 24" fill="currentColor">
                <path d="M18.4 4L12 10.4L5.6 4L4 5.6L10.4 12L4 18.4L5.6 20L12 13.6L18.4 20L20 18.4L13.6 12L20 5.6L18.4 4Z" />
              </svg>
            </button>
          </div>
        )}
        <div className="p-4 overflow-y-auto scrollbar-thin flex-1 min-h-0">
          {children}
        </div>
      </div>
    </div>
  );
}
