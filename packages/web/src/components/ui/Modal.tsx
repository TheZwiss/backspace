import React, { useEffect, useCallback } from 'react';

interface ModalProps {
  isOpen: boolean;
  onClose: () => void;
  title?: string;
  children: React.ReactNode;
  maxWidth?: string;
}

export function Modal({ isOpen, onClose, title, children, maxWidth = 'max-w-md' }: ModalProps) {
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
