import React from 'react';
import { useTranslation } from 'react-i18next';
import type { TransferState } from '../../stores/transferStore';
import { useFormatters } from '../../i18n/formatters';

interface Props {
  loaded: number;
  total: number;
  state: TransferState;
  filename: string;
  /** Optional human-readable error surfaced as a hover tooltip when state==='failed'. */
  error?: string;
  onPause?: () => void;
  onResume?: () => void;
  onAbort?: () => void;
  size?: 'tile' | 'pill';
}

export function AttachmentProgress({ loaded, total, state, filename, error, onPause, onResume, onAbort, size = 'tile' }: Props) {
  const { t } = useTranslation(['chat', 'common']);
  const { formatBytes, formatPercent } = useFormatters();
  const pct = total > 0 ? Math.min(100, Math.round((loaded / total) * 100)) : 0;
  const bg = state === 'failed' ? 'bg-accent-rose/30' : state === 'paused' ? 'bg-white/5' : 'bg-accent-mint/30';
  const isFinal = state === 'completed' || state === 'aborted';
  // Desaturate the conic-gradient ring when paused so it can't be mistaken for
  // active progress. Active uses mint; paused uses a muted grey.
  const ringColor = state === 'paused' ? 'rgba(180,180,190,.5)' : 'rgba(180,220,200,.85)';
  const ringTrack = 'rgba(255,255,255,.15)';
  const ringTitle = state === 'failed'
    ? error
    : state === 'paused'
      ? t('chat:attachment.progress.pausedTitle', { percent: formatPercent(pct) })
      : undefined;
  return (
    <div className={`absolute inset-0 flex flex-col items-center justify-center gap-2 backdrop-blur-[2px] ${state === 'failed' ? 'bg-accent-rose/20' : 'bg-black/50'} pointer-events-auto`}>
      <div
        className={`w-9 h-9 rounded-full ${bg} flex items-center justify-center`}
        style={state !== 'failed' ? { background: `conic-gradient(${ringColor} ${pct}%, ${ringTrack} ${pct}%)` } : undefined}
        title={ringTitle}
      >
        <div className="w-7 h-7 rounded-full bg-surface-overlay text-[10px] text-txt-primary flex items-center justify-center font-medium">
          {state === 'paused' ? (
            <svg width="10" height="10" viewBox="0 0 10 10" fill="currentColor" aria-hidden="true">
              <rect x="2" y="1.5" width="2" height="7" rx="0.5" />
              <rect x="6" y="1.5" width="2" height="7" rx="0.5" />
            </svg>
          ) : state === 'failed' ? (
            '!'
          ) : (
            formatPercent(pct)
          )}
        </div>
      </div>
      {size === 'tile' && (
        <div className="text-[10px] text-txt-primary text-center leading-tight px-1">
          <div className="truncate max-w-[120px]">{filename}</div>
          <div className="opacity-60">{formatBytes(loaded)} / {formatBytes(total)}</div>
        </div>
      )}
      {!isFinal && (
        <div className="absolute top-1 right-1 flex gap-1">
          {state === 'paused' && onResume && (
            <button onClick={onResume} className="bg-black/60 hover:bg-black/80 text-white w-5 h-5 rounded text-[9px]" aria-label={t('common:actions.resume')}>▶</button>
          )}
          {state === 'active' && onPause && (
            <button onClick={onPause} className="bg-black/60 hover:bg-black/80 text-white w-5 h-5 rounded text-[9px]" aria-label={t('common:actions.pause')}>⏸</button>
          )}
          {onAbort && (
            <button onClick={onAbort} className="bg-black/60 hover:bg-black/80 text-white w-5 h-5 rounded text-[9px]" aria-label={t('common:actions.abort')}>✕</button>
          )}
        </div>
      )}
    </div>
  );
}
