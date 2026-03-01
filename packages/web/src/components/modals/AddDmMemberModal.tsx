import React, { useState, useRef, useEffect } from 'react';
import { Modal } from '../ui/Modal';
import { Avatar } from '../ui/Avatar';
import { useUIStore } from '../../stores/uiStore';
import { useServerStore } from '../../stores/serverStore';
import { api } from '../../api/client';
import type { User } from '@backspace/shared';

export function AddDmMemberModal() {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<User[]>([]);
  const [isSearching, setIsSearching] = useState(false);
  const [error, setError] = useState('');
  const [isAdding, setIsAdding] = useState(false);
  const activeModal = useUIStore((s) => s.activeModal);
  const modalData = useUIStore((s) => s.modalData);
  const closeModal = useUIStore((s) => s.closeModal);
  const dmChannels = useServerStore((s) => s.dmChannels);
  const inputRef = useRef<HTMLInputElement>(null);
  const searchTimer = useRef<ReturnType<typeof setTimeout>>();

  const isOpen = activeModal === 'addDmMember';
  const dmChannelId = modalData.dmChannelId as string | undefined;
  const dmChannel = dmChannels.find(dm => dm.id === dmChannelId);
  const currentMemberIds = new Set(dmChannel?.members.map(m => m.id) ?? []);
  const memberCount = dmChannel?.members.length ?? 0;

  useEffect(() => {
    if (isOpen) {
      setQuery('');
      setResults([]);
      setError('');
      setIsAdding(false);
      setTimeout(() => inputRef.current?.focus(), 100);
    }
  }, [isOpen]);

  const handleSearch = (value: string) => {
    setQuery(value);
    setError('');

    if (searchTimer.current) {
      clearTimeout(searchTimer.current);
    }

    if (value.trim().length < 2) {
      setResults([]);
      return;
    }

    searchTimer.current = setTimeout(async () => {
      setIsSearching(true);
      try {
        const users = await api.social.search(value.trim());
        // Filter out users already in the DM
        setResults(users.filter(u => !currentMemberIds.has(u.id)));
      } catch {
        setResults([]);
      } finally {
        setIsSearching(false);
      }
    }, 300);
  };

  const handleSelectUser = async (user: User) => {
    if (!dmChannelId || isAdding) return;
    setError('');
    setIsAdding(true);
    try {
      await api.dm.addMember(dmChannelId, { userId: user.id });
      closeModal();
    } catch (err) {
      setError((err as Error).message || 'Failed to add member');
    } finally {
      setIsAdding(false);
    }
  };

  return (
    <Modal isOpen={isOpen} onClose={closeModal} title="Add Friends to DM">
      <div className="space-y-3">
        <div className="flex items-center justify-between">
          <p className="text-[13px] text-discord-text-muted">
            Search for a user to add to this conversation.
          </p>
          <span className="text-[12px] text-discord-text-muted flex-shrink-0 ml-2">
            {memberCount}/10
          </span>
        </div>

        <input
          ref={inputRef}
          type="text"
          value={query}
          onChange={(e) => handleSearch(e.target.value)}
          placeholder="Search for a user..."
          className="w-full px-3 py-2 bg-discord-bg-tertiary text-discord-text-primary placeholder-discord-text-muted/60 rounded-[4px] text-[14px] outline-none focus:ring-1 focus:ring-discord-blurple"
          disabled={memberCount >= 10}
        />

        {memberCount >= 10 && (
          <p className="text-discord-red text-[13px]">This group DM has reached the 10-member limit.</p>
        )}

        {error && (
          <p className="text-discord-red text-[13px]">{error}</p>
        )}

        <div className="max-h-[300px] overflow-y-auto space-y-[2px]">
          {isSearching && (
            <div className="py-4 text-center text-discord-text-muted text-[14px]">Searching...</div>
          )}

          {!isSearching && query.trim().length >= 2 && results.length === 0 && (
            <div className="py-4 text-center text-discord-text-muted text-[14px]">No users found</div>
          )}

          {results.map((user) => (
            <button
              key={user.id}
              onClick={() => handleSelectUser(user)}
              disabled={isAdding}
              className="w-full flex items-center gap-3 px-3 py-2 rounded-[4px] hover:bg-discord-modifier-hover transition-colors text-left disabled:opacity-50"
            >
              <Avatar src={user.avatar} name={user.displayName ?? user.username} size={36} status={user.status as any} />
              <div className="flex-1 min-w-0">
                <div className="text-[14px] font-medium text-discord-text-primary truncate">
                  {user.displayName ?? user.username}
                </div>
                <div className="text-[12px] text-discord-text-muted truncate">@{user.username}</div>
              </div>
            </button>
          ))}
        </div>
      </div>
    </Modal>
  );
}
