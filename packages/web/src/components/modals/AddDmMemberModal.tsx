import React, { useState, useRef, useEffect, useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import { Modal } from '../ui/Modal';
import { Avatar } from '../ui/Avatar';
import { useUIStore } from '../../stores/uiStore';
import { useSpaceStore } from '../../stores/spaceStore';
import { useAuthStore } from '../../stores/authStore';
import { useSocialStore, type TaggedFriend } from '../../stores/socialStore';
import { api } from '../../api/client';
import { isSelf } from '../../utils/identity';

export function AddDmMemberModal() {
  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [error, setError] = useState('');
  const [isAdding, setIsAdding] = useState(false);
  const activeModal = useUIStore((s) => s.activeModal);
  const modalData = useUIStore((s) => s.modalData);
  const closeModal = useUIStore((s) => s.closeModal);
  const dmChannels = useSpaceStore((s) => s.dmChannels);
  const addDmChannel = useSpaceStore((s) => s.addDmChannel);
  const friends = useSocialStore((s) => s.friends);
  const navigate = useNavigate();
  const myUser = useAuthStore((s) => s.user);
  const inputRef = useRef<HTMLInputElement>(null);

  const isOpen = activeModal === 'addDmMember';
  const dmChannelId = modalData.dmChannelId as string | undefined;
  const dmChannel = dmChannels.find(dm => dm.id === dmChannelId);
  const currentMemberIds = useMemo(
    () => new Set(dmChannel?.members.map(m => m.id) ?? []),
    [dmChannel?.members],
  );
  const memberCount = dmChannel?.members.length ?? 0;
  const maxMembers = 10;
  const remainingSlots = maxMembers - memberCount;

  // Filter friends: client-side search, exclude self
  const filteredFriends = useMemo(() => {
    const q = query.trim().toLowerCase();
    return friends.filter((f) => {
      if (isSelf(f, myUser)) return false;
      if (!q) return true;
      const displayName = (f.displayName ?? '').toLowerCase();
      const username = f.username.toLowerCase();
      return displayName.includes(q) || username.includes(q);
    });
  }, [friends, query, myUser]);

  // Reset state when modal opens
  useEffect(() => {
    if (isOpen) {
      setQuery('');
      setSelected(new Set());
      setError('');
      setIsAdding(false);
      setTimeout(() => inputRef.current?.focus(), 100);
    }
  }, [isOpen]);

  const toggleFriend = (friendId: string) => {
    if (currentMemberIds.has(friendId)) return;
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(friendId)) {
        next.delete(friendId);
      } else {
        // Enforce remaining capacity
        if (next.size >= remainingSlots) return prev;
        next.add(friendId);
      }
      return next;
    });
  };

  const removeFriend = (friendId: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      next.delete(friendId);
      return next;
    });
  };

  const selectedFriends = useMemo(
    () => friends.filter((f) => selected.has(f.id)),
    [friends, selected],
  );

  const handleSubmit = async () => {
    if (!dmChannelId || !dmChannel || isAdding || selectedFriends.length === 0) return;
    setError('');
    setIsAdding(true);
    try {
      if (!dmChannel.ownerId) {
        // 1-on-1 DM → create a new group DM with all selected + existing other member
        const otherMember = dmChannel.members.find(m => !isSelf(m, myUser));
        if (!otherMember) {
          setError('Could not determine the other member of this conversation.');
          setIsAdding(false);
          return;
        }
        const users = [
          { id: otherMember.id, homeUserId: otherMember.homeUserId, homeInstance: otherMember.homeInstance },
          ...selectedFriends.map((f) => ({
            id: f.id,
            homeUserId: f.homeUserId,
            homeInstance: f.homeInstance,
          })),
        ];
        const newChannel = await api.dm.createGroup({ users });
        addDmChannel(newChannel);
        closeModal();
        navigate(`/channels/@me/${newChannel.id}`);
      } else {
        // Existing group DM → add each friend sequentially
        for (const friend of selectedFriends) {
          await api.dm.addMember(dmChannelId, { userId: friend.id });
        }
        closeModal();
      }
    } catch (err) {
      setError((err as Error).message || 'Failed to add members');
    } finally {
      setIsAdding(false);
    }
  };

  const buttonText = selectedFriends.length === 0
    ? 'Select Friends'
    : `Add ${selectedFriends.length} Friend${selectedFriends.length > 1 ? 's' : ''}`;

  return (
    <Modal isOpen={isOpen} onClose={closeModal} title="Add Friends to DM" mobileStyle="sheet">
      <div className="space-y-3">
        {/* Header with member count */}
        <div className="flex items-center justify-between">
          <p className="text-[13px] text-txt-tertiary">
            Select friends to add to this conversation.
          </p>
          <span className="text-[12px] text-txt-tertiary flex-shrink-0 ml-2">
            {memberCount}/{maxMembers}
          </span>
        </div>

        {/* Selected chips */}
        {selectedFriends.length > 0 && (
          <div className="flex gap-1.5 flex-wrap">
            {selectedFriends.map((f) => (
              <span
                key={f.id}
                className="flex items-center gap-1 px-2.5 py-1 rounded-full text-[12px] bg-accent-mint/15 text-accent-mint"
              >
                {f.displayName ?? f.username}
                <button
                  onClick={() => removeFriend(f.id)}
                  className="opacity-60 hover:opacity-100 transition-opacity text-[14px] leading-none"
                >
                  &times;
                </button>
              </span>
            ))}
          </div>
        )}

        {/* Search input */}
        <input
          ref={inputRef}
          type="text"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search friends..."
          className="input-search w-full py-2 text-[14px]"
          disabled={remainingSlots <= 0}
        />

        {remainingSlots <= 0 && (
          <p className="text-txt-danger text-[13px]">This group DM has reached the 10-member limit.</p>
        )}

        {error && (
          <p className="text-txt-danger text-[13px]">{error}</p>
        )}

        {/* Friend list */}
        <div className="max-h-[300px] overflow-y-auto space-y-[2px]">
          {filteredFriends.length === 0 && (
            <div className="py-4 text-center text-txt-tertiary text-[14px]">
              {query.trim() ? 'No friends match your search' : 'No friends yet'}
            </div>
          )}

          {filteredFriends.map((friend) => {
            const isInDm = currentMemberIds.has(friend.id);
            const isSelected = selected.has(friend.id);
            const atCapacity = !isSelected && selected.size >= remainingSlots;

            return (
              <button
                key={friend.id}
                onClick={() => toggleFriend(friend.id)}
                disabled={isInDm || isAdding || atCapacity}
                className={`w-full flex items-center gap-3 px-3 py-2 rounded-[4px] transition-colors text-left ${
                  isInDm
                    ? 'opacity-40 cursor-not-allowed'
                    : isSelected
                      ? 'bg-accent-mint/[0.08]'
                      : 'hover:bg-interactive-hover'
                } ${atCapacity && !isInDm ? 'opacity-50 cursor-not-allowed' : ''}`}
              >
                <Avatar
                  src={friend.avatar}
                  name={friend.displayName ?? friend.username}
                  size={30}
                  status={friend.status as any}
                  userId={friend.homeUserId ?? friend.id}
                />
                <div className="flex-1 min-w-0">
                  <div className="text-[13px] font-medium text-txt-primary truncate">
                    {friend.displayName ?? friend.username}
                  </div>
                  <div className="text-[11px] text-txt-tertiary truncate">
                    {isInDm
                      ? 'Already in this DM'
                      : friend.username.includes('@')
                        ? `@${friend.username}`
                        : friend._instanceOrigin
                          ? `@${friend.username}@${new URL(friend._instanceOrigin).host}`
                          : `@${friend.username}`}
                  </div>
                </div>
                {!isInDm && (
                  <div
                    className={`w-[18px] h-[18px] rounded flex-shrink-0 flex items-center justify-center ${
                      isSelected
                        ? 'bg-accent-mint'
                        : 'border-2 border-border-hard'
                    }`}
                  >
                    {isSelected && (
                      <svg width="12" height="12" viewBox="0 0 12 12" fill="none" className="text-surface-base">
                        <path d="M2.5 6L5 8.5L9.5 3.5" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
                      </svg>
                    )}
                  </div>
                )}
              </button>
            );
          })}
        </div>

        {/* Submit button */}
        <button
          onClick={handleSubmit}
          disabled={selectedFriends.length === 0 || isAdding}
          className="w-full py-2 rounded-md text-[13px] font-semibold transition-colors bg-accent-mint text-surface-base hover:bg-accent-mint/90 disabled:opacity-50 disabled:cursor-not-allowed"
        >
          {isAdding ? 'Adding...' : buttonText}
        </button>
      </div>
    </Modal>
  );
}
