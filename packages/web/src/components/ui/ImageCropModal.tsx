import { createPortal } from 'react-dom';
import { usePortalContainer } from '../../hooks/usePortalContainer';
import React, { useState, useCallback, useEffect, useRef, type ReactNode } from 'react';
import { useDialogLayer } from '../../hooks/useDialogLayer';
import { useTranslation } from 'react-i18next';
import Cropper from 'react-easy-crop';
import type { Area } from 'react-easy-crop';
import { cropImage } from '../../utils/cropImage';

interface ImageCropModalProps {
  isOpen: boolean;
  onClose: () => void;
  imageSrc: string;
  onCropComplete: (blob: Blob) => void;
  title?: string;
  aspectRatio?: number;
  cropShape?: 'round' | 'rect';
  maxOutputDimension?: number;
  outputType?: string;
  onCropSelection?: (pixels: Area, percentage: Area) => void | Promise<void>;
  extraContent?: ReactNode;
  applyDisabled?: boolean;
  error?: string;
}

export function ImageCropModal({
  isOpen,
  onClose,
  imageSrc,
  onCropComplete,
  title,
  aspectRatio = 1,
  cropShape = 'round',
  maxOutputDimension,
  outputType,
  onCropSelection,
  extraContent,
  applyDisabled = false,
  error,
}: ImageCropModalProps) {
  const { t } = useTranslation(['uploads', 'common']);
  const portalContainer = usePortalContainer();
  const heading = title ?? t('uploads:crop.title');
  const [crop, setCrop] = useState({ x: 0, y: 0 });
  const [zoom, setZoom] = useState(1);
  const [croppedAreaPixels, setCroppedAreaPixels] = useState<Area | null>(null);
  const [croppedArea, setCroppedArea] = useState<Area | null>(null);
  const [isProcessing, setIsProcessing] = useState(false);
  const dialogRef = useRef<HTMLDivElement>(null);
  useDialogLayer(dialogRef, { open: isOpen, onClose, dismissible: !isProcessing, label: heading });

  const handleCropComplete = useCallback((percentage: Area, croppedPixels: Area) => {
    setCroppedArea(percentage);
    setCroppedAreaPixels(croppedPixels);
  }, []);

  const handleApply = async () => {
    if (!croppedAreaPixels) return;
    setIsProcessing(true);
    try {
      if (onCropSelection && croppedArea) {
        await onCropSelection(croppedAreaPixels, croppedArea);
        onClose();
        return;
      }
      const blob = await cropImage(imageSrc, croppedAreaPixels, outputType ?? 'image/webp', {
        maxDimension: maxOutputDimension,
        outputType,
      });
      onCropComplete(blob);
      onClose();
    } catch {
      // Silently fail — user can retry
    } finally {
      setIsProcessing(false);
    }
  };

  // Reset state when opened with a new image
  useEffect(() => {
    if (isOpen) {
      setCrop({ x: 0, y: 0 });
      setZoom(1);
      setCroppedAreaPixels(null);
      setCroppedArea(null);
      setIsProcessing(false);
    }
  }, [isOpen, imageSrc]);

  if (!isOpen) return null;

  return createPortal(
    <div ref={dialogRef} className="fixed inset-0 z-[210] flex items-center justify-center animate-fade-in">
      <div data-icon-motion="press" className="absolute inset-0 bg-surface-overlay" onClick={onClose} />
      <div className="relative max-w-md w-full mx-4 bg-surface-elevated rounded-lg shadow-xl animate-slide-up">
        {/* Title bar */}
        <div className="flex items-center justify-between px-4 pt-4">
          <h2 className="text-xl font-bold text-txt-primary">{heading}</h2>
          <button data-icon-motion="press"
            onClick={onClose}
            className="text-txt-tertiary hover:text-txt-primary transition-colors p-1"
            aria-label={t('common:actions.close')}
          >
            <svg width="24" height="24" viewBox="0 0 24 24" fill="currentColor">
              <path d="M18.4 4L12 10.4L5.6 4L4 5.6L10.4 12L4 18.4L5.6 20L12 13.6L18.4 20L20 18.4L13.6 12L20 5.6L18.4 4Z" />
            </svg>
          </button>
        </div>

        <p className="px-4 mt-2 text-xs text-txt-tertiary">{t('uploads:crop.hint')}</p>
        {/* Crop area */}
        {/* react-easy-crop mixes DOM rect/client coordinates with CSS pixels.
            Keep only its interactive canvas at effective 100%; dialog controls
            still use the selected interface scale. */}
        <div className="relative h-[350px] mx-4 mt-3 rounded-lg overflow-hidden bg-surface-base"
          style={{ zoom: 'calc(1 / var(--interface-scale, 1))' }}>
          <Cropper
            image={imageSrc}
            crop={crop}
            zoom={zoom}
            aspect={aspectRatio}
            cropShape={cropShape}
            showGrid={false}
            onCropChange={setCrop}
            onZoomChange={setZoom}
            onCropComplete={handleCropComplete}
          />
        </div>

        {/* Zoom slider */}
        <div className="px-4 pt-3 flex items-center gap-3">
          <svg className="w-4 h-4 text-txt-tertiary flex-shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0zM10 7v3m0 0v3m0-3h3m-3 0H7" />
          </svg>
          <input
            type="range"
            aria-label={t('uploads:crop.zoom')}
            min={1}
            max={3}
            step={0.05}
            value={zoom}
            onChange={(e) => setZoom(Number(e.target.value))}
            className="ui-range"
          />
        </div>

        {extraContent && <div className="px-4 pt-3">{extraContent}</div>}
        {error && <p role="alert" className="mx-4 mt-3 rounded-lg bg-accent-rose/10 px-3 py-2 text-xs text-txt-danger">{error}</p>}

        {/* Actions */}
        <div className="flex gap-3 p-4">
          <button data-icon-motion="press"
            type="button"
            onClick={onClose}
            className="flex-1 py-2.5 text-sm font-medium text-txt-secondary bg-interactive-hover hover:bg-interactive-selected rounded-lg transition-colors"
          >
            {t('common:actions.cancel')}
          </button>
          <button data-icon-motion="press"
            type="button"
            onClick={handleApply}
            disabled={isProcessing || !croppedAreaPixels || applyDisabled}
            className="ui-button ui-button-primary flex-1 transition-colors disabled:opacity-50"
          >
            {isProcessing ? t('uploads:crop.applying') : t('common:actions.apply')}
          </button>
        </div>
      </div>
    </div>,
    portalContainer,
  );
}
