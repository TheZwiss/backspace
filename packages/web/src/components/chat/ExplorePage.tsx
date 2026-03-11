import React, { useEffect, useRef, useState, useCallback, useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import { useExploreStore, type TaggedExploreSpace } from '../../stores/exploreStore';
import { useSpaceStore } from '../../stores/spaceStore';
import { LoadingSpinner } from '../ui/LoadingSpinner';
import { getSpaceGradient } from '../../utils/gradients';
import { extractDominantColors, colorsToGradient } from '../../utils/colorExtractor';
import { MemberListToggleButton } from '../layout/MemberListToggleButton';

export function ExplorePage() {
  const navigate = useNavigate();
  const setCurrentSpace = useSpaceStore((s) => s.setCurrentSpace);

  const spaces = useExploreStore((s) => s.spaces);
  const myRequests = useExploreStore((s) => s.myRequests);
  const isLoading = useExploreStore((s) => s.isLoading);
  const discoveryEnabled = useExploreStore((s) => s.discoveryEnabled);
  const error = useExploreStore((s) => s.error);
  const searchQuery = useExploreStore((s) => s.searchQuery);
  const setSearchQuery = useExploreStore((s) => s.setSearchQuery);
  const fetchSpaces = useExploreStore((s) => s.fetchSpaces);
  const fetchMyRequests = useExploreStore((s) => s.fetchMyRequests);

  const [joinedCollapsed, setJoinedCollapsed] = useState(false);

  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Fetch on mount
  useEffect(() => {
    fetchSpaces();
    fetchMyRequests();
  }, [fetchSpaces, fetchMyRequests]);

  // Debounced search
  const handleSearchChange = useCallback((value: string) => {
    setSearchQuery(value);
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => {
      fetchSpaces(value || undefined);
    }, 300);
  }, [setSearchQuery, fetchSpaces]);

  useEffect(() => {
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, []);

  const handleJoinSuccess = (spaceId: string) => {
    setCurrentSpace(spaceId);
    navigate(`/channels/${spaceId}`);
  };

  const unjoinedSpaces = useMemo(
    () => spaces.filter(s => !s.joined),
    [spaces],
  );
  const joinedSpaces = useMemo(
    () => spaces.filter(s => s.joined),
    [spaces],
  );

  const hasAnySpaces = spaces.length > 0;
  const hasUnjoined = unjoinedSpaces.length > 0;
  const hasJoined = joinedSpaces.length > 0;

  return (
    <div className="flex-1 flex flex-col bg-surface-chat h-full">
      {/* Header */}
      <div className="h-12 px-4 flex items-center shadow-header flex-shrink-0 z-10 bg-surface-chat">
        <div className="flex items-center gap-2 mr-4">
          <svg width="24" height="24" viewBox="0 0 24 24" fill="currentColor" className="text-txt-tertiary">
            <path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm0 18c-4.41 0-8-3.59-8-8s3.59-8 8-8 8 3.59 8 8-3.59 8-8 8zm-5.5-2.5l7.51-3.49L17.5 6.5 9.99 9.99 6.5 17.5zm5.5-6.6c.61 0 1.1.49 1.1 1.1s-.49 1.1-1.1 1.1-1.1-.49-1.1-1.1.49-1.1 1.1-1.1z" />
          </svg>
          <span className="font-bold text-txt-primary">Explore</span>
        </div>

        <div className="w-[1px] h-6 bg-surface-elevated mx-2" />

        <div className="relative flex-1 max-w-xs ml-2">
          <input
            type="text"
            placeholder="Search spaces..."
            value={searchQuery}
            onChange={(e) => handleSearchChange(e.target.value)}
            className="w-full bg-surface-base text-txt-primary text-sm px-3 py-1.5 rounded-[4px] outline-none placeholder:text-txt-tertiary/50 focus:ring-1 focus:ring-accent-primary transition-all"
          />
          {searchQuery && (
            <button
              onClick={() => handleSearchChange('')}
              className="absolute right-2 top-1/2 -translate-y-1/2 text-txt-tertiary hover:text-txt-secondary"
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
                <path d="M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z" />
              </svg>
            </button>
          )}
        </div>

        <div className="ml-auto flex items-center gap-1">
          <MemberListToggleButton />
        </div>
      </div>

      {/* Content */}
      <div className="flex-1 overflow-y-auto">
        {!discoveryEnabled && (
          <div className="mx-6 mt-4 p-2.5 bg-accent-amber/10 border border-accent-amber/30 rounded text-[13px] text-accent-amber">
            Space discovery is disabled by the instance administrator.
          </div>
        )}

        {isLoading && spaces.length === 0 ? (
          <div className="flex-1 flex items-center justify-center h-64">
            <LoadingSpinner />
          </div>
        ) : error ? (
          <div className="mx-6 mt-4 p-3 bg-accent-rose/10 border border-accent-rose/30 rounded text-sm text-txt-danger">
            {error}
          </div>
        ) : !hasAnySpaces ? (
          /* True empty state — no discoverable spaces at all */
          <div className="flex flex-col items-center justify-center h-64 opacity-60">
            <svg width="48" height="48" viewBox="0 0 24 24" fill="currentColor" className="text-txt-tertiary mb-3">
              <path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm0 18c-4.41 0-8-3.59-8-8s3.59-8 8-8 8 3.59 8 8-3.59 8-8 8zm-5.5-2.5l7.51-3.49L17.5 6.5 9.99 9.99 6.5 17.5zm5.5-6.6c.61 0 1.1.49 1.1 1.1s-.49 1.1-1.1 1.1-1.1-.49-1.1-1.1.49-1.1 1.1-1.1z" />
            </svg>
            <p className="text-txt-tertiary text-sm">
              {searchQuery
                ? 'No spaces match your search.'
                : 'No spaces have been made discoverable yet.'}
            </p>
          </div>
        ) : (
          <div className="p-6 space-y-6">
            {/* All-joined success banner (only when no unjoined spaces remain) */}
            {!hasUnjoined && hasJoined && !searchQuery && (
              <div className="flex items-center gap-2.5 px-4 py-2.5 bg-accent-mint/10 border border-accent-mint/20 rounded-lg">
                <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor" className="text-accent-mint flex-shrink-0">
                  <path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-2 15l-5-5 1.41-1.41L10 14.17l7.59-7.59L19 8l-9 9z" />
                </svg>
                <span className="text-[13px] text-accent-mint">
                  You're in all discoverable spaces
                </span>
              </div>
            )}

            {/* Unjoined spaces grid */}
            {hasUnjoined && (
              <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
                {unjoinedSpaces.map((space) => (
                  <SpaceCard
                    key={`${space.id}:${space._instanceOrigin}`}
                    space={space}
                    isPending={myRequests.some(r => r.spaceId === space.id && r.status === 'pending')}
                    onJoinSuccess={handleJoinSuccess}
                  />
                ))}
              </div>
            )}

            {/* Joined spaces section */}
            {hasJoined && (
              <div>
                <button
                  onClick={() => setJoinedCollapsed(!joinedCollapsed)}
                  className="flex items-center gap-2 mb-3 group"
                >
                  <svg
                    width="12"
                    height="12"
                    viewBox="0 0 24 24"
                    fill="currentColor"
                    className={`text-txt-tertiary transition-transform ${joinedCollapsed ? '-rotate-90' : ''}`}
                  >
                    <path d="M7 10l5 5 5-5z" />
                  </svg>
                  <span className="text-xs font-semibold uppercase tracking-wider text-txt-tertiary group-hover:text-txt-secondary transition-colors">
                    Joined
                  </span>
                  <span className="text-xs text-txt-tertiary/60">
                    {joinedSpaces.length}
                  </span>
                </button>

                {!joinedCollapsed && (
                  <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
                    {joinedSpaces.map((space) => (
                      <SpaceCard
                        key={`${space.id}:${space._instanceOrigin}`}
                        space={space}
                        isPending={false}
                        onJoinSuccess={handleJoinSuccess}
                      />
                    ))}
                  </div>
                )}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

function SpaceCard({
  space,
  isPending,
  onJoinSuccess,
}: {
  space: TaggedExploreSpace;
  isPending: boolean;
  onJoinSuccess: (spaceId: string) => void;
}) {
  const publicJoin = useExploreStore((s) => s.publicJoin);
  const requestJoin = useExploreStore((s) => s.requestJoin);

  const [joining, setJoining] = useState(false);
  const [showRequestForm, setShowRequestForm] = useState(false);
  const [requestMessage, setRequestMessage] = useState('');
  const [requestSent, setRequestSent] = useState(isPending);
  const [joinError, setJoinError] = useState('');
  const [iconGradient, setIconGradient] = useState<string | null>(null);

  const fallbackGradient = getSpaceGradient(space.id, space.name, space.avatarColor).gradient;
  const isPublic = space.visibility === 'public';
  const isJoined = space.joined === true;
  const originLabel = space._instanceOrigin
    ? (() => { try { return new URL(space._instanceOrigin).host; } catch { return space._instanceOrigin; } })()
    : null;

  const iconUrl = space.icon
    ? (space.icon.startsWith('http') ? space.icon : `/api/uploads/${space.icon}`)
    : null;
  const bannerUrl = space.banner
    ? (space.banner.startsWith('http') ? space.banner : `/api/uploads/${space.banner}`)
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
    setJoining(true);
    setJoinError('');
    try {
      const fullSpace = await publicJoin(space);
      onJoinSuccess(fullSpace.id);
    } catch (err) {
      setJoinError(err instanceof Error ? err.message : 'Failed to join');
      setJoining(false);
    }
  };

  const handleRequestJoin = async () => {
    setJoining(true);
    setJoinError('');
    try {
      await requestJoin(space, requestMessage.trim() || undefined);
      setRequestSent(true);
      setShowRequestForm(false);
    } catch (err) {
      setJoinError(err instanceof Error ? err.message : 'Failed to send request');
    } finally {
      setJoining(false);
    }
  };

  const handleViewSpace = () => {
    onJoinSuccess(space.id);
  };

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

        {/* Frosted bottom fade — Aether Drift glass */}
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
              Joined
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
            {isPublic ? 'Public' : 'Request'}
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
          <p className="text-[13px] text-txt-tertiary italic mb-3 flex-1">No description</p>
        )}

        <div className="flex items-center gap-3 text-[12px] text-txt-tertiary mb-3">
          <span className="flex items-center gap-1">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" className="opacity-60">
              <path d="M16 11c1.66 0 2.99-1.34 2.99-3S17.66 5 16 5c-1.66 0-3 1.34-3 3s1.34 3 3 3zm-8 0c1.66 0 2.99-1.34 2.99-3S9.66 5 8 5C6.34 5 5 6.34 5 8s1.34 3 3 3zm0 2c-2.33 0-7 1.17-7 3.5V19h14v-2.5c0-2.33-4.67-3.5-7-3.5zm8 0c-.29 0-.62.02-.97.05 1.16.84 1.97 1.97 1.97 3.45V19h6v-2.5c0-2.33-4.67-3.5-7-3.5z" />
            </svg>
            {space.memberCount} {space.memberCount === 1 ? 'member' : 'members'}
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
        {joinError && (
          <div className="text-[12px] text-txt-danger mb-2">{joinError}</div>
        )}

        {isJoined ? (
          <button
            onClick={handleViewSpace}
            className="w-full py-2 bg-accent-mint/15 hover:bg-accent-mint/25 text-accent-mint text-sm font-medium rounded transition-colors"
          >
            View Space
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
                Joining...
              </span>
            ) : (
              'Join Space'
            )}
          </button>
        ) : requestSent ? (
          <button
            disabled
            className="w-full py-2 bg-interactive-muted text-txt-tertiary text-sm font-medium rounded cursor-default"
          >
            Request Pending
          </button>
        ) : showRequestForm ? (
          <div className="space-y-2">
            <textarea
              value={requestMessage}
              onChange={(e) => setRequestMessage(e.target.value.slice(0, 200))}
              placeholder="Why do you want to join? (optional)"
              rows={2}
              className="w-full px-3 py-2 bg-surface-input rounded text-sm text-txt-primary outline-none focus:ring-1 focus:ring-accent-primary resize-none placeholder:text-txt-tertiary"
            />
            <div className="flex gap-2">
              <button
                onClick={handleRequestJoin}
                disabled={joining}
                className="flex-1 py-1.5 bg-accent-amber hover:bg-accent-amber/80 text-[#13131a] text-sm font-medium rounded transition-colors disabled:opacity-50"
              >
                {joining ? 'Sending...' : 'Send Request'}
              </button>
              <button
                onClick={() => setShowRequestForm(false)}
                className="px-3 py-1.5 text-sm text-txt-tertiary hover:text-txt-secondary transition-colors"
              >
                Cancel
              </button>
            </div>
          </div>
        ) : (
          <button
            onClick={() => setShowRequestForm(true)}
            className="w-full py-2 bg-accent-amber/20 hover:bg-accent-amber/30 text-accent-amber text-sm font-medium rounded transition-colors"
          >
            Request to Join
          </button>
        )}
      </div>
    </div>
  );
}
