import React, { useEffect, useCallback } from 'react';
import { useUIStore } from '../../stores/uiStore';

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

export function Modal({ isOpen, onClose, title, children, maxWidth = 'max-w-md', size, mobileStyle = 'default' }: ModalProps) {
  const isMobile = useUIStore((s) => s.isMobile);

  const handleKeyDown = useCallback((e: KeyboardEvent) => {
    if (e.key === 'Escape') {
      onClose();
    }
  }, [onClose]);

  useEffect(() => {
    if (isOpen) {
      document.addEventListener('keydown', handleKeyDown);
      return () => document.removeEventListener('keydown', handleKeyDown);
    }
  }, [isOpen, handleKeyDown]);

  if (!isOpen) return null;

  // Mobile fullscreen style
  if (isMobile && mobileStyle === 'fullscreen') {
    return (
      <div className="fixed inset-0 z-[200] flex flex-col bg-surface-base animate-fade-in">
        {(title || size === 'settings') && (
          <div className="flex items-center justify-between px-4 pt-4 flex-shrink-0" style={{ paddingTop: 'calc(16px + env(safe-area-inset-top))' }}>
            {title ? <h2 className="text-xl font-bold text-txt-primary">{title}</h2> : <div />}
            <button
              onClick={onClose}
              className="text-txt-tertiary hover:text-txt-primary transition-colors p-1"
              aria-label={size === 'settings' ? 'Close settings' : undefined}
            >
              <svg width="24" height="24" viewBox="0 0 24 24" fill="currentColor">
                <path d="M18.4 4L12 10.4L5.6 4L4 5.6L10.4 12L4 18.4L5.6 20L12 13.6L18.4 20L20 18.4L13.6 12L20 5.6L18.4 4Z" />
              </svg>
            </button>
          </div>
        )}
        <div className={`${size === 'settings' ? '' : 'p-4 overflow-y-auto scrollbar-thin'} flex-1 min-h-0`} style={size === 'settings' ? undefined : { paddingBottom: 'calc(16px + env(safe-area-inset-bottom))' }}>
          {children}
        </div>
      </div>
    );
  }

  // Mobile bottom sheet style
  if (isMobile && mobileStyle === 'sheet') {
    return (
      <div className="fixed inset-0 z-[200] flex items-end justify-center animate-fade-in">
        <div
          className="absolute inset-0 bg-black/50"
          onClick={onClose}
        />
        <div className="relative w-full max-h-[85vh] flex flex-col glass-modal rounded-t-2xl animate-slide-up" style={{ paddingBottom: 'env(safe-area-inset-bottom)' }}>
          {title && (
            <div className="flex items-center justify-between px-4 pt-4 flex-shrink-0">
              <h2 className="text-xl font-bold text-txt-primary">{title}</h2>
              <button
                onClick={onClose}
                className="text-txt-tertiary hover:text-txt-primary transition-colors p-1"
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
      <div className="fixed inset-0 z-[200] flex items-center justify-center animate-fade-in">
        <div
          className="absolute inset-0 bg-black/50"
          onClick={onClose}
        />
        <div className="relative w-[90vw] max-w-6xl h-[85vh] flex flex-col glass-modal rounded-xl animate-slide-up overflow-hidden">
          {/* Floating close button */}
          <button
            onClick={onClose}
            className="absolute top-4 right-4 z-10 p-1.5 rounded-full bg-surface-elevated/50 backdrop-blur-sm text-txt-tertiary hover:text-txt-primary transition-colors"
            aria-label="Close settings"
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
    <div className="fixed inset-0 z-[200] flex items-center justify-center animate-fade-in">
      <div
        className="absolute inset-0 bg-black/50"
        onClick={onClose}
      />
      <div className={`relative ${maxWidth} w-full mx-4 max-h-[calc(100vh-2rem)] flex flex-col glass-modal rounded-lg animate-slide-up`}>
        {title && (
          <div className="flex items-center justify-between px-4 pt-4 flex-shrink-0">
            <h2 className="text-xl font-bold text-txt-primary">{title}</h2>
            <button
              onClick={onClose}
              className="text-txt-tertiary hover:text-txt-primary transition-colors p-1"
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
