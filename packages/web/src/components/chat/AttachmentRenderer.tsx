import React from 'react';
import type { Attachment } from '@backspace/shared';
import { useUIStore } from '../../stores/uiStore';
import { Tooltip } from '../ui/Tooltip';

interface AttachmentRendererProps {
  attachment: Attachment;
}

function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1048576) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1048576).toFixed(1)} MB`;
}

export function AttachmentRenderer({ attachment }: AttachmentRendererProps) {
  const openImagePreview = useUIStore((s) => s.openImagePreview);

  const attUrl =
    attachment.filename.startsWith('http') || attachment.filename.startsWith('/')
      ? attachment.filename
      : `/api/uploads/${attachment.filename}`;

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
    const { width, height } = attachment;
    const hasDimensions = width && height;
    return (
      <div className="mt-1 max-w-[400px]">
        <div
          className="relative max-h-[300px] rounded-lg overflow-hidden"
          style={hasDimensions ? { aspectRatio: `${width}/${height}`, maxHeight: 300 } : undefined}
        >
          <video
            controls
            preload={hasDimensions ? 'none' : 'metadata'}
            poster={thumbUrl ?? undefined}
            className="w-full h-full rounded-lg"
          >
            <source src={attUrl} type={mimetype} />
            Your browser does not support video playback.
          </video>
        </div>
        {federationInlineBadge && <div className="mt-1">{federationInlineBadge}</div>}
      </div>
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

  return (
    <a
      href={attUrl}
      download={originalName}
      className="mt-1 max-w-[400px] flex items-center gap-3 p-4 bg-surface-channel/50 rounded-lg border border-border-hard hover:bg-interactive-hover transition-all group/att"
    >
      <div className="p-2 bg-surface-base rounded text-txt-tertiary group-hover/att:text-txt-primary transition-colors">
        <svg className="w-8 h-8" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth={1.5}
            d="M12 10v6m0 0l-3-3m3 3l3-3M3 17V7a2 2 0 012-2h6l2 2h6a2 2 0 012 2v8a2 2 0 01-2 2H5a2 2 0 01-2-2z"
          />
        </svg>
      </div>
      <div className="min-w-0">
        <p className="text-txt-link text-[15px] font-medium truncate hover:underline">{originalName}</p>
        <div className="flex items-center gap-2">
          <p className="text-[12px] text-txt-tertiary font-medium">{formatFileSize(size)}</p>
          {federationInlineBadge}
        </div>
      </div>
    </a>
  );
}
