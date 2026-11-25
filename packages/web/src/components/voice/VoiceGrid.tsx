import React, { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { VoiceUser } from './VoiceUser';
import { StreamTile } from './StreamTile';
import { useVoiceStore } from '../../stores/voiceStore';
import { deriveGridTiles } from '../../hooks/useLiveKit';
import { useGridLayout } from '../../hooks/useGridLayout';
import type { ParticipantInfo, GridTile } from '../../hooks/useLiveKit';
import { useTrackStats } from '../../hooks/useTrackStats';
import { VOICE_CHROME_ATTR } from '../../hooks/usePointerReveal';

interface VoiceGridProps {
  participants: ParticipantInfo[];
  fullscreen?: boolean;
  chromeRevealed?: boolean;
}

export function VoiceGrid({ participants, fullscreen = false, chromeRevealed = true }: VoiceGridProps) {
  const { t } = useTranslation(['voice', 'common']);
  const focusedParticipantId = useVoiceStore((s) => s.focusedParticipantId);
  const setFocusedParticipant = useVoiceStore((s) => s.setFocusedParticipant);
  const watchingStreams = useVoiceStore((s) => s.watchingStreams);
  const unwatchedCameras = useVoiceStore((s) => s.unwatchedCameras);
  const hideNonVideoParticipants = useVoiceStore((s) => s.hideNonVideoParticipants);
  const setHideNonVideoParticipants = useVoiceStore((s) => s.setHideNonVideoParticipants);
  const [stripHidden, setStripHidden] = useState(fullscreen);

  const tiles = useMemo(() => deriveGridTiles(participants), [participants]);
  const visibleTiles = useMemo(() => {
    if (!hideNonVideoParticipants) return tiles;
    return tiles.filter(
      (tile) =>
        tile.kind === 'stream' ||
        (tile.participant.isCameraOn && !unwatchedCameras.has(tile.participant.userId)),
    );
  }, [tiles, hideNonVideoParticipants, unwatchedCameras]);
  const shouldCollectStreamStats = tiles.some((tile) =>
    tile.kind === 'stream'
    && (tile.participant.isLocal || watchingStreams.has(tile.participant.userId)),
  );
  // One WebRTC poller feeds every stream tile. Running useTrackStats inside
  // each tile multiplied full PeerConnection scans by the number of streams.
  const streamStats = useTrackStats(shouldCollectStreamStats);

  const { cols, tileWidth, tileHeight, ref: gridRef } = useGridLayout(visibleTiles.length);

  // Reset strip visibility when focus target or fullscreen mode changes:
  // entering fullscreen defaults to hiding the strip for an unobstructed view;
  // exiting fullscreen restores it.
  useEffect(() => {
    setStripHidden(fullscreen);
  }, [focusedParticipantId, fullscreen]);

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
            {t('voice:grid.waitingForOthers')}
          </p>
        </div>
      </div>
    );
  }

  if (visibleTiles.length === 0) {
    return (
      <div className="flex-1 flex items-center justify-center">
        <div className="text-center space-y-3">
          <p className="text-txt-tertiary text-sm">
            {t('voice:grid.noVideoParticipants')}
          </p>
          <button
            type="button"
            onClick={() => setHideNonVideoParticipants(false)}
            className="px-3.5 py-1.5 rounded-lg bg-surface-elevated hover:bg-interactive-hover text-txt-primary text-xs font-medium transition-colors"
          >
            {t('voice:grid.showAllParticipants')}
          </button>
        </div>
      </div>
    );
  }

  const focusedTile = focusedParticipantId
    ? visibleTiles.find((t) => t.key === focusedParticipantId)
    : null;

  // Render a single tile polymorphically
  const renderTile = (tile: GridTile, opts?: { large?: boolean; edgeToEdge?: boolean; chromeVisible?: boolean }) =>
    tile.kind === 'user' ? (
      <VoiceUser
        tile={tile}
        large={opts?.large}
        edgeToEdge={opts?.edgeToEdge}
        chromeVisible={opts?.chromeVisible}
      />
    ) : (
      <StreamTile
        tile={tile}
        large={opts?.large}
        edgeToEdge={opts?.edgeToEdge}
        chromeVisible={opts?.chromeVisible}
        stats={streamStats}
      />
    );

  // Focus mode: one large tile + bottom strip
  if (focusedTile) {
    const otherTiles = visibleTiles.filter((t) => t.key !== focusedParticipantId);
    const fullscreenChromeFade = chromeRevealed
      ? 'opacity-100'
      : 'opacity-0 pointer-events-none focus-within:opacity-100 focus-within:pointer-events-auto [@media(hover:none)]:opacity-100 [@media(hover:none)]:pointer-events-auto [@media(any-pointer:coarse)]:opacity-100 [@media(any-pointer:coarse)]:pointer-events-auto';
    const membersToggleButton = (
      <button
        onClick={(e) => {
          e.stopPropagation();
          setStripHidden(!stripHidden);
        }}
        className="px-4 py-1 bg-black/60 hover:bg-black/80 rounded-full flex items-center gap-2 text-white/75 hover:text-white transition-colors text-xs backdrop-blur-sm"
        title={stripHidden ? t('voice:grid.showMembers') : t('voice:grid.hideMembers')}
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
        <span>{stripHidden ? t('voice:grid.showMembers') : t('voice:grid.hideMembers')}</span>
      </button>
    );
    return (
      <div className="flex-1 flex flex-col overflow-hidden relative">
        {/* Main focused view */}
        <div
          data-testid="focused-tile-container"
          className={`flex-1 min-h-0 cursor-pointer relative ${fullscreen ? 'p-0 bg-black' : 'p-2'}`}
          onClick={() => setFocusedParticipant(null)}
          title={fullscreen ? undefined : t('voice:grid.returnToGridHint')}
        >
          {renderTile(focusedTile, {
            large: true,
            edgeToEdge: fullscreen,
            chromeVisible: !fullscreen || chromeRevealed,
          })}
          {/* Grid button — top-right; in fullscreen sit below the h-12 voice header overlay so it never collides with revealed header chrome */}
          <button
            onClick={(e) => {
              e.stopPropagation();
              setFocusedParticipant(null);
            }}
            {...(fullscreen ? { [VOICE_CHROME_ATTR]: '' } : {})}
            className={`absolute ${fullscreen ? 'top-14 right-3 z-30' : 'top-4 right-4 z-20'} h-7 px-3 bg-black/60 hover:bg-black/80 rounded-lg flex items-center gap-2 text-white/70 hover:text-white transition-all duration-300 ease-out ${fullscreen ? fullscreenChromeFade : ''}`}
            title={t('voice:grid.backToGrid')}
          >
            <svg
              width="16"
              height="16"
              viewBox="0 0 24 24"
              fill="currentColor"
            >
              <path d="M3 3h8v8H3V3zm0 10h8v8H3v-8zm10-10h8v8h-8V3zm0 10h8v8h-8v-8z" />
            </svg>
            <span className="text-xs font-medium">{t('voice:grid.gridButton')}</span>
          </button>
        </div>

        {/* Single toggle wrapper so the button stays mounted (preserving focus)
            across fullscreen expand/collapse transitions. When collapsed in
            fullscreen it floats above VoiceControlBar and auto-hides with
            chromeRevealed; when expanded (or docked) it sits in normal flex
            flow so the focused video shrinks cleanly above the strip. */}
        {otherTiles.length > 0 && (
          <div
            data-testid={fullscreen && stripHidden ? 'fullscreen-members-overlay' : 'members-toggle-bar'}
            {...(fullscreen && stripHidden ? { [VOICE_CHROME_ATTR]: '' } : {})}
            className={
              fullscreen && stripHidden
                ? `absolute bottom-24 left-1/2 -translate-x-1/2 z-20 transition-opacity duration-300 ease-out ${fullscreenChromeFade}`
                : `flex justify-center flex-shrink-0 py-1 ${fullscreen ? 'bg-black' : ''}`
            }
          >
            {membersToggleButton}
          </div>
        )}

        {/* Reserve the h-24 bottom band owned by the floating VoiceControlBar
            in fullscreen (`mb-24`) so the call controls never overlap or
            intercept clicks on the center thumbnails of the member strip. */}
        {!stripHidden && otherTiles.length > 0 && (
          <div
            data-testid="members-strip"
            className={`h-[120px] max-h-[calc(20*var(--app-vh))] min-h-[80px] flex-shrink-0 flex items-center justify-center gap-2 p-2 overflow-x-auto no-scrollbar ${
              fullscreen ? 'bg-surface-base/90 mb-24' : 'bg-surface-base/50'
            }`}
          >
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
    <div ref={gridRef} className="flex-1 overflow-hidden min-h-0">
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
        {visibleTiles.map((t) => (
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
