import React, { useEffect, useMemo, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import type { DirectoryEntry } from '@backspace/shared';
import { useDirectoryStore, type DirectoryFailure, type DirectoryStatus } from '../../stores/directoryStore';
import { useInstanceStore } from '../../stores/instanceStore';
import { dedupeAgainstConnected, innerOrigins } from '../../utils/directory';
import { LoadingSpinner } from '../ui/LoadingSpinner';
import { Mascot } from '../ui/Mascot';
import { SpaceCard, outerEntryToSpace } from './SpaceCard';

/**
 * The notice under the list, first match wins: the state of the page the
 * section is showing, or, when that page arrived, the state of the
 * continuation that did not.
 *
 * One derived value for both, because the two sources say the same thing to
 * the user and only ever differ in which request failed. `disabled` has no
 * notice of its own here: the whole section is gone before this is read when
 * the first page was refused that way, and a continuation refused mid-session
 * is an instance that changed under the user, which the generic notice covers.
 */
function outerNotice(status: DirectoryStatus, loadMoreError: DirectoryFailure | null): 'none' | 'unreachable' | 'error' {
  if (status === 'unreachable' || status === 'error') return status;
  if (loadMoreError === 'unreachable') return 'unreachable';
  if (loadMoreError === 'error' || loadMoreError === 'disabled') return 'error';
  return 'none';
}

interface OuterSpaceSectionProps {
  /** The page's search query; the section fetches it on mount, the page re-fetches on change. */
  query: string;
  onConnect: (entry: DirectoryEntry) => void;
}

/**
 * The directory half of the Explore page: spaces on instances the session is
 * not connected to. The page gates it on the home instance's
 * `directoryAvailable` flag (an endpoint is configured and the admin allows
 * browsing), not on the admin's listing opt-in; the section itself renders
 * the store's states and nothing else.
 */
export function OuterSpaceSection({ query, onConnect }: OuterSpaceSectionProps) {
  const { t } = useTranslation(['spaces', 'errors']);
  const feed = useDirectoryStore((s) => s.entries);
  const registry = useInstanceStore((s) => s.registry);
  const instances = useInstanceStore((s) => s.instances);
  const status = useDirectoryStore((s) => s.status);
  const hasMore = useDirectoryStore((s) => s.hasMore);
  const loadMoreError = useDirectoryStore((s) => s.loadMoreError);
  // The query the entries on screen answer, which is not what the search box
  // holds: the box is live and the fetch is debounced, so reading the prop
  // flipped the empty copy between "nothing matches" and "nothing out there
  // yet" for the length of the debounce, about a result set that had not
  // moved. The store records the query with the request it belongs to.
  const resultsQuery = useDirectoryStore((s) => s.query);
  const fetch = useDirectoryStore((s) => s.fetch);
  const loadMore = useDirectoryStore((s) => s.loadMore);

  // The first page for whatever the search box holds when the section appears.
  // Later queries arrive through the page's debounce, so the query is read
  // once, through a ref, and a re-render with a new value does not refetch.
  const initialQuery = useRef(query);
  useEffect(() => {
    void fetch(initialQuery.current);
  }, [fetch]);

  // Deduped by origin at render, against the session's own origin and the
  // origins that belong to Inner Space or to a connection chip (spec section
  // 9): a connection that appears, returns, expires or is disconnected moves
  // its origin between the sections without a refetch of the feed.
  const entries = useMemo(
    () => dedupeAgainstConnected(feed, [window.location.origin, ...innerOrigins(registry.values(), instances)]),
    [feed, registry, instances],
  );

  if (status === 'disabled') return null;

  const hasEntries = entries.length > 0;
  // A notice takes the empty copy's place rather than sitting under it: with
  // `status` left on `ok` after a refused continuation, a feed whose every
  // visible entry had been deduped against a connected origin would have
  // rendered "Nothing out there yet" with nothing saying that a page had just
  // failed to arrive.
  const notice = outerNotice(status, loadMoreError);
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
      ) : status === 'ok' && !hasEntries && notice === 'none' ? (
        resultsQuery ? (
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
            <div className="card-grid">
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

          {notice === 'unreachable' && (
            <div className="p-2.5 bg-accent-amber/10 border border-accent-amber/30 rounded text-[13px] text-accent-amber">
              {t('errors:directory_unreachable')}
            </div>
          )}

          {notice === 'error' && (
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
