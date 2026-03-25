import React from 'react';
import type { Embed } from '@backspace/shared';
import { useUIStore } from '../../../stores/uiStore';

interface ImageEmbedProps {
  embed: Embed;
}

export function ImageEmbed({ embed }: ImageEmbedProps) {
  const openImagePreview = useUIStore((s) => s.openImagePreview);
  const imageUrl = embed.image ?? embed.url;

  const style: React.CSSProperties = embed.width && embed.height
    ? { aspectRatio: `${embed.width}/${embed.height}`, maxWidth: Math.min(embed.width, 400), maxHeight: 300 }
    : { aspectRatio: '4/3', maxWidth: 400, maxHeight: 300 };

  return (
    <div className="mt-2 rounded-lg overflow-hidden bg-surface-input" style={style}>
      <img
        src={imageUrl}
        alt={embed.title ?? ''}
        className="w-full h-full object-contain rounded-lg cursor-pointer hover:opacity-90 transition-opacity"
        loading="lazy"
        referrerPolicy="no-referrer"
        onClick={() => openImagePreview(imageUrl)}
      />
    </div>
  );
}
