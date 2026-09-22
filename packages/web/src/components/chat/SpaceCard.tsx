import React, { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { DirectoryEntry } from '@backspace/shared';
import type { TaggedExploreSpace } from '../../stores/exploreStore';
import { LoadingSpinner } from '../ui/LoadingSpinner';
import { getSpaceGradient } from '../../utils/gradients';
import { extractDominantColors, colorsToGradient } from '../../utils/colorExtractor';
import { useSpaceJoin } from '../../hooks/useSpaceJoin';

/** Length cap of the optional message on a join request; the modal and the card share it. */
export const REQUEST_MESSAGE_MAX_LENGTH = 200;

/**
 * The Outer Space variant of the card. When set, the card belongs to an
 * instance the session has no connection to: the origin chip is always shown,
 * the closed-registration badge appears when the instance takes no new
 * accounts, and the single action hands the entry to the connect flow instead
 * of joining through `useSpaceJoin`.
 */
export interface OuterCardProps {
  entry: DirectoryEntry;
  onConnect: (entry: DirectoryEntry) => void;
}

export interface SpaceCardProps {
  space: TaggedExploreSpace;
  onJoinSuccess: (spaceId: string) => void;
  outer?: OuterCardProps;
}

/** The `TaggedExploreSpace` an Outer card renders for a directory entry. */
export function outerEntryToSpace(entry: DirectoryEntry): TaggedExploreSpace {
  return { ...entry, _instanceOrigin: entry.origin, joined: false };
}

export function SpaceCard({
  space,
  onJoinSuccess,
  outer,
}: SpaceCardProps) {
  const { t } = useTranslation(['spaces', 'common']);
  const {
    isJoined,
    isPublic,
    isPending,
    joining,
    joinError,
    showRequestForm,
    requestMessage,
    setRequestMessage,
    openRequestForm,
    cancelRequestForm,
    join,
    sendRequest,
  } = useSpaceJoin(space);

  const [iconGradient, setIconGradient] = useState<string | null>(null);

  const fallbackGradient = getSpaceGradient(space.id, space.name, space.avatarColor).gradient;
  const originLabel = space._instanceOrigin
    ? (() => { try { return new URL(space._instanceOrigin).host; } catch { return space._instanceOrigin; } })()
    : null;

  const iconUrl = space.icon
    ? (space.icon.startsWith('http') || space.icon.startsWith('/') ? space.icon : `/api/uploads/${space.icon}`)
    : null;
  const bannerUrl = space.banner
    ? (space.banner.startsWith('http') || space.banner.startsWith('/') ? space.banner : `/api/uploads/${space.banner}`)
    : null;

  // Extract dominant colors from icon when no banner is set
  useEffect(() => {
    if (bannerUrl || !iconUrl) return;
    let cancelled = false;
    extractDominantColors(iconUrl)
      .then(colors => {
        if (!cancelled && colors.length > 0) setIconGradient(colorsToGradient(colors));
      })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [iconUrl, bannerUrl]);

  const handlePublicJoin = async () => {
    const full = await join();
    if (full) onJoinSuccess(full.id);
  };

  const handleViewSpace = () => {
    onJoinSuccess(space.id);
  };

  const closedToNewAccounts = outer !== undefined && outer.entry.federatedRegistrationOpen === false;

  return (
    <div className={`bg-surface-channel rounded-lg border overflow-hidden flex flex-col transition-colors ${
      isJoined
        ? 'border-accent-mint/20 hover:border-accent-mint/40'
        : 'border-border-soft hover:border-border-hard'
    }`}>
      {/* Banner area */}
      <div className="h-32 relative overflow-hidden">
        {/* Background layer */}
        {bannerUrl ? (
          <img src={bannerUrl} alt="" className="absolute inset-0 w-full h-full object-cover" />
        ) : (
          <div className="absolute inset-0" style={{ background: iconGradient ?? fallbackGradient }} />
        )}

        {/* Frosted bottom fade, Aether Drift glass */}
        <div
          className="absolute bottom-0 inset-x-0 h-16"
          style={{ background: 'linear-gradient(to top, rgba(20,20,26,0.9), transparent)' }}
        />

        {/* Joined badge (top-left) */}
        {isJoined && (
          <div className="absolute top-2 left-2 z-[2]">
            <span className="flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-semibold bg-accent-mint/25 text-accent-mint backdrop-blur-sm">
              <svg width="10" height="10" viewBox="0 0 24 24" fill="currentColor">
                <path d="M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z" />
              </svg>
              {t('spaces:explore.badges.joined')}
            </span>
          </div>
        )}

        {/* Closed-registration badge (top-left, Outer cards only; an Outer card is never joined) */}
        {closedToNewAccounts && (
          <div className="absolute top-2 left-2 z-[2]">
            <span className="flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-semibold bg-accent-rose/20 text-accent-rose backdrop-blur-sm">
              <svg width="10" height="10" viewBox="0 0 24 24" fill="currentColor">
                <path d="M18 8h-1V6c0-2.76-2.24-5-5-5S7 3.24 7 6v2H6c-1.1 0-2 .9-2 2v10c0 1.1.9 2 2 2h12c1.1 0 2-.9 2-2V10c0-1.1-.9-2-2-2zm-6 9c-1.1 0-2-.9-2-2s.9-2 2-2 2 .9 2 2-.9 2-2 2zm3.1-9H8.9V6c0-1.71 1.39-3.1 3.1-3.1 1.71 0 3.1 1.39 3.1 3.1v2z" />
              </svg>
              {t('spaces:explore.outer.closedBadge')}
            </span>
          </div>
        )}

        {/* Visibility badge */}
        <div className="absolute top-2 right-2 z-[2]">
          <span className={`px-2 py-0.5 rounded-full text-[10px] font-semibold uppercase tracking-wider backdrop-blur-sm ${
            isPublic
              ? 'bg-accent-mint/20 text-accent-mint'
              : 'bg-accent-amber/20 text-accent-amber'
          }`}>
            {isPublic ? t('spaces:explore.badges.public') : t('spaces:explore.badges.request')}
          </span>
        </div>

      </div>

      {/* Overlapping icon */}
      <div className="relative px-4 -mt-8 z-10">
        {iconUrl ? (
          <img
            src={iconUrl}
            alt={space.name}
            className="w-14 h-14 rounded-xl object-cover ring-[3px] ring-surface-channel shadow-lg"
          />
        ) : (
          <div
            className="w-14 h-14 rounded-xl ring-[3px] ring-surface-channel shadow-lg flex items-center justify-center text-xl font-bold text-white/90"
            style={{ background: fallbackGradient }}
          >
            {space.name.charAt(0).toUpperCase()}
          </div>
        )}
      </div>

      {/* Content */}
      <div className="px-4 pt-2 pb-4 flex flex-col flex-1">
        <h3 className="text-[15px] font-bold text-txt-primary truncate mb-1">{space.name}</h3>

        {space.description ? (
          <p className="text-[13px] text-txt-secondary line-clamp-2 mb-3 flex-1">
            {space.description}
          </p>
        ) : (
          <p className="text-[13px] text-txt-tertiary italic mb-3 flex-1">{t('spaces:explore.noDescription')}</p>
        )}

        <div className="flex items-center gap-3 text-[12px] text-txt-tertiary mb-3">
          <span className="flex items-center gap-1">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" className="opacity-60">
              <path d="M16 11c1.66 0 2.99-1.34 2.99-3S17.66 5 16 5c-1.66 0-3 1.34-3 3s1.34 3 3 3zm-8 0c1.66 0 2.99-1.34 2.99-3S9.66 5 8 5C6.34 5 5 6.34 5 8s1.34 3 3 3zm0 2c-2.33 0-7 1.17-7 3.5V19h14v-2.5c0-2.33-4.67-3.5-7-3.5zm8 0c-.29 0-.62.02-.97.05 1.16.84 1.97 1.97 1.97 3.45V19h6v-2.5c0-2.33-4.67-3.5-7-3.5z" />
            </svg>
            {t('spaces:explore.memberCount', { count: space.memberCount })}
          </span>
          {originLabel && (
            <span className="flex items-center gap-1 text-txt-tertiary/70">
              <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor" className="opacity-50">
                <path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-1 17.93c-3.95-.49-7-3.85-7-7.93 0-.62.08-1.21.21-1.79L9 15v1c0 1.1.9 2 2 2v1.93zm6.9-2.54c-.26-.81-1-1.39-1.9-1.39h-1v-3c0-.55-.45-1-1-1H8v-2h2c.55 0 1-.45 1-1V7h2c1.1 0 2-.9 2-2v-.41c2.93 1.19 5 4.06 5 7.41 0 2.08-.8 3.97-2.1 5.39z" />
              </svg>
              {originLabel}
            </span>
          )}
        </div>

        {/* Action area */}
        {joinError && !outer && (
          <div className="text-[12px] text-txt-danger mb-2">{joinError}</div>
        )}

        {outer ? (
          isPublic ? (
            <button
              onClick={() => outer.onConnect(outer.entry)}
              className="w-full py-2 bg-accent-primary hover:bg-accent-primary-hover text-white text-sm font-medium rounded transition-colors"
            >
              {t('spaces:explore.outer.connectAndJoin')}
            </button>
          ) : (
            <button
              onClick={() => outer.onConnect(outer.entry)}
              className="w-full py-2 bg-accent-amber/20 hover:bg-accent-amber/30 text-accent-amber text-sm font-medium rounded transition-colors"
            >
              {t('spaces:explore.outer.connectAndRequest')}
            </button>
          )
        ) : isJoined ? (
          <button
            onClick={handleViewSpace}
            className="w-full py-2 bg-accent-mint/15 hover:bg-accent-mint/25 text-accent-mint text-sm font-medium rounded transition-colors"
          >
            {t('spaces:explore.viewSpace')}
          </button>
        ) : isPublic ? (
          <button
            onClick={handlePublicJoin}
            disabled={joining}
            className="w-full py-2 bg-accent-primary hover:bg-accent-primary-hover text-white text-sm font-medium rounded transition-colors disabled:opacity-50"
          >
            {joining ? (
              <span className="flex items-center justify-center gap-2">
                <LoadingSpinner />
                {t('spaces:explore.joining')}
              </span>
            ) : (
              t('spaces:explore.join')
            )}
          </button>
        ) : isPending ? (
          <button
            disabled
            className="w-full py-2 bg-interactive-muted text-txt-tertiary text-sm font-medium rounded cursor-default"
          >
            {t('spaces:explore.requestPending')}
          </button>
        ) : showRequestForm ? (
          <div className="space-y-2">
            <textarea
              value={requestMessage}
              onChange={(e) => setRequestMessage(e.target.value.slice(0, REQUEST_MESSAGE_MAX_LENGTH))}
              placeholder={t('spaces:explore.requestMessagePlaceholder')}
              rows={2}
              className="input-standard w-full resize-none"
            />
            <div className="flex gap-2">
              <button
                onClick={sendRequest}
                disabled={joining}
                className="flex-1 py-1.5 bg-accent-amber hover:bg-accent-amber/80 text-[#13131a] text-sm font-medium rounded transition-colors disabled:opacity-50"
              >
                {joining ? t('spaces:explore.sendingRequest') : t('spaces:explore.sendRequest')}
              </button>
              <button
                onClick={cancelRequestForm}
                className="px-3 py-1.5 text-sm text-txt-tertiary hover:text-txt-secondary transition-colors"
              >
                {t('common:actions.cancel')}
              </button>
            </div>
          </div>
        ) : (
          <button
            onClick={openRequestForm}
            className="w-full py-2 bg-accent-amber/20 hover:bg-accent-amber/30 text-accent-amber text-sm font-medium rounded transition-colors"
          >
            {t('spaces:explore.requestToJoin')}
          </button>
        )}
      </div>
    </div>
  );
}
