import React, { useMemo, useState } from 'react';
import type { User } from '@backspace/shared';
import { useChatStore } from '../../stores/chatStore';
import { useSpaceStore } from '../../stores/spaceStore';
import { useUIStore } from '../../stores/uiStore';
import { useAuthStore } from '../../stores/authStore';
import { useSocialStore } from '../../stores/socialStore';
import { isSelf, parseFederatedUsername } from '../../utils/identity';
import { api } from '../../api/client';
import { ConfirmDialog } from '../ui/ConfirmDialog';
import { DmMemberRow, type DmMemberRowAction } from './DmMemberRow';

/**
 * Right-side roster for group DMs. Mirrors `MemberSidebar`'s layout language
 * (240px column, structural surface, hidden on mobile) so toggling
 * `memberListOpen` feels identical across spaces and group DMs.
 *
 * Renders nothing for 1-on-1 DMs and when `memberListOpen` is false. The
 * default-state inheritance is intentional — this panel does not own a
 * separate boolean and explicitly carries the user's global toggle preference.
 */
export function DmRosterPanel() {
  const memberListOpen = useUIStore((s) => s.memberListOpen);
  const openUserProfile = useUIStore((s) => s.openUserProfile);
  const addToast = useUIStore((s) => s.addToast);

  const currentChannelId = useChatStore((s) => s.currentChannelId);
  const dmChannels = useSpaceStore((s) => s.dmChannels);
  const currentSpaceId = useSpaceStore((s) => s.currentSpaceId);
  const showDms = useUIStore((s) => s.showDms);

  const authUser = useAuthStore((s) => s.user);
  const friends = useSocialStore((s) => s.friends);
  const removeFriendStore = useSocialStore((s) => s.removeFriend);

  const dmChannel = useMemo(
    () => dmChannels.find((dm) => dm.id === currentChannelId) ?? null,
    [dmChannels, currentChannelId],
  );

  // Confirm-state for destructive actions. Two separate slots — kick + transfer
  // — so we can keep simple state without a discriminated union.
  const [pendingKick, setPendingKick] = useState<User | null>(null);
  const [pendingTransfer, setPendingTransfer] = useState<User | null>(null);
  const [submitting, setSubmitting] = useState(false);

  // ── Visibility gates ────────────────────────────────────────────────────
  // Render only when:
  //   1. We're in the DM view (showDms=true OR no current space).
  //   2. The current channel is a group DM (ownerId set).
  //   3. The global member-list toggle is on.
  const inDmView = showDms || !currentSpaceId;
  const isGroupDm = !!dmChannel?.ownerId;

  if (!inDmView || !dmChannel || !isGroupDm || !memberListOpen) {
    return null;
  }

  const ownerId = dmChannel.ownerId;
  const callerIsOwner = !!authUser && ownerId === authUser.id;

  // ── Section grouping ────────────────────────────────────────────────────
  // Owner first (always exactly one row), then online and offline groups
  // sorted alphabetically by displayName (falling back to baseName from the
  // username). This mirrors MemberSidebar's offline-section ordering and
  // its display-name-first label resolution.
  const sortByDisplayName = (a: User, b: User) => {
    const aName = (a.displayName ?? parseFederatedUsername(a.username).baseName).toLowerCase();
    const bName = (b.displayName ?? parseFederatedUsername(b.username).baseName).toLowerCase();
    return aName.localeCompare(bName);
  };

  const ownerMember = dmChannel.members.find((m) => m.id === ownerId) ?? null;
  const nonOwnerMembers = dmChannel.members.filter((m) => m.id !== ownerId);
  const onlineMembers = nonOwnerMembers
    .filter((m) => m.status !== 'offline')
    .sort(sortByDisplayName);
  const offlineMembers = nonOwnerMembers
    .filter((m) => m.status === 'offline')
    .sort(sortByDisplayName);

  // ── Per-row helpers ────────────────────────────────────────────────────
  const isFriendOfCaller = (m: User): boolean => {
    // Federation-safe: friends can be replicated locally, so the local id
    // is the right comparison target — Friend.id is always the local id on
    // the current instance, mirroring MessageList's WelcomeHeader pattern.
    return friends.some((f) => f.id === m.id);
  };

  const handleMenuAction = async (action: DmMemberRowAction, member: User) => {
    if (action === 'profile') {
      // Profile popout is anchored by DmMemberRow itself (matches the
      // MemberSidebar pattern). This branch only fires on the unlikely
      // fallback path where the row couldn't compute its bounding rect —
      // in that case, anchor to the top-left of the roster column.
      openUserProfile(member, { top: 100, left: 100 });
      return;
    }
    if (action === 'kick') {
      setPendingKick(member);
      return;
    }
    if (action === 'transfer') {
      setPendingTransfer(member);
      return;
    }
    if (action === 'remove-friend') {
      try {
        await removeFriendStore(member.id);
      } catch (err) {
        addToast(
          err instanceof Error ? err.message : 'Failed to remove friend',
          'warning',
          3000,
        );
      }
    }
  };

  const confirmKick = async () => {
    if (!pendingKick) return;
    setSubmitting(true);
    try {
      await api.dm.kickMember(dmChannel.id, pendingKick.id);
      addToast(
        `Removed ${pendingKick.displayName ?? parseFederatedUsername(pendingKick.username).baseName} from the group`,
        'success',
        3000,
      );
      setPendingKick(null);
    } catch (err) {
      addToast(
        err instanceof Error ? err.message : 'Failed to remove member',
        'warning',
        3000,
      );
    } finally {
      setSubmitting(false);
    }
  };

  const confirmTransfer = async () => {
    if (!pendingTransfer) return;
    setSubmitting(true);
    try {
      await api.dm.transferOwnership(dmChannel.id, pendingTransfer.id);
      addToast(
        `Ownership transferred to ${pendingTransfer.displayName ?? parseFederatedUsername(pendingTransfer.username).baseName}`,
        'success',
        3000,
      );
      setPendingTransfer(null);
    } catch (err) {
      addToast(
        err instanceof Error ? err.message : 'Failed to transfer ownership',
        'warning',
        3000,
      );
    } finally {
      setSubmitting(false);
    }
  };

  const totalCount = dmChannel.members.length;

  // ── Render ─────────────────────────────────────────────────────────────
  // Width / surface mirror `MemberSidebar` so toggling visually swaps a
  // like-shaped column.
  return (
    <div
      data-dm-roster-panel
      className="w-60 bg-surface-members flex-shrink-0 overflow-y-auto select-none no-scrollbar hidden md:block border-l border-border-hard"
    >
      <div className="p-3">
        <h3
          data-dm-roster-header
          className="text-[10.5px] font-bold text-txt-tertiary uppercase tracking-[0.06em] px-2 mb-2"
        >
          Members — {totalCount}
        </h3>

        {ownerMember && (
          <div data-dm-roster-section="owner" className="mb-4">
            <h4 className="text-[10.5px] font-bold text-txt-tertiary uppercase tracking-[0.06em] px-2 mb-1">
              OWNER
            </h4>
            <DmMemberRow
              member={ownerMember}
              isOwner
              isSelf={!!authUser && isSelf(ownerMember, authUser)}
              callerIsOwner={callerIsOwner}
              isFriend={isFriendOfCaller(ownerMember)}
              showKebab
              onMenuAction={handleMenuAction}
            />
          </div>
        )}

        {onlineMembers.length > 0 && (
          <div data-dm-roster-section="online" className="mb-4">
            <h4 className="text-[10.5px] font-bold text-txt-tertiary uppercase tracking-[0.06em] px-2 mb-1">
              ONLINE — {onlineMembers.length}
            </h4>
            {onlineMembers.map((m) => (
              <DmMemberRow
                key={m.id}
                member={m}
                isOwner={false}
                isSelf={!!authUser && isSelf(m, authUser)}
                callerIsOwner={callerIsOwner}
                isFriend={isFriendOfCaller(m)}
                showKebab
                onMenuAction={handleMenuAction}
              />
            ))}
          </div>
        )}

        {offlineMembers.length > 0 && (
          <div data-dm-roster-section="offline" className="opacity-60">
            <h4 className="text-[10.5px] font-bold text-txt-tertiary uppercase tracking-[0.06em] px-2 mb-1">
              OFFLINE — {offlineMembers.length}
            </h4>
            {offlineMembers.map((m) => (
              <DmMemberRow
                key={m.id}
                member={m}
                isOwner={false}
                isSelf={!!authUser && isSelf(m, authUser)}
                callerIsOwner={callerIsOwner}
                isFriend={isFriendOfCaller(m)}
                showKebab
                onMenuAction={handleMenuAction}
              />
            ))}
          </div>
        )}
      </div>

      <ConfirmDialog
        isOpen={!!pendingKick}
        onClose={() => { if (!submitting) setPendingKick(null); }}
        onConfirm={confirmKick}
        title="Remove from Group"
        description={
          pendingKick
            ? `Remove ${pendingKick.displayName ?? parseFederatedUsername(pendingKick.username).baseName} from this group? They won't be able to see new messages.`
            : ''
        }
        confirmLabel="Remove"
        variant="danger"
        loading={submitting}
      />

      <ConfirmDialog
        isOpen={!!pendingTransfer}
        onClose={() => { if (!submitting) setPendingTransfer(null); }}
        onConfirm={confirmTransfer}
        title="Transfer Ownership"
        description={
          pendingTransfer
            ? `Transfer ownership to ${pendingTransfer.displayName ?? parseFederatedUsername(pendingTransfer.username).baseName}? You'll lose owner privileges.`
            : ''
        }
        confirmLabel="Transfer"
        variant="warning"
        loading={submitting}
      />
    </div>
  );
}
