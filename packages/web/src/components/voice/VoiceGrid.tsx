import React, { useEffect, useRef, useMemo } from 'react';
import { VoiceUser } from './VoiceUser';
import { StreamTile } from './StreamTile';
import { useVoiceStore } from '../../stores/voiceStore';
import { deriveGridTiles } from '../../hooks/useLiveKit';
import type { ParticipantInfo, GridTile } from '../../hooks/useLiveKit';

interface VoiceGridProps {
  participants: ParticipantInfo[];
}

export function VoiceGrid({ participants }: VoiceGridProps) {
  const focusedParticipantId = useVoiceStore((s) => s.focusedParticipantId);
  const setFocusedParticipant = useVoiceStore((s) => s.setFocusedParticipant);
  const prevStreamKeysRef = useRef<Set<string>>(new Set());

  const tiles = useMemo(() => deriveGridTiles(participants), [participants]);

  // Auto-focus when a new stream tile appears
  useEffect(() => {
    const currentStreamKeys = new Set(
      tiles
        .filter(
          (t): t is GridTile & { kind: 'stream' } =>
            t.kind === 'stream' && t.screenTrack?.readyState === 'live',
        )
        .map((t) => t.key),
    );

    // Find newly appeared stream keys
    for (const key of currentStreamKeys) {
      if (!prevStreamKeysRef.current.has(key)) {
        // New stream tile — auto-focus it
        setFocusedParticipant(key);
        break;
      }
    }

    // If the focused tile was a stream tile that no longer exists, unfocus
    if (
      focusedParticipantId &&
      focusedParticipantId.endsWith(':stream') &&
      !currentStreamKeys.has(focusedParticipantId)
    ) {
      setFocusedParticipant(null);
    }

    prevStreamKeysRef.current = currentStreamKeys;
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
            className="text-discord-text-muted/40 mx-auto mb-3"
          >
            <path d="M11 5L6 9H2V15H6L11 19V5ZM15.54 8.46C16.48 9.4 17 10.67 17 12S16.48 14.6 15.54 15.54L14.12 14.12C14.69 13.55 15 12.79 15 12S14.69 10.45 14.12 9.88L15.54 8.46Z" />
          </svg>
          <p className="text-discord-text-muted text-sm">
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
          className="flex-1 p-2 min-h-0 cursor-pointer"
          onClick={() => setFocusedParticipant(null)}
          title="Click to return to grid view"
        >
          {renderTile(focusedTile, true)}
          {/* Back to grid button */}
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

        {/* Bottom strip of other tiles */}
        {otherTiles.length > 0 && (
          <div className="h-[120px] flex-shrink-0 flex items-center justify-center gap-2 p-2 bg-[#111214]/50 overflow-x-auto no-scrollbar">
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

  // Default grid mode
  const gridClass = (() => {
    if (tiles.length === 1) return 'grid-cols-1 max-w-2xl mx-auto';
    if (tiles.length === 2) return 'grid-cols-2 max-w-4xl mx-auto';
    if (tiles.length <= 4) return 'grid-cols-2';
    if (tiles.length <= 9) return 'grid-cols-3';
    return 'grid-cols-4';
  })();

  return (
    <div className="flex-1 p-3 overflow-auto flex items-center min-h-0">
      <div className={`grid ${gridClass} gap-2 w-full max-h-full`}>
        {tiles.map((t) => (
          <div
            key={t.key}
            onClick={() => setFocusedParticipant(t.key)}
            className="cursor-pointer hover:opacity-90 transition-opacity h-full"
          >
            {renderTile(t)}
          </div>
        ))}
      </div>
    </div>
  );
}
