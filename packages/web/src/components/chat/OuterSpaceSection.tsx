import React, { useEffect, useMemo, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import type { DirectoryEntry } from '@backspace/shared';
import { useDirectoryStore } from '../../stores/directoryStore';
import { useInstanceStore } from '../../stores/instanceStore';
import { dedupeAgainstConnected } from '../../utils/directory';
import { LoadingSpinner } from '../ui/LoadingSpinner';
import { Mascot } from '../ui/Mascot';
import { SpaceCard, outerEntryToSpace } from './SpaceCard';

interface OuterSpaceSectionProps {
  /** The page's search query; the section fetches it on mount, the page re-fetches on change. */
  query: string;
  onConnect: (entry: DirectoryEntry) => void;
}

/**
 * The directory half of the Explore page: spaces on instances the session is
 * not connected to. The page gates it on the home instance's
 * `directoryAvailable` flag (an endpoint is configured), not on the admin's
 * listing opt-in; the section itself renders the store's states and nothing
 * else.
 */
export function OuterSpaceSection({ query, onConnect }: OuterSpaceSectionProps) {
  const { t } = useTranslation(['spaces', 'errors']);
  const feed = useDirectoryStore((s) => s.entries);
  const instances = useInstanceStore((s) => s.instances);
  const status = useDirectoryStore((s) => s.status);
  const hasMore = useDirectoryStore((s) => s.hasMore);
  const fetch = useDirectoryStore((s) => s.fetch);
  const loadMore = useDirectoryStore((s) => s.loadMore);

  // The first page for whatever the search box holds when the section appears.
  // Later queries arrive through the page's debounce, so the query is read
  // once, through a ref, and a re-render with a new value does not refetch.
  const initialQuery = useRef(query);
  useEffect(() => {
    void fetch(initialQuery.current);
  }, [fetch]);

  // Deduped by origin at render, against the session's own origin and every
  // instance the store knows in any status (spec section 9): a connection
  // that appears, returns or expires moves its origin between the sections
  // without a refetch of the feed.
  const entries = useMemo(
    () => dedupeAgainstConnected(feed, [window.location.origin, ...instances.map((i) => i.origin)]),
    [feed, instances],
  );

  if (status === 'disabled') return null;

  const hasEntries = entries.length > 0;
  // `idle` only exists between mount and the first `fetch` call, and a fetch
  // never leaves it there, so it is drawn as loading rather than as empty.
  const isLoading = status === 'loading' || status === 'idle';

  return (
    <section>
      <div className="mb-3" data-testid="outer-space-header">
        <div className="flex items-center gap-2">
          <span className="text-xs font-semibold uppercase tracking-wider text-txt-tertiary">
            {t('spaces:explore.outer.title')}
          </span>
          {isLoading && hasEntries && (
            <span data-testid="outer-space-header-spinner" className="text-txt-tertiary">
              <LoadingSpinner size={14} />
            </span>
          )}
        </div>
        <p className="text-[13px] text-txt-tertiary">{t('spaces:explore.outer.subtitle')}</p>
      </div>

      {isLoading && !hasEntries ? (
        <div className="flex items-center justify-center h-64" data-testid="outer-space-loading">
          <LoadingSpinner />
        </div>
      ) : status === 'ok' && !hasEntries ? (
        query ? (
          <p className="text-txt-tertiary text-sm py-6 text-center">{t('spaces:explore.outer.noMatches')}</p>
        ) : (
          <div className="flex flex-col items-center justify-center h-64 opacity-80">
            <div className="mb-3" data-testid="outer-space-mascot">
              <Mascot state="lonely" className="w-32 h-32" />
            </div>
            <p className="text-txt-tertiary text-sm text-center px-6">{t('spaces:explore.outer.empty')}</p>
          </div>
        )
      ) : (
        <div className="space-y-4">
          {hasEntries && (
            <div className="grid grid-cols-1 desktop:grid-cols-[repeat(auto-fit,minmax(min(100%,280px),1fr))] gap-4">
              {entries.map((entry) => (
                <SpaceCard
                  key={`${entry.id}:${entry.origin}`}
                  space={outerEntryToSpace(entry)}
                  onJoinSuccess={() => {}}
                  outer={{ entry, onConnect }}
                />
              ))}
            </div>
          )}

          {status === 'unreachable' && (
            <div className="p-2.5 bg-accent-amber/10 border border-accent-amber/30 rounded text-[13px] text-accent-amber">
              {t('errors:directory_unreachable')}
            </div>
          )}

          {status === 'error' && (
            <div className="p-3 bg-accent-rose/10 border border-accent-rose/30 rounded text-sm text-txt-danger">
              {t('errors:generic')}
            </div>
          )}

          {status === 'ok' && hasMore && (
            <div className="flex justify-center">
              <button
                onClick={() => { void loadMore(); }}
                className="px-4 py-2 bg-interactive-muted hover:bg-interactive-hover text-txt-secondary text-sm font-medium rounded transition-colors"
              >
                {t('spaces:explore.outer.showMore')}
              </button>
            </div>
          )}
        </div>
      )}
    </section>
  );
}
