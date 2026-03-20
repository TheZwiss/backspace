import React from 'react';
import type { Attachment } from '@backspace/shared';
import { useUIStore } from '../../stores/uiStore';

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

  if (mimetype.startsWith('image/')) {
    return (
      <div className="max-w-fit mt-1 rounded-lg overflow-hidden border border-white/[0.06]">
        <img
          src={thumbUrl ?? attUrl}
          alt={originalName}
          className="max-w-full max-h-[350px] object-contain cursor-pointer hover:brightness-95 transition-all"
          onClick={() => openImagePreview(attUrl)}
          loading="lazy"
        />
      </div>
    );
  }

  if (mimetype.startsWith('video/')) {
    return (
      <div className="mt-1 max-w-[520px]">
        <video
          controls
          preload="metadata"
          poster={thumbUrl ?? undefined}
          className="max-w-full max-h-[400px] rounded-lg"
        >
          <source src={attUrl} type={mimetype} />
          Your browser does not support video playback.
        </video>
      </div>
    );
  }

  if (mimetype.startsWith('audio/')) {
    return (
      <div className="mt-1 flex flex-col p-3 bg-surface-channel/50 rounded-lg border border-border-hard max-w-[420px]">
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
            <p className="text-[12px] text-txt-tertiary">{formatFileSize(size)}</p>
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
      className="flex items-center gap-3 p-4 bg-surface-channel/50 rounded-lg border border-border-hard hover:bg-interactive-hover transition-all max-w-[400px] mt-1 group/att"
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
        <p className="text-[12px] text-txt-tertiary font-medium">{formatFileSize(size)}</p>
      </div>
    </a>
  );
}
