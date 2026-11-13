import { useTranslation } from 'react-i18next';

export interface PreparingFile {
  id: string;
  name: string;
  kind: 'image' | 'video';
  /** 0..1 while a video encodes; null while a photo is being drawn (too quick to measure). */
  progress: number | null;
}

interface PreparingFileTilesProps {
  files: PreparingFile[];
  /** Stop compressing and upload the file as it is. */
  onSendOriginal: (id: string) => void;
  /** Drop the file: nothing is uploaded. */
  onCancel: (id: string) => void;
}

/**
 * Files being shrunk on this device before their upload starts. A video can take
 * a while, so each tile shows how far it is and offers to send the original
 * instead; the upload tile (`StagedTransferTiles`) takes over once it begins.
 */
export function PreparingFileTiles({ files, onSendOriginal, onCancel }: PreparingFileTilesProps) {
  const { t } = useTranslation('chat');
  if (files.length === 0) return null;

  return (
    <div className="px-4 pt-4 flex flex-wrap gap-4 bg-surface-channel/30">
      {files.map((file) => {
        const percent = file.progress === null ? null : Math.round(Math.min(1, Math.max(0, file.progress)) * 100);
        return (
          <div
            key={file.id}
            className="relative bg-surface-channel rounded-lg p-3 w-[220px] shadow-elevation-low border border-border-hard"
            role="status"
            aria-live="polite"
          >
            <div className="text-sm text-txt-primary font-medium truncate" title={file.name}>{file.name}</div>
            <div className="text-xs text-txt-tertiary mt-0.5">
              {file.kind === 'video'
                ? t('composer.preparing.video', { percent: percent ?? 0 })
                : t('composer.preparing.image')}
            </div>
            <div className="mt-2 h-1.5 rounded-full bg-surface-input overflow-hidden">
              {percent === null ? (
                <div className="h-full w-1/3 rounded-full bg-accent-primary animate-pulse" />
              ) : (
                <div className="h-full rounded-full bg-accent-primary transition-[width] duration-200" style={{ width: `${percent}%` }} />
              )}
            </div>
            <div className="mt-2 flex items-center justify-between gap-2">
              <button
                type="button"
                onClick={() => onSendOriginal(file.id)}
                className="text-xs text-txt-secondary hover:text-txt-primary transition-colors underline-offset-2 hover:underline"
              >
                {t('composer.preparing.sendOriginal')}
              </button>
              <button
                type="button"
                onClick={() => onCancel(file.id)}
                className="text-xs text-accent-rose hover:text-accent-rose/80 transition-colors"
              >
                {t('composer.preparing.cancel')}
              </button>
            </div>
          </div>
        );
      })}
    </div>
  );
}
