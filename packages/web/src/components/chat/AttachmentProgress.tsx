import React from 'react';
import type { TransferState } from '../../stores/transferStore';

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

function fmt(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

export function AttachmentProgress({ loaded, total, state, filename, error, onPause, onResume, onAbort, size = 'tile' }: Props) {
  const pct = total > 0 ? Math.min(100, Math.round((loaded / total) * 100)) : 0;
  const bg = state === 'failed' ? 'bg-accent-rose/30' : 'bg-accent-mint/30';
  const isFinal = state === 'completed' || state === 'aborted';
  return (
    <div className={`absolute inset-0 flex flex-col items-center justify-center gap-2 backdrop-blur-[2px] ${state === 'failed' ? 'bg-accent-rose/20' : 'bg-black/50'} pointer-events-auto`}>
      <div
        className={`w-9 h-9 rounded-full ${bg} flex items-center justify-center`}
        style={state !== 'failed' ? { background: `conic-gradient(rgba(180,220,200,.85) ${pct}%, rgba(255,255,255,.15) ${pct}%)` } : undefined}
        title={state === 'failed' ? error : undefined}
      >
        <div className="w-7 h-7 rounded-full bg-surface-overlay text-[10px] text-txt-primary flex items-center justify-center font-medium">
          {state === 'failed' ? '!' : `${pct}%`}
        </div>
      </div>
      {size === 'tile' && (
        <div className="text-[10px] text-txt-primary text-center leading-tight px-1">
          <div className="truncate max-w-[120px]">{filename}</div>
          <div className="opacity-60">{fmt(loaded)} / {fmt(total)}</div>
        </div>
      )}
      {!isFinal && (
        <div className="absolute top-1 right-1 flex gap-1">
          {state === 'paused' && onResume && (
            <button onClick={onResume} className="bg-black/60 hover:bg-black/80 text-white w-5 h-5 rounded text-[9px]" aria-label="Resume">▶</button>
          )}
          {state === 'active' && onPause && (
            <button onClick={onPause} className="bg-black/60 hover:bg-black/80 text-white w-5 h-5 rounded text-[9px]" aria-label="Pause">⏸</button>
          )}
          {onAbort && (
            <button onClick={onAbort} className="bg-black/60 hover:bg-black/80 text-white w-5 h-5 rounded text-[9px]" aria-label="Abort">✕</button>
          )}
        </div>
      )}
    </div>
  );
}
