import React from 'react';
import { useTranslation } from 'react-i18next';
import { AttachmentProgress } from './AttachmentProgress';
import type { Transfer } from '../../stores/transferStore';

interface StagedTransferTilesProps {
  stagedTransfers: Transfer[];
  previewUrls: Map<string, string>;
  onPause: (id: string) => void;
  onResume: (id: string) => void;
  onRemove: (id: string) => void;
}

export function StagedTransferTiles({
  stagedTransfers,
  previewUrls,
  onPause,
  onResume,
  onRemove,
}: StagedTransferTilesProps) {
  const { t } = useTranslation('chat');

  if (stagedTransfers.length === 0) return null;

  return (
    <div className="p-4 flex flex-wrap gap-4 bg-surface-channel/30">
      {stagedTransfers.map((transfer) => {
        const isImage = transfer.file.mimetype.startsWith('image/');
        const isFinal = transfer.state === 'completed';
        const showOverlay = transfer.state !== 'completed';
        const previewUrl = previewUrls.get(transfer.id);
        return (
          <div
            key={transfer.id}
            className="relative group bg-surface-channel rounded-lg p-2 max-w-[200px] shadow-elevation-low border border-border-hard overflow-hidden"
          >
            {isImage ? (
              <div className="w-[150px] h-[150px] bg-surface-input/40 rounded flex items-center justify-center text-txt-tertiary overflow-hidden">
                {previewUrl ? (
                  <img
                    src={previewUrl}
                    alt={transfer.file.name}
                    className="w-full h-full object-cover"
                  />
                ) : (
                  <svg className="w-10 h-10 opacity-60" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16l4.586-4.586a2 2 0 012.828 0L16 16m-2-2l1.586-1.586a2 2 0 012.828 0L20 14m-6-6h.01M6 20h12a2 2 0 002-2V6a2 2 0 00-2-2H6a2 2 0 00-2 2v12a2 2 0 002 2z" />
                  </svg>
                )}
              </div>
            ) : (
              <div className="flex items-center gap-2 text-sm text-txt-secondary py-4 px-2">
                <svg className="w-8 h-8 opacity-60" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth={2}
                    d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z"
                  />
                </svg>
                <span className="truncate max-w-[120px] font-medium">{transfer.file.name}</span>
              </div>
            )}

            {/* Overlay: progress / paused / failed indicator (driven by AttachmentProgress) */}
            {showOverlay && (
              <AttachmentProgress
                loaded={transfer.progress.loaded}
                total={transfer.progress.total}
                state={transfer.state}
                filename={transfer.file.name}
                size="tile"
                onPause={transfer.state === 'active' ? () => onPause(transfer.id) : undefined}
                onResume={transfer.state === 'paused' ? () => void onResume(transfer.id) : undefined}
                onAbort={() => onRemove(transfer.id)}
              />
            )}

            {/* Final-state remove button (top-right rose chip) — only when completed */}
            {isFinal && (
              <button
                onClick={() => onRemove(transfer.id)}
                className="absolute -top-2 -right-2 w-7 h-7 bg-accent-rose hover:bg-accent-rose/80 shadow-elevation-high rounded-lg flex items-center justify-center text-white transition-colors z-10"
                aria-label={t('composer.removeAttachment')}
              >
                <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor">
                  <path d="M5 2a1 1 0 011-1h4a1 1 0 011 1v1h3a1 1 0 110 2h-.08L13 14a2 2 0 01-2 2H5a2 2 0 01-2-2L2.08 5H2a1 1 0 110-2h3V2zm2 0v1h2V2H7z" />
                </svg>
              </button>
            )}
          </div>
        );
      })}
    </div>
  );
}
