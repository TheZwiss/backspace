import React from 'react';
import type { Embed } from '@backspace/shared';
import { GenericEmbed } from './embeds/GenericEmbed';
import { VideoEmbed } from './embeds/VideoEmbed';
import { ImageEmbed } from './embeds/ImageEmbed';
import { RichEmbed } from './embeds/RichEmbed';

interface EmbedRendererProps {
  embed: Embed;
}

export function EmbedRenderer({ embed }: EmbedRendererProps) {
  switch (embed.embedType) {
    case 'video':
      return <VideoEmbed embed={embed} />;

    case 'image':
      return <ImageEmbed embed={embed} />;

    case 'audio':
      return (
        <div className="mt-2 max-w-[400px] bg-surface-channel rounded-[4px] border-l-4 border-border-hard p-3">
          {embed.title && (
            <a
              href={embed.url}
              target="_blank"
              rel="noopener noreferrer"
              className="text-[14px] text-sky-400 font-semibold hover:underline block mb-2 truncate"
            >
              {embed.title}
            </a>
          )}
          <audio
            src={embed.url}
            controls
            preload="metadata"
            className="w-full"
          />
        </div>
      );

    case 'rich':
      return <RichEmbed embed={embed} />;

    case 'generic':
    default:
      return <GenericEmbed embed={embed} />;
  }
}
