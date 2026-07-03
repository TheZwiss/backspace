import React, { useState, useEffect, useCallback } from 'react';
import { Avatar } from '../../ui/Avatar';
import { useSpaceStore, getApiForOrigin } from '../../../stores/spaceStore';

interface Ban {
  spaceId: string;
  userId: string;
  reason: string | null;
  bannedBy: string;
  createdAt: number;
  user: { id: string; username: string; displayName?: string | null; avatar?: string | null } | null;
  moderator: { id: string; username: string; displayName?: string | null } | null;
}

interface BansPanelProps {
  spaceId: string;
}

export function BansPanel({ spaceId }: BansPanelProps) {
  const spaces = useSpaceStore((s) => s.spaces);
  const space = spaces.find((s) => s.id === spaceId);
  const spaceApi = getApiForOrigin(space?._instanceOrigin ?? '');

  const [bans, setBans] = useState<Ban[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState('');

  const loadBans = useCallback(async () => {
    try {
      setIsLoading(true);
      const data = await spaceApi.spaces.getBans(spaceId);
      setBans(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load bans');
    } finally {
      setIsLoading(false);
    }
  }, [spaceId, spaceApi]);

  useEffect(() => {
    loadBans();
  }, [loadBans]);

  const handleUnban = async (userId: string) => {
    try {
      await spaceApi.spaces.unban(spaceId, userId);
      setBans((prev) => prev.filter((b) => b.userId !== userId));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to unban user');
    }
  };

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-8">
        <div className="text-txt-tertiary text-sm">Loading bans...</div>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <h2 className="text-lg font-semibold text-txt-primary mb-6">Bans</h2>
      {error && (
        <div className="p-2 bg-accent-rose/10 border border-accent-rose/30 rounded text-txt-danger text-sm">{error}</div>
      )}

      <p className="text-xs text-txt-tertiary">Banned users cannot rejoin this space until unbanned.</p>

      {bans.length === 0 ? (
        <div className="text-center py-8 text-txt-tertiary text-sm">No banned users</div>
      ) : (
        <div>
          <div className="text-[11px] font-semibold text-txt-tertiary uppercase tracking-wider mb-1.5">
            Bans ({bans.length})
          </div>
          <div className="rounded-lg bg-white/[0.02] p-2">
            <div className="space-y-0.5">
              {bans.map((ban) => {
                const displayName = ban.user?.displayName ?? ban.user?.username ?? ban.userId;
                const moderatorName = ban.moderator?.displayName ?? ban.moderator?.username ?? ban.bannedBy;
                const bannedDate = new Date(ban.createdAt).toLocaleDateString();

                return (
                  <div key={ban.userId} className="flex items-center justify-between p-2 rounded hover:bg-interactive-hover transition-colors">
                    <div className="flex items-center gap-2 min-w-0">
                      <Avatar
                        src={ban.user?.avatar ?? null}
                        name={displayName}
                        size={32}
                        userId={ban.userId}
                      />
                      <div className="min-w-0">
                        <div className="text-sm font-medium truncate">{displayName}</div>
                        <div className="text-[11px] text-txt-tertiary truncate">
                          Banned by {moderatorName} on {bannedDate}
                          {ban.reason && ` — ${ban.reason}`}
                        </div>
                      </div>
                    </div>
                    <button
                      onClick={() => handleUnban(ban.userId)}
                      className="px-2 py-1 text-xs text-txt-secondary hover:text-txt-primary hover:bg-surface-base rounded transition-colors flex-shrink-0"
                    >
                      Unban
                    </button>
                  </div>
                );
              })}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
