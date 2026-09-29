import React, { useState, useRef, useEffect, useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { Modal } from '../ui/Modal';
import { Avatar } from '../ui/Avatar';
import { useUIStore } from '../../stores/uiStore';
import { useSpaceStore, dmCopyOnOrigin } from '../../stores/spaceStore';
import { useSelfIdentity } from '../../stores/authStore';
import { useSocialStore, type TaggedFriend } from '../../stores/socialStore';
import { api } from '../../api/client';
import { isMine, parseFederatedUsername, personRequest, type IdentityFields } from '../../utils/identity';
import { useDmViewer } from '../../hooks/useDmViewer';
import { useCanonicalUserView } from '../../utils/userViewLookup';
import type { GroupDmUserIdentity, User } from '@backspace/shared';

/**
 * A member of a group DM create request to the page's own instance: the row
 * as `origin` issued it, with the home identity home resolves it by
 * (`personRequest`), or its id alone for a person native to home.
 */
function groupMemberRef(row: IdentityFields, origin: string): GroupDmUserIdentity {
  const { target } = personRequest(row, origin);
  return { id: target.userId ?? row.id, homeUserId: target.homeUserId ?? null, homeInstance: target.homeInstance ?? null };
}

function AddDmFriendRow({
  friend,
  isInDm,
  isSelected,
  atCapacity,
  isAdding,
  onToggle,
}: {
  friend: TaggedFriend;
  isInDm: boolean;
  isSelected: boolean;
  atCapacity: boolean;
  isAdding: boolean;
  onToggle: (id: string) => void;
}) {
  const { t } = useTranslation(['dm', 'common']);
  const canonical = useCanonicalUserView(friend as unknown as User, friend._instanceOrigin);
  const { baseName } = parseFederatedUsername(canonical.username);
  const friendDisplayName = canonical.displayName ?? baseName;
  return (
    <button
      onClick={() => onToggle(friend.id)}
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
        src={canonical.avatar}
        name={friendDisplayName}
        size={30}
        status={canonical.status as any}
        userId={canonical.homeUserId ?? canonical.id}
        avatarColor={canonical.avatarColor}
      />
      <div className="flex-1 min-w-0">
        <div className="text-[13px] font-medium text-txt-primary truncate">
          {friendDisplayName}
        </div>
        <div className="text-[11px] text-txt-tertiary truncate">
          {isInDm ? t('dm:addMember.alreadyInDm') : `@${canonical.username}`}
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
}

export function AddDmMemberModal() {
  const { t } = useTranslation(['dm', 'common']);
  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [error, setError] = useState('');
  const [isAdding, setIsAdding] = useState(false);
  const activeModal = useUIStore((s) => s.activeModal);
  const modalData = useUIStore((s) => s.modalData);
  const closeModal = useUIStore((s) => s.closeModal);
  const dmChannels = useSpaceStore((s) => s.dmChannels);
  const upsertDmCopy = useSpaceStore((s) => s.upsertDmCopy);
  const friends = useSocialStore((s) => s.friends);
  const navigate = useNavigate();
  const self = useSelfIdentity();
  const inputRef = useRef<HTMLInputElement>(null);

  const isOpen = activeModal === 'addDmMember';
  const dmChannelId = modalData.dmChannelId as string | undefined;
  const dmChannel = dmChannels.find(dm => dm.id === dmChannelId);
  const viewer = useDmViewer(dmChannelId);
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
      if (isMine(f, f._instanceOrigin, self)) return false;
      if (!q) return true;
      const displayName = (f.displayName ?? '').toLowerCase();
      const username = f.username.toLowerCase();
      return displayName.includes(q) || username.includes(q);
    });
  }, [friends, query, self]);

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
    // Both requests go to the home instance, which knows the conversation
    // only as its own copy: its id and its members. The row may be pinned to
    // another instance's copy, whose ids mean nothing there.
    const homeCopy = dmCopyOnOrigin(dmChannelId, '');
    try {
      if (!dmChannel.ownerId) {
        // 1-on-1 DM → create a new group DM with all selected + existing other member
        const partnerOrigin = homeCopy ? '' : viewer.origin;
        const partner = (homeCopy ?? dmChannel).members.find(m => !isMine(m, partnerOrigin, self));
        if (!partner) {
          setError(t('dm:addMember.noOtherMember'));
          setIsAdding(false);
          return;
        }
        // Home's own row for the partner when it holds the conversation;
        // otherwise the partner by their home identity, which home resolves.
        const users = [
          groupMemberRef(partner, partnerOrigin),
          ...selectedFriends.map((f) => groupMemberRef(f, f._instanceOrigin)),
        ];
        // Home checks the source 1-on-1 by its own id; without a home copy
        // there is none to name.
        const newChannel = await api.dm.createGroup({ users, fromDmChannelId: homeCopy?.id });
        const rowId = upsertDmCopy('', newChannel, 'stated');
        closeModal();
        navigate(`/channels/@me/${rowId}`);
      } else {
        // Existing group DM → add each friend sequentially, on home's copy.
        if (!homeCopy) {
          setError(t('dm:addMember.failed'));
          setIsAdding(false);
          return;
        }
        for (const friend of selectedFriends) {
          await api.dm.addMember(homeCopy.id, personRequest(friend, friend._instanceOrigin).target);
        }
        closeModal();
      }
    } catch (err) {
      setError((err as Error).message || t('dm:addMember.failed'));
    } finally {
      setIsAdding(false);
    }
  };

  const buttonText = selectedFriends.length === 0
    ? t('dm:addMember.selectFriends')
    : t('dm:addMember.addCount', { count: selectedFriends.length });

  return (
    <Modal isOpen={isOpen} onClose={closeModal} title={t('dm:addMember.title')} mobileStyle="sheet">
      <div className="space-y-3">
        {/* Header with member count */}
        <div className="flex items-center justify-between">
          <p className="text-[13px] text-txt-tertiary">
            {t('dm:addMember.description')}
          </p>
          <span className="text-[12px] text-txt-tertiary flex-shrink-0 ml-2">
            {t('dm:addMember.capacity', { current: memberCount, max: maxMembers })}
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
                {f.displayName ?? parseFederatedUsername(f.username).baseName}
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
          placeholder={t('dm:addMember.searchPlaceholder')}
          className="input-search w-full py-2 text-[14px]"
          disabled={remainingSlots <= 0}
        />

        {remainingSlots <= 0 && (
          <p className="text-txt-danger text-[13px]">{t('dm:addMember.limitReached', { max: maxMembers })}</p>
        )}

        {error && (
          <p className="text-txt-danger text-[13px]">{error}</p>
        )}

        {/* Friend list */}
        <div className="max-h-[300px] overflow-y-auto space-y-[2px]">
          {filteredFriends.length === 0 && (
            <div className="py-4 text-center text-txt-tertiary text-[14px]">
              {query.trim() ? t('dm:addMember.noMatch') : t('dm:addMember.noFriends')}
            </div>
          )}

          {filteredFriends.map((friend) => {
            const isInDm = currentMemberIds.has(friend.id);
            const isSelected = selected.has(friend.id);
            const atCapacity = !isSelected && selected.size >= remainingSlots;
            return (
              <AddDmFriendRow
                key={friend.id}
                friend={friend}
                isInDm={isInDm}
                isSelected={isSelected}
                atCapacity={atCapacity}
                isAdding={isAdding}
                onToggle={toggleFriend}
              />
            );
          })}
        </div>

        {/* Submit button */}
        <button
          onClick={handleSubmit}
          disabled={selectedFriends.length === 0 || isAdding}
          className="w-full py-2 rounded-md text-[13px] font-semibold transition-colors bg-accent-mint text-surface-base hover:bg-accent-mint/90 disabled:opacity-50 disabled:cursor-not-allowed"
        >
          {isAdding ? t('dm:addMember.adding') : buttonText}
        </button>
      </div>
    </Modal>
  );
}
