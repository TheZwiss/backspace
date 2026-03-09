import React, { useEffect, useMemo, useRef, useState } from 'react';
import { VoiceUser } from './VoiceUser';
import { StreamTile } from './StreamTile';
import { useVoiceStore } from '../../stores/voiceStore';
import { deriveGridTiles } from '../../hooks/useLiveKit';
import { useGridLayout } from '../../hooks/useGridLayout';
import type { ParticipantInfo, GridTile } from '../../hooks/useLiveKit';

interface VoiceGridProps {
  participants: ParticipantInfo[];
}

export function VoiceGrid({ participants }: VoiceGridProps) {
  const focusedParticipantId = useVoiceStore((s) => s.focusedParticipantId);
  const setFocusedParticipant = useVoiceStore((s) => s.setFocusedParticipant);
  const [stripHidden, setStripHidden] = useState(false);

  const tiles = useMemo(() => deriveGridTiles(participants), [participants]);

  const containerRef = useRef<HTMLDivElement>(null);
  const { cols, tileWidth, tileHeight } = useGridLayout(containerRef, tiles.length);

  // Reset strip visibility when focus target changes
  useEffect(() => {
    setStripHidden(false);
  }, [focusedParticipantId]);

  // Unfocus if the focused stream tile no longer exists
  useEffect(() => {
    const currentStreamKeys = new Set(
      tiles
        .filter(
          (t): t is GridTile & { kind: 'stream' } =>
            t.kind === 'stream' && t.screenTrack?.readyState === 'live',
        )
        .map((t) => t.key),
    );

    if (
      focusedParticipantId &&
      focusedParticipantId.endsWith(':stream') &&
      !currentStreamKeys.has(focusedParticipantId)
    ) {
      setFocusedParticipant(null);
    }
  }, [tiles, focusedParticipantId, setFocusedParticipant]);

  if (tiles.length === 0) {
    return (
      <div className="flex-1 flex items-center justify-center">
        <div className="text-center">
          <svg
            width="48"
            height="48"
            viewBox="0 0 24 24"
            fill="currentColor"
            className="text-txt-tertiary/40 mx-auto mb-3"
          >
            <path d="M11 5L6 9H2V15H6L11 19V5ZM15.54 8.46C16.48 9.4 17 10.67 17 12S16.48 14.6 15.54 15.54L14.12 14.12C14.69 13.55 15 12.79 15 12S14.69 10.45 14.12 9.88L15.54 8.46Z" />
          </svg>
          <p className="text-txt-tertiary text-sm">
            Waiting for others to join...
          </p>
        </div>
      </div>
    );
  }

  const focusedTile = focusedParticipantId
    ? tiles.find((t) => t.key === focusedParticipantId)
    : null;

  // Render a single tile polymorphically
  const renderTile = (tile: GridTile, large?: boolean) =>
    tile.kind === 'user' ? (
      <VoiceUser tile={tile} large={large} />
    ) : (
      <StreamTile tile={tile} large={large} />
    );

  // Focus mode: one large tile + bottom strip
  if (focusedTile) {
    const otherTiles = tiles.filter((t) => t.key !== focusedParticipantId);
    return (
      <div className="flex-1 flex flex-col overflow-hidden relative">
        {/* Main focused view */}
        <div
          className="flex-1 p-2 min-h-0 cursor-pointer relative"
          onClick={() => setFocusedParticipant(null)}
          title="Click to return to grid view"
        >
          {renderTile(focusedTile, true)}
          {/* Grid button — top-right */}
          <button
            onClick={(e) => {
              e.stopPropagation();
              setFocusedParticipant(null);
            }}
            className="absolute top-4 right-4 z-10 px-3 py-1.5 bg-black/60 hover:bg-black/80 rounded-lg flex items-center gap-2 text-white/70 hover:text-white transition-colors"
            title="Back to grid view"
          >
            <svg
              width="16"
              height="16"
              viewBox="0 0 24 24"
              fill="currentColor"
            >
              <path d="M3 3h8v8H3V3zm0 10h8v8H3v-8zm10-10h8v8h-8V3zm0 10h8v8h-8v-8z" />
            </svg>
            <span className="text-xs font-medium">Grid</span>
          </button>
        </div>

        {/* Centered Hide/Show Members button — divider between focused tile and strip */}
        {otherTiles.length > 0 && (
          <div className="flex justify-center flex-shrink-0 py-1">
            <button
              onClick={(e) => {
                e.stopPropagation();
                setStripHidden(!stripHidden);
              }}
              className="px-4 py-1 bg-black/50 hover:bg-black/70 rounded-full flex items-center gap-2 text-white/60 hover:text-white transition-colors text-xs"
              title={stripHidden ? 'Show Members' : 'Hide Members'}
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
                {stripHidden
                  ? <path d="M7 14l5-5 5 5z" />
                  : <path d="M7 10l5 5 5-5z" />
                }
              </svg>
              <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
                <path d="M14 8.00598C14 10.211 12.206 12.006 10 12.006C7.795 12.006 6 10.211 6 8.00598C6 5.80098 7.794 4.00598 10 4.00598C12.206 4.00598 14 5.80098 14 8.00598ZM2 19.006C2 15.473 5.29 13.006 10 13.006C14.711 13.006 18 15.473 18 19.006V20.006H2V19.006ZM20 20.006H22V19.006C22 16.451 20.178 14.471 17.532 13.471C19.461 14.601 20 16.561 20 19.006V20.006Z" />
              </svg>
              <span>{stripHidden ? 'Show Members' : 'Hide Members'}</span>
            </button>
          </div>
        )}

        {/* Bottom strip of other tiles */}
        {!stripHidden && otherTiles.length > 0 && (
          <div className="h-[120px] flex-shrink-0 flex items-center justify-center gap-2 p-2 bg-surface-base/50 overflow-x-auto no-scrollbar">
            {otherTiles.map((t) => (
              <div
                key={t.key}
                onClick={() => setFocusedParticipant(t.key)}
                className="h-full aspect-video flex-shrink-0 cursor-pointer hover:opacity-80 transition-opacity"
              >
                {renderTile(t)}
              </div>
            ))}
          </div>
        )}
      </div>
    );
  }

  // Default grid mode — container-aware layout via ResizeObserver
  return (
    <div ref={containerRef} className="flex-1 overflow-hidden min-h-0">
      <div
        className="grid h-full w-full"
        style={{
          gridTemplateColumns: `repeat(${cols}, ${tileWidth}px)`,
          gridAutoRows: `${tileHeight}px`,
          gap: '8px',
          justifyContent: 'center',
          alignContent: 'center',
        }}
      >
        {tiles.map((t) => (
          <div
            key={t.key}
            onClick={() => setFocusedParticipant(t.key)}
            className="cursor-pointer hover:opacity-90 transition-opacity"
          >
            {renderTile(t)}
          </div>
        ))}
      </div>
    </div>
  );
}
