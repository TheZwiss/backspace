import React from 'react';
import { useUIStore } from '../../stores/uiStore';
import { saveImage, copyImageToClipboard } from '../../utils/imageActions';

export function ImagePreview() {
  const imageUrl = useUIStore((s) => s.imagePreviewUrl);
  const closeImagePreview = useUIStore((s) => s.closeImagePreview);
  const activeModal = useUIStore((s) => s.activeModal);

  if (activeModal !== 'imagePreview' || !imageUrl) return null;

  return (
    <div
      className="fixed inset-0 z-[200] flex items-center justify-center bg-surface-overlay animate-fade-in cursor-pointer"
      onClick={closeImagePreview}
    >
      {/* Toolbar: download, copy, close */}
      <div className="absolute top-4 right-4 flex items-center gap-2 z-10">
        <button
          className="text-white/70 hover:text-white transition-colors"
          onClick={(e) => {
            e.stopPropagation();
            saveImage(imageUrl);
          }}
          title="Save image"
        >
          <svg width="24" height="24" viewBox="0 0 24 24" fill="currentColor">
            <path d="M19 9h-4V3H9v6H5l7 7 7-7zM5 18v2h14v-2H5z" />
          </svg>
        </button>
        <button
          className="text-white/70 hover:text-white transition-colors"
          onClick={(e) => {
            e.stopPropagation();
            copyImageToClipboard(imageUrl);
          }}
          title="Copy image"
        >
          <svg width="24" height="24" viewBox="0 0 24 24" fill="currentColor">
            <path d="M21 9v10c0 1.1-.9 2-2 2H8c-1.1 0-2-.9-2-2V5c0-1.1.9-2 2-2h7l6 6zm-2 1h-5V4H8v15h11V10zM3 15V3c0-1.1.9-2 2-2h9v2H5v12H3z" />
          </svg>
        </button>
        <button
          className="text-white/70 hover:text-white transition-colors"
          onClick={closeImagePreview}
          title="Close"
        >
          <svg width="24" height="24" viewBox="0 0 24 24" fill="currentColor">
            <path d="M18.4 4L12 10.4L5.6 4L4 5.6L10.4 12L4 18.4L5.6 20L12 13.6L18.4 20L20 18.4L13.6 12L20 5.6L18.4 4Z" />
          </svg>
        </button>
      </div>
      <img
        src={imageUrl}
        alt="Preview"
        className="max-w-[90vw] max-h-[90vh] object-contain rounded shadow-elevation-high"
        onClick={(e) => e.stopPropagation()}
      />
    </div>
  );
}
