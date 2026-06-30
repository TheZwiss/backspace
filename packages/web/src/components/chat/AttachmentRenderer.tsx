import React, { useState } from 'react';
import type { Attachment } from '@backspace/shared';
import { useUIStore } from '../../stores/uiStore';
import { useTransferStore } from '../../stores/transferStore';
import { Tooltip } from '../ui/Tooltip';

interface AttachmentRendererProps {
  attachment: Attachment;
}

function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1048576) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1048576).toFixed(1)} MB`;
}

/** Format a duration in seconds as `m:ss` (or `h:mm:ss` for long clips). */
function formatDuration(seconds: number): string {
  const total = Math.round(seconds);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (h > 0) return `${h}:${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;
  return `${m}:${s.toString().padStart(2, '0')}`;
}

/**
 * Resolves the displayable URL for an attachment. Same logic used by inline
 * `<img>`/`<video>`/`<audio>` rendering and the file-card download button —
 * exported so right-click menus can use it without duplicating the rule.
 */
export function attUrlOf(filename: string): string {
  if (filename.startsWith('http') || filename.startsWith('/')) return filename;
  return `/api/uploads/${filename}`;
}

interface VideoAttachmentProps {
  attachment: Attachment;
  attUrl: string;
  thumbUrl: string | null;
  federationInlineBadge: React.ReactNode;
}

/**
 * Video attachment with a graceful fallback for formats the browser can't
 * decode. The dominant case is a macOS screen recording (HEVC inside a .mov):
 * the upload succeeds and a server-side poster is generated, but inline
 * `<video>` playback silently fails (stuck at 0:00). We resolve this two ways:
 *
 *   1. Proactive — the server classifies web-playability from the probed codec
 *      (`attachment.playable === false`), so we render the download card
 *      directly with no flash of a dead player.
 *   2. Reactive — for the optimistic/unknown cases, the `<video>` `onError`
 *      handler flips to the same card if playback actually fails at runtime.
 *
 * The fallback card surfaces the poster (still a useful preview), filename,
 * duration and size, and a one-tap download — never a silently broken player.
 */
function VideoAttachment({ attachment, attUrl, thumbUrl, federationInlineBadge }: VideoAttachmentProps) {
  const startDownload = useTransferStore((s) => s.startDownload);
  const [failed, setFailed] = useState(attachment.playable === false);

  const { width, height, originalName, mimetype, size, duration } = attachment;
  const hasDimensions = !!(width && height);
  const sizing = hasDimensions
    ? { aspectRatio: `${width}/${height}`, maxHeight: 300 }
    : undefined;

  if (failed) {
    const meta = [duration ? formatDuration(duration) : null, formatFileSize(size)]
      .filter(Boolean)
      .join(' · ');
    return (
      <div className="mt-1 max-w-[400px]">
        <button
          type="button"
          onClick={() => {
            void startDownload(attUrl, { filename: originalName, size, mimetype, tray: true });
          }}
          className="block w-full text-left rounded-lg overflow-hidden border border-border-hard bg-surface-channel/50 hover:bg-interactive-hover transition-all group/vid"
        >
          {thumbUrl && (
            <div className="relative w-full" style={sizing}>
              <img
                src={thumbUrl}
                alt={originalName}
                className="w-full h-full object-cover"
                loading="lazy"
              />
              <div className="absolute inset-0 bg-black/45 flex flex-col items-center justify-center gap-1.5 text-white">
                <svg className="w-9 h-9" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M12 10v6m0 0l-3-3m3 3l3-3M3 17V7a2 2 0 012-2h6l2 2h6a2 2 0 012 2v8a2 2 0 01-2 2H5a2 2 0 01-2-2z" />
                </svg>
                <span className="text-[12px] font-medium">Can't play here — download</span>
              </div>
            </div>
          )}
          <div className="flex items-center gap-3 p-3">
            {!thumbUrl && (
              <div className="p-2 bg-surface-base rounded text-txt-tertiary flex-shrink-0">
                <svg className="w-6 h-6" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M15 10l4.553-2.276A1 1 0 0121 8.618v6.764a1 1 0 01-1.447.894L15 14M5 18h8a2 2 0 002-2V8a2 2 0 00-2-2H5a2 2 0 00-2 2v8a2 2 0 002 2z" />
                </svg>
              </div>
            )}
            <div className="min-w-0 flex-1">
              <p className="text-txt-link text-[14px] font-medium truncate group-hover/vid:underline">{originalName}</p>
              <p className="text-[12px] text-txt-tertiary">
                {meta ? `${meta} · ` : ''}Unsupported video format
              </p>
            </div>
          </div>
        </button>
        {federationInlineBadge && <div className="mt-1">{federationInlineBadge}</div>}
      </div>
    );
  }

  return (
    <div className="mt-1 max-w-[400px]">
      <div
        className="relative max-h-[300px] rounded-lg overflow-hidden"
        style={sizing}
      >
        <video
          controls
          preload={hasDimensions ? 'none' : 'metadata'}
          poster={thumbUrl ?? undefined}
          src={attUrl}
          onError={() => setFailed(true)}
          className="w-full h-full rounded-lg"
        >
          Your browser does not support video playback.
        </video>
      </div>
      {federationInlineBadge && <div className="mt-1">{federationInlineBadge}</div>}
    </div>
  );
}

