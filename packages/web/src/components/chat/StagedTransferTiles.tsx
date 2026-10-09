import React, { useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { useComposerStore } from '../../stores/composerStore';
import { useTransferStore, type Transfer } from '../../stores/transferStore';
import { AttachmentProgress } from './AttachmentProgress';

interface StagedTransferTilesProps {
  channelId: string;
  stagedTransfers: Transfer[];
  previewUrls: Map<string, string>;
}

export function StagedTransferTiles({ channelId, stagedTransfers, previewUrls }: StagedTransferTilesProps) {
  const { t } = useTranslation('chat');
  const removeStaged = useComposerStore((s) => s.removeStaged);
  const pauseUpload = useTransferStore((s) => s.pauseUpload);
  const resumeUpload = useTransferStore((s) => s.resumeUpload);
  const abortUpload = useTransferStore((s) => s.abortUpload);

  const removeStagedTransfer = useCallback(
    (transferId: string) => {
      // Revoke any in-session image preview URL.
      const previewUrl = previewUrls.get(transferId);
      if (previewUrl) {
        URL.revokeObjectURL(previewUrl);
        previewUrls.delete(transferId);
      }

      const t = useTransferStore.getState().transfers.get(transferId);
      if (t?.state === 'completed') {
        // Fully-uploaded attachment with a finalized DB row. Server-side bytes
        // get cleaned by the unlinked-attachment janitor (1h grace).
        useTransferStore.getState().remove(transferId);
      } else if (t && t.state !== 'aborted') {
        // active/paused/queued/failed: abortUpload tears down any live tus
        // instance AND sends DELETE for orphaned server-side .tus sessions.
        // Then drop the transfer + free the retained File reference.
        abortUpload(transferId);
        useTransferStore.getState().remove(transferId);
      } else {
        // Already 'aborted' (server already cleaned); just drop the record.
        useTransferStore.getState().remove(transferId);
      }
      removeStaged(channelId, transferId);
    },
    [abortUpload, removeStaged, channelId, previewUrls],
  );

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
            className="relative group bg-surface-channel rounded-lg p-2 max-w-[200px] shadow-elevation-low border border-border-hard"
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

            {/* Clip the overlay, not the remove chip that extends beyond the tile. */}
            {showOverlay && (
              <div className="absolute inset-0 rounded-lg overflow-hidden">
                <AttachmentProgress
                  loaded={transfer.progress.loaded}
                  total={transfer.progress.total}
                  state={transfer.state}
                  filename={transfer.file.name}
                  size="tile"
                  onPause={transfer.state === 'active' ? () => pauseUpload(transfer.id) : undefined}
                  onResume={transfer.state === 'paused' ? () => void resumeUpload(transfer.id) : undefined}
                  onAbort={() => removeStagedTransfer(transfer.id)}
                />
              </div>
            )}

            {/* Final-state remove button (top-right rose chip) — only when completed */}
            {isFinal && (
              <button
                onClick={() => removeStagedTransfer(transfer.id)}
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
