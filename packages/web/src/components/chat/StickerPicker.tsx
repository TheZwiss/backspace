import React, { useState, useEffect, useCallback, useRef } from 'react';
import { api } from '../../api/client';
import type { Sticker, StickerPack } from '@backspace/shared';

interface StickerPickerProps {
  onStickerSelect: (sticker: Sticker) => void;
}

interface StickerCache {
  packs: StickerPack[];
  fetchedAt: number;
}

let stickerCache: StickerCache | null = null;
const CACHE_TTL = 60_000; // 60s

export function StickerPicker({ onStickerSelect }: StickerPickerProps) {
  const [packs, setPacks] = useState<StickerPack[]>(stickerCache?.packs ?? []);
  const [loading, setLoading] = useState(!stickerCache || Date.now() - stickerCache.fetchedAt > CACHE_TTL);
  const [query, setQuery] = useState('');
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (stickerCache && Date.now() - stickerCache.fetchedAt <= CACHE_TTL) {
      setPacks(stickerCache.packs);
      setLoading(false);
      return;
    }

    let cancelled = false;
    setLoading(true);
    api.stickers.myStickers()
      .then((data) => {
        if (cancelled) return;
        stickerCache = { packs: data.packs, fetchedAt: Date.now() };
        setPacks(data.packs);
        setLoading(false);
      })
      .catch(() => {
        if (!cancelled) setLoading(false);
      });
    return () => { cancelled = true; };
  }, []);

  const filteredPacks = query.trim()
    ? packs
        .map((pack) => ({
          ...pack,
          stickers: pack.stickers.filter(
            (s) =>
              s.name.toLowerCase().includes(query.toLowerCase()) ||
              s.tags.toLowerCase().includes(query.toLowerCase()),
          ),
        }))
        .filter((pack) => pack.stickers.length > 0)
    : packs;

  const totalStickers = packs.reduce((sum, p) => sum + p.stickers.length, 0);

  // Prevent keyboard events from bubbling
  const handleKeyDown = (e: React.KeyboardEvent) => {
    e.stopPropagation();
  };

  const getStickerUrl = useCallback((sticker: Sticker) => {
    const filename = sticker.filename;
    if (filename.startsWith('http') || filename.startsWith('/')) return filename;
    return `/api/uploads/${filename}`;
  }, []);

  return (
    <div className="flex flex-col h-[390px]" onKeyDown={handleKeyDown}>
      {/* Search */}
      <div className="px-3 pt-2 pb-1.5">
        <input
          type="text"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search stickers"
          className="input-search w-full"
          autoFocus
        />
      </div>

      {/* Results */}
      <div ref={scrollRef} className="flex-1 overflow-y-auto scrollbar-thin px-2 pb-2">
        {loading ? (
          <div className="grid grid-cols-4 gap-2 p-1">
            {Array.from({ length: 8 }).map((_, i) => (
              <div key={i} className="aspect-square bg-surface-elevated rounded-lg animate-pulse" />
            ))}
          </div>
        ) : totalStickers === 0 ? (
          <div className="flex flex-col items-center justify-center h-full text-center px-4">
            <div className="text-txt-tertiary text-sm mb-1">No stickers available</div>
            <div className="text-txt-tertiary text-xs">
              Space admins can add sticker packs in Space Settings.
            </div>
          </div>
        ) : filteredPacks.length === 0 ? (
          <div className="flex items-center justify-center h-full text-txt-tertiary text-sm">
            No stickers matching "{query}"
          </div>
        ) : (
          <div className="space-y-3">
            {filteredPacks.map((pack) => (
              <div key={pack.id}>
                <div className="text-[11px] font-semibold text-txt-tertiary uppercase tracking-wider px-1 mb-1.5">
                  {pack.name}
                </div>
                <div className="grid grid-cols-4 gap-1.5">
                  {pack.stickers.map((sticker) => (
                    <button
                      key={sticker.id}
                      onClick={() => onStickerSelect(sticker)}
                      className="aspect-square rounded-lg overflow-hidden hover:bg-interactive-hover transition-colors p-1.5 group"
                      title={sticker.name}
                    >
                      <img
                        src={getStickerUrl(sticker)}
                        alt={sticker.name}
                        className="w-full h-full object-contain group-hover:scale-110 transition-transform"
                        loading="lazy"
                      />
                    </button>
                  ))}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

/** Invalidate the sticker cache (called when WS events indicate sticker changes) */
export function invalidateStickerCache(): void {
  stickerCache = null;
}
