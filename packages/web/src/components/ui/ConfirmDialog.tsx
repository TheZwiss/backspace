import React, { useEffect, useCallback } from 'react';
import ReactDOM from 'react-dom';

interface ConfirmDialogProps {
  isOpen: boolean;
  onClose: () => void;
  onConfirm: () => void | Promise<void>;
  title: string;
  description: string | React.ReactNode;
  confirmLabel?: string;
  cancelLabel?: string;
  variant?: 'danger' | 'warning';
  loading?: boolean;
}

export function ConfirmDialog({
  isOpen,
  onClose,
  onConfirm,
  title,
  description,
  confirmLabel = 'Confirm',
  cancelLabel = 'Cancel',
  variant = 'danger',
  loading = false,
}: ConfirmDialogProps) {
  const handleKeyDown = useCallback((e: KeyboardEvent) => {
    if (e.key === 'Escape' && !loading) {
      e.stopPropagation();
      onClose();
    }
  }, [onClose, loading]);

  useEffect(() => {
    if (isOpen) {
      document.addEventListener('keydown', handleKeyDown, true);
      return () => document.removeEventListener('keydown', handleKeyDown, true);
    }
  }, [isOpen, handleKeyDown]);

  if (!isOpen) return null;

  const isDanger = variant === 'danger';
  const confirmBg = isDanger
    ? 'bg-accent-rose hover:bg-accent-rose/80'
    : 'bg-accent-amber hover:bg-accent-amber/80';

  return ReactDOM.createPortal(
    <div className="fixed inset-0 z-[10000] flex items-center justify-center animate-fade-in">
      <div
        className="absolute inset-0 bg-black/50"
        onClick={() => { if (!loading) onClose(); }}
      />
      <div className="relative max-w-[440px] w-full mx-4 glass-modal rounded-xl animate-slide-up">
        <div className="p-5">
          <h3 className="text-lg font-semibold text-txt-primary mb-2">{title}</h3>
          <div className="text-sm text-txt-secondary mb-5 leading-relaxed">{description}</div>
          <div className="flex gap-3">
            <button
              onClick={onClose}
              disabled={loading}
              className="flex-1 py-2.5 text-sm font-medium text-txt-secondary bg-interactive-hover hover:bg-interactive-selected rounded-lg transition-colors disabled:opacity-50"
            >
              {cancelLabel}
            </button>
            <button
              onClick={onConfirm}
              disabled={loading}
              className={`flex-1 py-2.5 ${confirmBg} text-white text-sm font-medium rounded-lg transition-colors disabled:opacity-50`}
            >
              {loading ? 'Please wait...' : confirmLabel}
            </button>
          </div>
        </div>
      </div>
    </div>,
    document.body,
  );
}
