import React, { useState, useEffect } from 'react';
import { api } from '../../api/client';

interface EmbedProps {
  url: string;
}

interface Metadata {
  title?: string;
  description?: string;
  image?: string;
  siteName?: string;
}

export function Embed({ url }: EmbedProps) {
  const [metadata, setMetadata] = useState<Metadata | null>(null);
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    let isMounted = true;
    
    // Simple fetch from our new API
    fetch(`/api/utils/metadata?url=${encodeURIComponent(url)}`, {
      headers: {
        'Authorization': `Bearer ${localStorage.getItem('backspace_token')}`
      }
    })
      .then(res => res.json())
      .then(data => {
        if (isMounted && data.title) {
          setMetadata(data);
        }
        setIsLoading(false);
      })
      .catch(() => {
        if (isMounted) setIsLoading(false);
      });

    return () => { isMounted = false; };
  }, [url]);

  if (isLoading || !metadata) return null;

  return (
    <div className="mt-2 max-w-[520px] bg-discord-bg-secondary rounded-[4px] border-l-4 border-discord-bg-tertiary flex overflow-hidden">
      <div className="flex-1 p-3 min-w-0">
        {metadata.siteName && (
          <div className="text-[12px] text-discord-text-normal font-medium mb-1 truncate">
            {metadata.siteName}
          </div>
        )}
        {metadata.title && (
          <a 
            href={url} 
            target="_blank" 
            rel="noopener noreferrer"
            className="text-[16px] text-discord-text-link font-semibold hover:underline block mb-2"
          >
            {metadata.title}
          </a>
        )}
        {metadata.description && (
          <div className="text-[14px] text-discord-text-normal leading-[1.125rem]">
            {metadata.description}
          </div>
        )}
      </div>
      {metadata.image && (
        <div className="w-[80px] h-[80px] m-3 flex-shrink-0">
          <img 
            src={metadata.image} 
            alt="" 
            className="w-full h-full object-cover rounded-[4px]"
          />
        </div>
      )}
    </div>
  );
}
