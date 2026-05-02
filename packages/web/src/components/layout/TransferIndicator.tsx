import React, { useState, useRef, useEffect, useMemo } from 'react';
import { useTransferStore, type Transfer } from '../../stores/transferStore';

function fmt(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

export function TransferIndicator() {
  // Subscribe to the Map directly. `listVisible()` returns a fresh array each call,
  // which would force a re-render on every store mutation. The Map reference only
  // changes when transfers are added/removed/updated, so useMemo recomputes only
  // when needed.
  const transfersMap = useTransferStore((s) => s.transfers);
  const visible = useMemo(
    () => Array.from(transfersMap.values()).filter((t) => t.tray),
    [transfersMap],
  );

  const pause = useTransferStore((s) => s.pauseUpload);
  const resume = useTransferStore((s) => s.resumeUpload);
  const abort = useTransferStore((s) => s.abortUpload);
  const pauseDl = useTransferStore((s) => s.pauseDownload);
  const resumeDl = useTransferStore((s) => s.resumeDownload);
  const abortDl = useTransferStore((s) => s.abortDownload);
  const remove = useTransferStore((s) => s.remove);

  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onClick = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onClick);
    return () => document.removeEventListener('mousedown', onClick);
  }, [open]);

  const active = visible.filter(
    (t) => t.state === 'active' || t.state === 'paused' || t.state === 'queued',
  );
  const failed = visible.some((t) => t.state === 'failed');
  const idle = visible.length === 0;

  const badgeColor = failed ? 'bg-accent-rose' : 'bg-accent-amber';

  return (
    <div className="relative" ref={ref}>
      <button
        onClick={() => setOpen((v) => !v)}
        className={`relative w-8 h-8 flex items-center justify-center rounded-[6px] transition-colors ${
          idle
            ? 'text-txt-tertiary/60 hover:text-txt-tertiary hover:bg-interactive-hover'
            : 'text-txt-tertiary hover:text-txt-primary hover:bg-interactive-hover'
        }`}
        title="Transfers"
        aria-label="Transfers"
      >
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M12 4v12m0 0l-4-4m4 4l4-4M4 20h16" />
        </svg>
        {active.length > 0 && (
          <span className={`absolute -top-0.5 -right-0.5 ${badgeColor} text-black text-[10px] font-medium rounded-full px-1.5 leading-4 min-w-[16px] text-center`}>
            {active.length}
          </span>
        )}
      </button>
      {open && (
        <div className="absolute right-0 top-full mt-2 w-[300px] max-w-[calc(100vw-1rem)] glass z-50 rounded-lg overflow-hidden">
          <div className="px-3 py-2 border-b border-border-soft text-xs flex justify-between items-center">
            <span className="text-txt-secondary">
              {visible.length} transfer{visible.length === 1 ? '' : 's'}
            </span>
            <button
              onClick={() =>
                visible
                  .filter((t) => t.state === 'completed' || t.state === 'aborted')
                  .forEach((t) => remove(t.id))
              }
              className="text-txt-tertiary hover:text-txt-primary transition-colors"
            >
              Clear completed
            </button>
          </div>
          {visible.length === 0 && (
            <div className="px-3 py-6 text-center text-txt-tertiary text-xs">
              No active transfers.
            </div>
          )}
          <div className="max-h-[400px] overflow-y-auto">
            {visible.map((t) => (
              <TransferRow
                key={t.id}
                transfer={t}
                onPause={() => (t.type === 'upload' ? pause(t.id) : pauseDl(t.id))}
                onResume={() => {
                  if (t.type === 'upload') void resume(t.id);
                  else void resumeDl(t.id);
                }}
                onAbort={() => (t.type === 'upload' ? abort(t.id) : abortDl(t.id))}
                onDismiss={() => remove(t.id)}
              />
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

interface TransferRowProps {
  transfer: Transfer;
  onPause: () => void;
  onResume: () => void;
  onAbort: () => void;
  onDismiss: () => void;
}

function TransferRow({ transfer, onPause, onResume, onAbort, onDismiss }: TransferRowProps) {
  const pct =
    transfer.progress.total > 0
      ? Math.min(100, Math.round((transfer.progress.loaded / transfer.progress.total) * 100))
      : 0;
  const barColor =
    transfer.state === 'failed'
      ? 'bg-accent-rose'
      : transfer.state === 'completed'
      ? 'bg-accent-mint'
      : 'bg-accent-mint/70';
  return (
    <div className="px-3 py-2 border-b border-border-soft last:border-none">
      <div className="flex items-center gap-2 text-[11px]">
        <span className="text-txt-tertiary text-[10px]">
          {transfer.type === 'upload' ? '↑' : '↓'}
        </span>
        <span className="text-txt-primary truncate flex-1">{transfer.file.name}</span>
      </div>
      <div className="mt-1 h-[3px] bg-surface-input rounded overflow-hidden">
        <div className={`h-full ${barColor} transition-[width]`} style={{ width: `${pct}%` }} />
      </div>
      <div className="mt-1 flex justify-between items-center text-[10px] text-txt-tertiary gap-2">
        <span className="truncate">
          {transfer.state === 'completed'
            ? 'Done'
            : transfer.state === 'failed'
            ? `Failed: ${transfer.error?.message ?? 'unknown'}`
            : transfer.state === 'aborted'
            ? 'Aborted'
            : `${fmt(transfer.progress.loaded)} / ${fmt(transfer.progress.total)}`}
        </span>
        <span className="flex gap-2 flex-shrink-0">
          {transfer.state === 'active' && (
            <button onClick={onPause} className="hover:text-txt-primary transition-colors">
              Pause
            </button>
          )}
          {transfer.state === 'paused' && (
            <button onClick={onResume} className="hover:text-txt-primary transition-colors">
              Resume
            </button>
          )}
          {(transfer.state === 'active' ||
            transfer.state === 'paused' ||
            transfer.state === 'queued') && (
            <button onClick={onAbort} className="hover:text-accent-rose transition-colors">
              Abort
            </button>
          )}
          {(transfer.state === 'completed' ||
            transfer.state === 'failed' ||
            transfer.state === 'aborted') && (
            <button onClick={onDismiss} className="hover:text-txt-primary transition-colors">
              Dismiss
            </button>
          )}
        </span>
      </div>
    </div>
  );
}
