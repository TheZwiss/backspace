import React, { useState } from 'react';
import type { Embed } from '@backspace/shared';

interface RichEmbedProps {
  embed: Embed;
}

const PROVIDER_HEIGHTS: Record<string, number> = {
  spotify: 152,
};

function getIframeHeight(embed: Embed): number {
  if (embed.height != null) return embed.height;
  if (embed.provider != null) {
    const providerHeight = PROVIDER_HEIGHTS[embed.provider];
    if (providerHeight != null) return providerHeight;
  }
  return 200;
}

export function RichEmbed({ embed }: RichEmbedProps) {
  const [isLoaded, setIsLoaded] = useState(false);
  const iframeHeight = getIframeHeight(embed);

  const providerLabel = embed.provider
    ? embed.provider.charAt(0).toUpperCase() + embed.provider.slice(1)
    : null;

  if (!embed.embedUrl) return null;

  return (
    <div className="mt-2 max-w-[400px] rounded-lg overflow-hidden bg-surface-channel border border-white/[0.06]">
      {isLoaded ? (
        <iframe
          src={embed.embedUrl}
          title={embed.title ?? providerLabel ?? 'Embed'}
          height={iframeHeight}
          className="w-full block"
          allow="autoplay; clipboard-write; encrypted-media; fullscreen; picture-in-picture"
          sandbox="allow-scripts allow-same-origin allow-popups"
          referrerPolicy="no-referrer"
          loading="lazy"
        />
      ) : (
        <button
          type="button"
          onClick={() => setIsLoaded(true)}
          className="w-full text-left focus:outline-none group"
          aria-label={`Load ${providerLabel ?? 'embed'}`}
        >
          <div className="flex items-start gap-3 p-3">
            {embed.image && (
              <div className="w-[80px] h-[80px] flex-shrink-0">
                <img
                  src={embed.image}
                  alt=""
                  className="w-full h-full object-cover rounded"
                  referrerPolicy="no-referrer"
                />
              </div>
            )}
            <div className="flex-1 min-w-0">
              {providerLabel && (
                <div className="text-[12px] text-txt-muted font-medium mb-1">
                  {providerLabel}
                </div>
              )}
              {embed.title && (
                <div className="text-[14px] text-sky-400 font-semibold group-hover:underline line-clamp-2">
                  {embed.title}
                </div>
              )}
              {embed.description && (
                <div className="text-[13px] text-txt-muted mt-1 line-clamp-2">
                  {embed.description}
                </div>
              )}
              <div className="text-[12px] text-txt-muted mt-2 flex items-center gap-1.5">
                <svg viewBox="0 0 24 24" fill="currentColor" className="w-3.5 h-3.5">
                  <path d="M8 5v14l11-7z" />
                </svg>
                Click to load
              </div>
            </div>
          </div>
        </button>
      )}
    </div>
  );
}
