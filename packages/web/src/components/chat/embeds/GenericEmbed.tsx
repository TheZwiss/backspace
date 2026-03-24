import React from 'react';
import type { Embed } from '@backspace/shared';

interface GenericEmbedProps {
  embed: Embed;
}

function hostnameFromUrl(url: string): string | null {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return null;
  }
}

export function GenericEmbed({ embed }: GenericEmbedProps) {
  if (!embed.title) return null;

  const providerName = embed.provider ?? hostnameFromUrl(embed.url);

  return (
    <div className="mt-2 max-w-[400px] bg-surface-channel rounded-[4px] border-l-4 border-border-hard flex overflow-hidden">
      <div className="flex-1 p-3 min-w-0">
        {providerName && (
          <div className="text-[12px] text-txt-muted font-medium mb-1 truncate">
            {providerName}
          </div>
        )}
        <a
          href={embed.url}
          target="_blank"
          rel="noopener noreferrer"
          className="text-[16px] text-sky-400 font-semibold hover:underline block mb-2 truncate"
        >
          {embed.title}
        </a>
        {embed.description && (
          <div className="text-[14px] text-txt-message leading-[1.125rem] line-clamp-3">
            {embed.description}
          </div>
        )}
      </div>
      {embed.image && (
        <div className="w-[80px] h-[80px] m-3 flex-shrink-0">
          <img
            src={embed.image}
            alt=""
            className="w-full h-full object-cover rounded-[4px]"
            referrerPolicy="no-referrer"
          />
        </div>
      )}
    </div>
  );
}
