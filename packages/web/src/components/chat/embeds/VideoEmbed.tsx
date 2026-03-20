import React, { useState } from 'react';
import type { Embed } from '@backspace/shared';

interface VideoEmbedProps {
  embed: Embed;
}

export function VideoEmbed({ embed }: VideoEmbedProps) {
  const [isPlaying, setIsPlaying] = useState(false);

  // Direct video URL — no provider, no embedUrl
  if (!embed.provider && !embed.embedUrl) {
    return (
      <div className="mt-2 max-w-[520px]">
        <video
          src={embed.url}
          controls
          preload="none"
          className="w-full rounded-lg bg-black"
        />
      </div>
    );
  }

  // Provider iframe (YouTube / Vimeo)
  const providerLabel = embed.provider
    ? embed.provider.charAt(0).toUpperCase() + embed.provider.slice(1)
    : null;

  return (
    <div className="mt-2 max-w-[520px] rounded-lg overflow-hidden bg-surface-channel border border-white/[0.06]">
      {/* 16:9 video area */}
      <div className="relative w-full" style={{ paddingBottom: '56.25%' }}>
        {isPlaying && embed.embedUrl ? (
          <iframe
            className="absolute inset-0 w-full h-full"
            src={`${embed.embedUrl}?autoplay=1`}
            title={embed.title ?? 'Video'}
            allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share"
            allowFullScreen
            referrerPolicy="no-referrer"
          />
        ) : (
          <button
            type="button"
            onClick={() => setIsPlaying(true)}
            className="absolute inset-0 w-full h-full flex items-center justify-center group focus:outline-none"
            aria-label={`Play ${embed.title ?? 'video'}`}
          >
            {embed.image ? (
              <img
                src={embed.image}
                alt=""
                className="absolute inset-0 w-full h-full object-cover"
                referrerPolicy="no-referrer"
              />
            ) : (
              <div className="absolute inset-0 bg-black/60" />
            )}
            {/* Play button — glass-bubble style */}
            <span className="glass-bubble relative z-10 flex items-center justify-center w-14 h-14 rounded-full group-hover:scale-110 transition-transform duration-150">
              <svg
                viewBox="0 0 24 24"
                fill="currentColor"
                className="w-6 h-6 text-white ml-1"
              >
                <path d="M8 5v14l11-7z" />
              </svg>
            </span>
          </button>
        )}
      </div>

      {/* Title / provider footer */}
      {(embed.title || providerLabel) && (
        <div className="px-3 py-2">
          {providerLabel && (
            <div className="text-[12px] text-txt-muted font-medium mb-0.5">
              {providerLabel}
            </div>
          )}
          {embed.title && (
            <a
              href={embed.url}
              target="_blank"
              rel="noopener noreferrer"
              className="text-[14px] text-sky-400 font-semibold hover:underline line-clamp-2"
            >
              {embed.title}
            </a>
          )}
        </div>
      )}
    </div>
  );
}
