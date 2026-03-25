import React from 'react';
import type { Embed } from '@backspace/shared';
import { useUIStore } from '../../../stores/uiStore';

interface ImageEmbedProps {
  embed: Embed;
}

export function ImageEmbed({ embed }: ImageEmbedProps) {
  const openImagePreview = useUIStore((s) => s.openImagePreview);
  const imageUrl = embed.image ?? embed.url;

  return (
    <div className="mt-2 max-w-[400px]">
      <img
        src={imageUrl}
        alt={embed.title ?? ''}
        className="max-w-full max-h-[300px] rounded-lg cursor-pointer hover:opacity-90 transition-opacity"
        loading="lazy"
        referrerPolicy="no-referrer"
        onClick={() => openImagePreview(imageUrl)}
      />
    </div>
  );
}