export function AttachmentRenderer({ attachment }: AttachmentRendererProps) {
  const openImagePreview = useUIStore((s) => s.openImagePreview);
  const startDownload = useTransferStore((s) => s.startDownload);

  const attUrl = attUrlOf(attachment.filename);

  const thumbUrl = attachment.thumbnailFilename
    ? attachment.thumbnailFilename.startsWith('http') || attachment.thumbnailFilename.startsWith('/')
      ? attachment.thumbnailFilename
      : `/api/uploads/${attachment.thumbnailFilename}`
    : null;

  const { mimetype, originalName, size } = attachment;

  // Federation status — build tooltip text
  const federationTooltip = (() => {
    if (!attachment.federationStatus) return null;

    if (attachment.federationStatus === 'remote') {
      let senderName = 'the sender';
      if (attachment.federationMeta) {
        try {
          const meta = JSON.parse(attachment.federationMeta);
          if (meta.sourceUsername) senderName = meta.sourceUsername;
        } catch { /* ignore */ }
      }
      return { text: `Hosted on ${senderName}'s instance. Download to keep a local copy.`, type: 'remote' as const };
    }

    if (attachment.federationStatus === 'remote_partial') {
      let text = 'Some recipients cannot cache this file locally.';
      if (attachment.federationMeta) {
        try {
          const meta: Array<{ username: string; limit: number }> = JSON.parse(attachment.federationMeta);
          if (meta.length > 0) {
            const parts = meta.map(u => {
              const limitMb = Math.round(u.limit / (1024 * 1024));
              return `${u.username}'s instance (limit: ${limitMb} MB)`;
            });
            text = `File couldn't be cached on ${parts.join(' and ')}. They can still view it from yours.`;
          }
        } catch { /* ignore */ }
      }
      return { text, type: 'remote_partial' as const };
    }

    return null;
  })();

  // Inline badge — sits next to file size or below media, never absolute-positioned
  const federationInlineBadge = federationTooltip ? (
    <Tooltip content={federationTooltip.text} position="top">
      <div className={`inline-flex items-center gap-1 px-1.5 py-0.5 rounded glass-pill text-xs cursor-default ${federationTooltip.type === 'remote' ? 'text-txt-muted' : 'text-accent-amber'}`}>
        <svg className="w-3 h-3 flex-shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          {federationTooltip.type === 'remote'
            ? <path d="M17.5 19H9a7 7 0 1 1 6.71-9h1.79a4.5 4.5 0 1 1 0 9Z" />
            : <><path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" /><line x1="12" y1="9" x2="12" y2="13" /><line x1="12" y1="17" x2="12.01" y2="17" /></>
          }
        </svg>
      </div>
    </Tooltip>
  ) : null;

  if (mimetype.startsWith('image/')) {
    const { width, height } = attachment;
    return (
      <div className="mt-1 max-w-fit">
        <div
          className="relative rounded-lg overflow-hidden border border-white/[0.06]"
          style={width && height ? { aspectRatio: `${width}/${height}`, maxWidth: Math.min(width, 400), maxHeight: 300 } : undefined}
        >
          <img
            src={thumbUrl ?? attUrl}
            alt={originalName}
            className="w-full h-full max-w-[400px] max-h-[300px] object-contain cursor-pointer hover:brightness-95 transition-all"
            onClick={() => openImagePreview(attUrl)}
            loading="lazy"
          />
        </div>
        {federationInlineBadge && <div className="mt-1">{federationInlineBadge}</div>}
      </div>
    );
  }

  if (mimetype.startsWith('video/')) {
    return (
      <VideoAttachment
        attachment={attachment}
        attUrl={attUrl}
        thumbUrl={thumbUrl}
        federationInlineBadge={federationInlineBadge}
      />
    );
  }

  if (mimetype.startsWith('audio/')) {
    return (
      <div className="relative mt-1 flex flex-col p-3 bg-surface-channel/50 rounded-lg border border-border-hard max-w-[420px]">
        <div className="flex items-center gap-3">
          <div className="p-2 bg-surface-base rounded text-txt-tertiary flex-shrink-0">
            <svg className="w-6 h-6" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={1.5}
                d="M9 19V6l12-3v13M9 19c0 1.105-1.343 2-3 2s-3-.895-3-2 1.343-2 3-2 3 .895 3 2zm12-3c0 1.105-1.343 2-3 2s-3-.895-3-2 1.343-2 3-2 3 .895 3 2zM9 10l12-3"
              />
            </svg>
          </div>
          <div className="min-w-0">
            <p className="text-txt-primary text-[14px] font-medium truncate">{originalName}</p>
            <div className="flex items-center gap-2">
              <p className="text-[12px] text-txt-tertiary">{formatFileSize(size)}</p>
              {federationInlineBadge}
            </div>
          </div>
        </div>
        <audio controls preload="metadata" className="w-full mt-2 h-8">
          <source src={attUrl} type={mimetype} />
          Your browser does not support audio playback.
        </audio>
      </div>
    );
  }

  // Generic-file chip (PDF / .zip / .exe / unknown mimetypes).
  //
  // Width contract: the chip must fit inside the message column on every
  // viewport. We cap at 400 px on roomy layouts but `max-w-full` keeps it
  // inside narrow columns (mobile, narrow desktop window, threaded reply
  // contexts). `min-w-0` is the critical bit on the inner flex children — the
  // outer button is a flex container with a fixed-size icon and a flexible
  // text block; without `min-w-0` the long-filename child would refuse to
  // shrink (flex children's min-content size defaults to their intrinsic
  // content) and would push the entire chip past the parent's right edge.
  return (
    <button
      type="button"
      onClick={() => {
        void startDownload(attUrl, {
          filename: originalName,
          size,
          mimetype,
          tray: true,
        });
      }}
      className="mt-1 max-w-full sm:max-w-[400px] flex items-center gap-3 p-4 bg-surface-channel/50 rounded-lg border border-border-hard hover:bg-interactive-hover transition-all group/att text-left w-full min-w-0"
    >
      <div className="p-2 bg-surface-base rounded text-txt-tertiary group-hover/att:text-txt-primary transition-colors flex-shrink-0">
        <svg className="w-8 h-8" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth={1.5}
            d="M12 10v6m0 0l-3-3m3 3l3-3M3 17V7a2 2 0 012-2h6l2 2h6a2 2 0 012 2v8a2 2 0 01-2 2H5a2 2 0 01-2-2z"
          />
        </svg>
      </div>
      <div className="min-w-0 flex-1">
        <p className="text-txt-link text-[15px] font-medium truncate hover:underline">{originalName}</p>
        <div className="flex items-center gap-2 flex-wrap">
          <p className="text-[12px] text-txt-tertiary font-medium">{formatFileSize(size)}</p>
          {federationInlineBadge}
        </div>
      </div>
    </button>
  );
}
