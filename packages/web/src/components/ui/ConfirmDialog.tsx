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
    if (e.key === 'Escape' && !loading) onClose();
  }, [onClose, loading]);

  useEffect(() => {
    if (isOpen) {
      document.addEventListener('keydown', handleKeyDown);
      return () => document.removeEventListener('keydown', handleKeyDown);
    }
  }, [isOpen, handleKeyDown]);

  if (!isOpen) return null;

  const isDanger = variant === 'danger';
  const accentBg = isDanger ? 'bg-accent-rose/10' : 'bg-accent-amber/10';
  const accentBorder = isDanger ? 'border-accent-rose/20' : 'border-accent-amber/20';
  const confirmBg = isDanger
    ? 'bg-accent-rose hover:bg-accent-rose/80'
    : 'bg-accent-amber hover:bg-accent-amber/80';

  return ReactDOM.createPortal(
    <div className="fixed inset-0 z-[10000] flex items-center justify-center animate-fade-in">
      <div
        className="absolute inset-0 bg-black/50"
        onClick={() => { if (!loading) onClose(); }}
      />
      <div className="relative max-w-sm w-full mx-4 glass-modal rounded-lg animate-slide-up">
        <div className="p-4">
          <h3 className="text-base font-semibold text-txt-primary mb-3">{title}</h3>
          <div className={`p-3 rounded-lg ${accentBg} border ${accentBorder} mb-4`}>
            <div className="text-sm text-txt-secondary">{description}</div>
          </div>
          <div className="flex justify-end gap-2">
            <button
              onClick={onClose}
              disabled={loading}
              className="px-3 py-1.5 text-sm text-txt-secondary hover:text-txt-primary transition-colors disabled:opacity-50"
            >
              {cancelLabel}
            </button>
            <button
              onClick={onConfirm}
              disabled={loading}
              className={`px-3 py-1.5 ${confirmBg} text-white text-sm font-medium rounded transition-colors disabled:opacity-50`}
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
