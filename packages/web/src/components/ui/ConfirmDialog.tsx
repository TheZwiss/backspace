import { Button } from './Button';
import React, { useRef } from 'react';
import { useDialogLayer } from '../../hooks/useDialogLayer';
import ReactDOM from 'react-dom';
import { useTranslation } from 'react-i18next';
import { usePortalContainer } from '../../hooks/usePortalContainer';

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
  confirmLabel,
  cancelLabel,
  variant = 'danger',
  loading = false,
}: ConfirmDialogProps) {
  const { t } = useTranslation(['common']);
  const dialogRef = useRef<HTMLDivElement>(null);
  useDialogLayer(dialogRef, { open: isOpen, onClose, dismissible: !loading, label: title });

  const portalContainer = usePortalContainer();

  if (!isOpen) return null;


  return ReactDOM.createPortal(
    <div ref={dialogRef} className="fixed inset-0 z-confirm flex items-center justify-center animate-fade-in">
      <div
        className="absolute inset-0 bg-black/50"
        onClick={() => { if (!loading) onClose(); }}
      />
      <div className="relative max-w-md w-full mx-4 ui-dialog-surface animate-slide-up">
        <div className="p-5">
          <h3 className="ui-dialog-title mb-2">{title}</h3>
          <div className="text-sm text-txt-secondary mb-5 leading-relaxed">{description}</div>
          <div className="flex gap-3">
            <Button
              variant="secondary"
              onClick={onClose}
              disabled={loading}
              className="flex-1"
            >
              {cancelLabel ?? t('common:actions.cancel')}
            </Button>
            <Button
              variant={variant}
              onClick={onConfirm}
              disabled={loading}
              className="flex-1"
            >
              {loading ? t('common:states.pleaseWait') : (confirmLabel ?? t('common:actions.confirm'))}
            </Button>
          </div>
        </div>
      </div>
    </div>,
    portalContainer,
  );
}
