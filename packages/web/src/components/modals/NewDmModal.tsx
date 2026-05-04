import React, { useState, useRef, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { Modal } from '../ui/Modal';
import { Avatar } from '../ui/Avatar';
import { useUIStore } from '../../stores/uiStore';
import { useSpaceStore } from '../../stores/spaceStore';
import { api } from '../../api/client';
import type { User } from '@backspace/shared';
import { parseFederatedUsername } from '../../utils/identity';
import { useCanonicalUserView } from '../../utils/userViewLookup';

function NewDmUserRow({
  user,
  onSelect,
}: {
  user: User;
  onSelect: (user: User) => void;
}) {
  const canonical = useCanonicalUserView(user);
  const { baseName } = parseFederatedUsername(canonical.username);
  const displayName = canonical.displayName ?? baseName;
  return (
    <button
      onClick={() => onSelect(user)}
      className="w-full flex items-center gap-3 px-3 py-2 rounded-[4px] hover:bg-interactive-hover transition-colors text-left"
    >
      <Avatar src={canonical.avatar} name={displayName} size={36} status={canonical.status as any} userId={canonical.homeUserId ?? canonical.id} avatarColor={canonical.avatarColor} />
      <div className="flex-1 min-w-0">
        <div className="text-[14px] font-medium text-txt-primary truncate">
          {displayName}
        </div>
        <div className="text-[12px] text-txt-tertiary truncate">@{canonical.username}</div>
      </div>
    </button>
  );
}

export function NewDmModal() {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<User[]>([]);
  const [isSearching, setIsSearching] = useState(false);
  const [error, setError] = useState('');
  const activeModal = useUIStore((s) => s.activeModal);
  const closeModal = useUIStore((s) => s.closeModal);
  const addDmChannel = useSpaceStore((s) => s.addDmChannel);
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
      const existing = useSpaceStore.getState().findExistingDmForUser(user);
      if (existing) {
        closeModal();
        useUIStore.getState().setShowDms(true);
        navigate(`/channels/@me/${existing.dm.id}`);
        return;
      }
      const channel = await api.dm.create({
        userId: user.homeInstance ? undefined : user.id,
        homeUserId: user.homeUserId ?? undefined,
        homeInstance: user.homeInstance ?? undefined,
      });
      addDmChannel(channel);
      closeModal();
      useUIStore.getState().setShowDms(true);
      navigate(`/channels/@me/${channel.id}`);
    } catch (err) {
      setError((err as Error).message || 'Failed to create DM');
    }
  };

  return (
    <Modal isOpen={isOpen} onClose={closeModal} title="New Direct Message" mobileStyle="sheet">
      <div className="space-y-3">
        <input
          ref={inputRef}
          type="text"
          value={query}
          onChange={(e) => handleSearch(e.target.value)}
          placeholder="Search for a user..."
          className="input-search w-full py-2 text-[14px]"
        />

        {error && (
          <p className="text-txt-danger text-[13px]">{error}</p>
        )}

        <div className="max-h-[300px] overflow-y-auto space-y-[2px]">
          {isSearching && (
            <div className="py-4 text-center text-txt-tertiary text-[14px]">Searching...</div>
          )}

          {!isSearching && query.trim().length >= 2 && results.length === 0 && (
            <div className="py-4 text-center text-txt-tertiary text-[14px]">No users found</div>
          )}

          {results.map((user) => (
            <NewDmUserRow
              key={user.id}
              user={user}
              onSelect={handleSelectUser}
            />
          ))}
        </div>
      </div>
    </Modal>
  );
}
