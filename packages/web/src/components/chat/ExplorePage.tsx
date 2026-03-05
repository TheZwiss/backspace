import React, { useEffect, useRef, useState, useCallback, useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import { useExploreStore, type TaggedExploreServer } from '../../stores/exploreStore';
import { useServerStore } from '../../stores/serverStore';
import { LoadingSpinner } from '../ui/LoadingSpinner';
import { getServerGradient } from '../../utils/gradients';

export function ExplorePage() {
  const navigate = useNavigate();
  const setCurrentServer = useServerStore((s) => s.setCurrentServer);

  const servers = useExploreStore((s) => s.servers);
  const myRequests = useExploreStore((s) => s.myRequests);
  const isLoading = useExploreStore((s) => s.isLoading);
  const discoveryEnabled = useExploreStore((s) => s.discoveryEnabled);
  const error = useExploreStore((s) => s.error);
  const searchQuery = useExploreStore((s) => s.searchQuery);
  const setSearchQuery = useExploreStore((s) => s.setSearchQuery);
  const fetchServers = useExploreStore((s) => s.fetchServers);
  const fetchMyRequests = useExploreStore((s) => s.fetchMyRequests);

  const [joinedCollapsed, setJoinedCollapsed] = useState(false);

  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Fetch on mount
  useEffect(() => {
    fetchServers();
    fetchMyRequests();
  }, [fetchServers, fetchMyRequests]);

  // Debounced search
  const handleSearchChange = useCallback((value: string) => {
    setSearchQuery(value);
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => {
      fetchServers(value || undefined);
    }, 300);
  }, [setSearchQuery, fetchServers]);

  useEffect(() => {
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, []);

  const handleJoinSuccess = (serverId: string) => {
    setCurrentServer(serverId);
    navigate(`/channels/${serverId}`);
  };

  const unjoinedServers = useMemo(
    () => servers.filter(s => !s.joined),
    [servers],
  );
  const joinedServers = useMemo(
    () => servers.filter(s => s.joined),
    [servers],
  );

  const hasAnyServers = servers.length > 0;
  const hasUnjoined = unjoinedServers.length > 0;
  const hasJoined = joinedServers.length > 0;

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
            placeholder="Search servers..."
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
      </div>

      {/* Content */}
      <div className="flex-1 overflow-y-auto">
        {!discoveryEnabled && (
          <div className="mx-6 mt-4 p-2.5 bg-accent-amber/10 border border-accent-amber/30 rounded text-[13px] text-accent-amber">
            Server discovery is disabled by the instance administrator.
          </div>
        )}

        {isLoading && servers.length === 0 ? (
          <div className="flex-1 flex items-center justify-center h-64">
            <LoadingSpinner />
          </div>
        ) : error ? (
          <div className="mx-6 mt-4 p-3 bg-accent-rose/10 border border-accent-rose/30 rounded text-sm text-txt-danger">
            {error}
          </div>
        ) : !hasAnyServers ? (
          /* True empty state — no discoverable servers at all */
          <div className="flex flex-col items-center justify-center h-64 opacity-60">
            <svg width="48" height="48" viewBox="0 0 24 24" fill="currentColor" className="text-txt-tertiary mb-3">
              <path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm0 18c-4.41 0-8-3.59-8-8s3.59-8 8-8 8 3.59 8 8-3.59 8-8 8zm-5.5-2.5l7.51-3.49L17.5 6.5 9.99 9.99 6.5 17.5zm5.5-6.6c.61 0 1.1.49 1.1 1.1s-.49 1.1-1.1 1.1-1.1-.49-1.1-1.1.49-1.1 1.1-1.1z" />
            </svg>
            <p className="text-txt-tertiary text-sm">
              {searchQuery
                ? 'No servers match your search.'
                : 'No servers have been made discoverable yet.'}
            </p>
          </div>
        ) : (
          <div className="p-6 space-y-6">
            {/* All-joined success banner (only when no unjoined servers remain) */}
            {!hasUnjoined && hasJoined && !searchQuery && (
              <div className="flex items-center gap-2.5 px-4 py-2.5 bg-accent-mint/10 border border-accent-mint/20 rounded-lg">
                <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor" className="text-accent-mint flex-shrink-0">
                  <path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-2 15l-5-5 1.41-1.41L10 14.17l7.59-7.59L19 8l-9 9z" />
                </svg>
                <span className="text-[13px] text-accent-mint">
                  You're in all discoverable servers
                </span>
              </div>
            )}

            {/* Unjoined servers grid */}
            {hasUnjoined && (
              <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
                {unjoinedServers.map((server) => (
                  <ServerCard
                    key={`${server.id}:${server._instanceOrigin}`}
                    server={server}
                    isPending={myRequests.some(r => r.serverId === server.id && r.status === 'pending')}
                    onJoinSuccess={handleJoinSuccess}
                  />
                ))}
              </div>
            )}

            {/* Joined servers section */}
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
                    {joinedServers.length}
                  </span>
                </button>

                {!joinedCollapsed && (
                  <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
                    {joinedServers.map((server) => (
                      <ServerCard
                        key={`${server.id}:${server._instanceOrigin}`}
                        server={server}
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

function ServerCard({
  server,
  isPending,
  onJoinSuccess,
}: {
  server: TaggedExploreServer;
  isPending: boolean;
  onJoinSuccess: (serverId: string) => void;
}) {
  const publicJoin = useExploreStore((s) => s.publicJoin);
  const requestJoin = useExploreStore((s) => s.requestJoin);

  const [joining, setJoining] = useState(false);
  const [showRequestForm, setShowRequestForm] = useState(false);
  const [requestMessage, setRequestMessage] = useState('');
  const [requestSent, setRequestSent] = useState(isPending);
  const [joinError, setJoinError] = useState('');

  const gradient = getServerGradient(server.id, server.name);
  const isPublic = server.visibility === 'public';
  const isJoined = server.joined === true;
  const originLabel = server._instanceOrigin
    ? (() => { try { return new URL(server._instanceOrigin).host; } catch { return server._instanceOrigin; } })()
    : null;

  const handlePublicJoin = async () => {
    setJoining(true);
    setJoinError('');
    try {
      const fullServer = await publicJoin(server);
      onJoinSuccess(fullServer.id);
    } catch (err) {
      setJoinError(err instanceof Error ? err.message : 'Failed to join');
      setJoining(false);
    }
  };

  const handleRequestJoin = async () => {
    setJoining(true);
    setJoinError('');
    try {
      await requestJoin(server, requestMessage.trim() || undefined);
      setRequestSent(true);
      setShowRequestForm(false);
    } catch (err) {
      setJoinError(err instanceof Error ? err.message : 'Failed to send request');
    } finally {
      setJoining(false);
    }
  };

  const handleViewServer = () => {
    onJoinSuccess(server.id);
  };

  return (
    <div className={`bg-surface-channel rounded-lg border overflow-hidden flex flex-col transition-colors ${
      isJoined
        ? 'border-accent-mint/20 hover:border-accent-mint/40'
        : 'border-border-soft hover:border-border-hard'
    }`}>
      {/* Banner / Icon area */}
      <div className="h-32 relative flex items-center justify-center" style={{ background: gradient.gradient }}>
        {server.icon ? (
          <img
            src={server.icon.startsWith('http') ? server.icon : `/api/uploads/${server.icon}`}
            alt={server.name}
            className="w-16 h-16 rounded-2xl object-cover shadow-lg"
          />
        ) : (
          <span className="text-3xl font-bold text-white/90 drop-shadow-md">
            {server.name.charAt(0).toUpperCase()}
          </span>
        )}

        {/* Joined badge (top-left) */}
        {isJoined && (
          <div className="absolute top-2 left-2">
            <span className="flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-semibold bg-accent-mint/25 text-accent-mint backdrop-blur-sm">
              <svg width="10" height="10" viewBox="0 0 24 24" fill="currentColor">
                <path d="M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z" />
              </svg>
              Joined
            </span>
          </div>
        )}

        {/* Visibility badge */}
        <div className="absolute top-2 right-2">
          <span className={`px-2 py-0.5 rounded-full text-[10px] font-semibold uppercase tracking-wider ${
            isPublic
              ? 'bg-accent-mint/20 text-accent-mint'
              : 'bg-accent-amber/20 text-accent-amber'
          }`}>
            {isPublic ? 'Public' : 'Request'}
          </span>
        </div>

        {/* Instance origin */}
        {originLabel && (
          <div className="absolute bottom-2 left-2">
            <span className="px-1.5 py-0.5 rounded bg-black/40 text-[10px] text-white/80 font-medium backdrop-blur-sm">
              {originLabel}
            </span>
          </div>
        )}
      </div>

      {/* Content */}
      <div className="p-4 flex flex-col flex-1">
        <h3 className="text-[15px] font-bold text-txt-primary truncate mb-1">{server.name}</h3>

        {server.description ? (
          <p className="text-[13px] text-txt-secondary line-clamp-2 mb-3 flex-1">
            {server.description}
          </p>
        ) : (
          <p className="text-[13px] text-txt-tertiary italic mb-3 flex-1">No description</p>
        )}

        <div className="flex items-center gap-3 text-[12px] text-txt-tertiary mb-3">
          <span className="flex items-center gap-1">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" className="opacity-60">
              <path d="M16 11c1.66 0 2.99-1.34 2.99-3S17.66 5 16 5c-1.66 0-3 1.34-3 3s1.34 3 3 3zm-8 0c1.66 0 2.99-1.34 2.99-3S9.66 5 8 5C6.34 5 5 6.34 5 8s1.34 3 3 3zm0 2c-2.33 0-7 1.17-7 3.5V19h14v-2.5c0-2.33-4.67-3.5-7-3.5zm8 0c-.29 0-.62.02-.97.05 1.16.84 1.97 1.97 1.97 3.45V19h6v-2.5c0-2.33-4.67-3.5-7-3.5z" />
            </svg>
            {server.memberCount} {server.memberCount === 1 ? 'member' : 'members'}
          </span>
        </div>

        {/* Action area */}
        {joinError && (
          <div className="text-[12px] text-txt-danger mb-2">{joinError}</div>
        )}

        {isJoined ? (
          <button
            onClick={handleViewServer}
            className="w-full py-2 bg-accent-mint/15 hover:bg-accent-mint/25 text-accent-mint text-sm font-medium rounded transition-colors"
          >
            View Server
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
              'Join Server'
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
