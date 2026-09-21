import React, { useEffect, useRef, useState, useCallback, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';
import type { DirectoryEntry } from '@backspace/shared';
import { api } from '../../api/client';
import { useExploreStore } from '../../stores/exploreStore';
import { useDirectoryStore } from '../../stores/directoryStore';
import { useSpaceStore } from '../../stores/spaceStore';
import { useUIStore } from '../../stores/uiStore';
import { LoadingSpinner } from '../ui/LoadingSpinner';
import { Mascot } from '../ui/Mascot';
import { MemberListToggleButton } from '../layout/MemberListToggleButton';
import { useFormatters } from '../../i18n/formatters';
import { SpaceCard } from './SpaceCard';
import { OuterSpaceSection } from './OuterSpaceSection';

/** How long the search box waits after the last keystroke before both sections re-query. */
const SEARCH_DEBOUNCE_MS = 300;

export function ExplorePage() {
  const { t } = useTranslation(['spaces', 'common']);
  const f = useFormatters();
  const navigate = useNavigate();
  const setCurrentSpace = useSpaceStore((s) => s.setCurrentSpace);
  const openModal = useUIStore((s) => s.openModal);

  const spaces = useExploreStore((s) => s.spaces);
  const isLoading = useExploreStore((s) => s.isLoading);
  const discoveryEnabled = useExploreStore((s) => s.discoveryEnabled);
  const error = useExploreStore((s) => s.error);
  const searchQuery = useExploreStore((s) => s.searchQuery);
  const setSearchQuery = useExploreStore((s) => s.setSearchQuery);
  const fetchSpaces = useExploreStore((s) => s.fetchSpaces);
  const fetchMyRequests = useExploreStore((s) => s.fetchMyRequests);
  const fetchDirectory = useDirectoryStore((s) => s.fetch);

  const [joinedCollapsed, setJoinedCollapsed] = useState(false);

  // Whether the home instance is connected to a directory. Read once from the
  // public instance info so an instance with the directory off never flashes
  // the Outer Space header; the store's own status starts idle and cannot
  // answer this before its first fetch.
  const [directoryEnabled, setDirectoryEnabled] = useState(false);

  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Fetch on mount
  useEffect(() => {
    fetchSpaces();
    fetchMyRequests();
  }, [fetchSpaces, fetchMyRequests]);

  useEffect(() => {
    let cancelled = false;
    api.instance.info()
      .then((info) => { if (!cancelled) setDirectoryEnabled(info.directoryEnabled); })
      .catch(() => {
        // Unreachable or an older server without the flag: the section stays absent.
      });
    return () => { cancelled = true; };
  }, []);

  // Debounced search, one timer for both sections. The directory is only
  // queried on an instance that has one; with it off the section is absent
  // and nothing should hit the proxy.
  const handleSearchChange = useCallback((value: string) => {
    setSearchQuery(value);
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => {
      fetchSpaces(value || undefined);
      if (directoryEnabled) fetchDirectory(value);
    }, SEARCH_DEBOUNCE_MS);
  }, [setSearchQuery, fetchSpaces, fetchDirectory, directoryEnabled]);

  useEffect(() => {
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, []);

  const handleJoinSuccess = (spaceId: string) => {
    setCurrentSpace(spaceId);
    navigate(`/channels/${spaceId}`);
  };

  const handleConnect = useCallback((entry: DirectoryEntry) => {
    openModal('connectAndJoin', { entry });
  }, [openModal]);

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
          <span className="font-bold text-txt-primary">{t('spaces:explore.title')}</span>
        </div>

        <div className="w-[1px] h-6 bg-surface-elevated mx-2" />

        <div className="relative flex-1 max-w-xs ml-2">
          <input
            type="text"
            placeholder={t('spaces:explore.searchPlaceholder')}
            value={searchQuery}
            onChange={(e) => handleSearchChange(e.target.value)}
            className="input-search w-full"
          />
          {searchQuery && (
            <button
              onClick={() => handleSearchChange('')}
              className="absolute right-2 top-1/2 -translate-y-1/2 text-txt-tertiary hover:text-txt-secondary"
              aria-label={t('common:actions.clear')}
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

      {/* Content: Inner Space on top, Outer Space below it, in that order whatever either holds */}
      <div className="flex-1 overflow-y-auto">
        <div className="p-6 space-y-10">
          {/* Inner Space: the home instance and every connected instance */}
          <section>
            <div className="mb-3">
              <span className="text-xs font-semibold uppercase tracking-wider text-txt-tertiary">
                {t('spaces:explore.inner.title')}
              </span>
              <p className="text-[13px] text-txt-tertiary">{t('spaces:explore.inner.subtitle')}</p>
            </div>

            {!discoveryEnabled && (
              <div className="mb-4 p-2.5 bg-accent-amber/10 border border-accent-amber/30 rounded text-[13px] text-accent-amber">
                {t('spaces:explore.discoveryDisabled')}
              </div>
            )}

            {isLoading && spaces.length === 0 ? (
              <div className="flex items-center justify-center h-64">
                <LoadingSpinner />
              </div>
            ) : error ? (
              <div className="p-3 bg-accent-rose/10 border border-accent-rose/30 rounded text-sm text-txt-danger">
                {error}
              </div>
            ) : !hasAnySpaces ? (
              /* True empty state: no discoverable Inner spaces at all. Outer Space still renders below. */
              <div className="flex flex-col items-center justify-center h-64 opacity-80">
                <Mascot state="lonely" className="w-32 h-32 mb-3" />
                <p className="text-txt-tertiary text-sm">
                  {searchQuery
                    ? t('spaces:explore.noMatches')
                    : t('spaces:explore.empty')}
                </p>
              </div>
            ) : (
              <div className="space-y-6">
                {/* All-joined success banner (only when no unjoined spaces remain) */}
                {!hasUnjoined && hasJoined && !searchQuery && (
                  <div className="flex items-center gap-2.5 px-4 py-2.5 bg-accent-mint/10 border border-accent-mint/20 rounded-lg">
                    <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor" className="text-accent-mint flex-shrink-0">
                      <path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-2 15l-5-5 1.41-1.41L10 14.17l7.59-7.59L19 8l-9 9z" />
                    </svg>
                    <span className="text-[13px] text-accent-mint">
                      {t('spaces:explore.allJoined')}
                    </span>
                  </div>
                )}

                {/* Unjoined spaces grid */}
                {hasUnjoined && (
                  <div className="grid grid-cols-1 desktop:grid-cols-[repeat(auto-fit,minmax(min(100%,280px),1fr))] gap-4">
                    {unjoinedSpaces.map((space) => (
                      <SpaceCard
                        key={`${space.id}:${space._instanceOrigin}`}
                        space={space}
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
                        {t('spaces:explore.joinedSection')}
                      </span>
                      <span className="text-xs text-txt-tertiary/60">
                        {f.formatNumber(joinedSpaces.length)}
                      </span>
                    </button>

                    {!joinedCollapsed && (
                      <div className="grid grid-cols-1 desktop:grid-cols-[repeat(auto-fit,minmax(min(100%,280px),1fr))] gap-4">
                        {joinedSpaces.map((space) => (
                          <SpaceCard
                            key={`${space.id}:${space._instanceOrigin}`}
                            space={space}
                            onJoinSuccess={handleJoinSuccess}
                          />
                        ))}
                      </div>
                    )}
                  </div>
                )}
              </div>
            )}
          </section>

          {/* Outer Space: the directory, only on an instance that is connected to one */}
          {directoryEnabled && (
            <OuterSpaceSection query={searchQuery} onConnect={handleConnect} />
          )}
        </div>
      </div>
    </div>
  );
}
