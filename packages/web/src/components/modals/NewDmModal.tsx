import React, { useState, useRef, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { Modal } from '../ui/Modal';
import { Avatar } from '../ui/Avatar';
import { useUIStore } from '../../stores/uiStore';
import { useServerStore } from '../../stores/serverStore';
import { api } from '../../api/client';
import type { User } from '@opencord/shared';

export function NewDmModal() {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<User[]>([]);
  const [isSearching, setIsSearching] = useState(false);
  const [error, setError] = useState('');
  const activeModal = useUIStore((s) => s.activeModal);
  const closeModal = useUIStore((s) => s.closeModal);
  const addDmChannel = useServerStore((s) => s.addDmChannel);
  const navigate = useNavigate();
  const inputRef = useRef<HTMLInputElement>(null);
  const searchTimer = useRef<ReturnType<typeof setTimeout>>();

  const isOpen = activeModal === 'newDm';

  useEffect(() => {
    if (isOpen) {
      setQuery('');
      setResults([]);
      setError('');
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
        setResults(users);
      } catch {
        setResults([]);
      } finally {
        setIsSearching(false);
      }
    }, 300);
  };

  const handleSelectUser = async (user: User) => {
    setError('');
    try {
      const channel = await api.dm.create({ userId: user.id });
      addDmChannel(channel);
      closeModal();
      useUIStore.getState().setShowDms(true);
      navigate(`/channels/@me/${channel.id}`);
    } catch (err) {
      setError((err as Error).message || 'Failed to create DM');
    }
  };

  return (
    <Modal isOpen={isOpen} onClose={closeModal} title="New Direct Message">
      <div className="space-y-3">
        <input
          ref={inputRef}
          type="text"
          value={query}
          onChange={(e) => handleSearch(e.target.value)}
          placeholder="Search for a user..."
          className="w-full px-3 py-2 bg-discord-bg-tertiary text-discord-text-primary placeholder-discord-text-muted/60 rounded-[4px] text-[14px] outline-none focus:ring-1 focus:ring-discord-blurple"
        />

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
              className="w-full flex items-center gap-3 px-3 py-2 rounded-[4px] hover:bg-discord-modifier-hover transition-colors text-left"
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
