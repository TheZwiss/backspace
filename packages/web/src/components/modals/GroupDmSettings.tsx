import React, { useState, useRef, useEffect, useMemo } from 'react';
import type { User } from '@backspace/shared';
import { Modal } from '../ui/Modal';
import { ImageCropModal } from '../ui/ImageCropModal';
import { ConfirmDialog } from '../ui/ConfirmDialog';
import { useUIStore } from '../../stores/uiStore';
import { useSpaceStore } from '../../stores/spaceStore';
import { useAuthStore } from '../../stores/authStore';
import { useSocialStore } from '../../stores/socialStore';
import { useTransferStore } from '../../stores/transferStore';
import { waitForTransferAttachment } from '../../utils/waitForTransfer';
import { api } from '../../api/client';
import { isSelf, parseFederatedUsername } from '../../utils/identity';
import { AvatarStack } from '../ui/AvatarStack';
import { DmMemberRow, type DmMemberRowAction } from '../layout/DmMemberRow';

const MAX_NAME_LENGTH = 50;
const MAX_GROUP_MEMBERS = 10;

type Tab = 'overview' | 'members';

/**
 * Settings modal for a group DM. Mirrors `SpaceSettings` structurally:
 *   - desktop: left rail (channel card + tab list) + content area
 *   - mobile: tab list, then content with a back button
 *
 * Reads its target channel from `useUIStore.modalData.dmChannelId`. Optional
 * `initialTab` selects which tab opens first.
 *
 * Owner detection: `dmChannel.ownerId === currentUser.id` — local id compare.
 * Non-owners see read-only fields (icon click is a no-op, name input disabled,
 * Save button absent). "Leave Group" is enabled for everyone.
 *
 * Save flow:
 *   1. If an icon blob is staged, upload it via transferStore.
 *   2. Build PATCH body with ONLY changed fields (name and/or icon).
 *      Cleared icon → `icon: null`.
 *   3. `api.dm.updateMetadata(channelId, body)` then close the modal.
 * Cancel discards the staged blob; no upload fires.
 */
export function GroupDmSettings() {
  const activeModal = useUIStore((s) => s.activeModal);
  const modalData = useUIStore((s) => s.modalData);
  const closeModal = useUIStore((s) => s.closeModal);
  const isMobile = useUIStore((s) => s.isMobile);
  const addToast = useUIStore((s) => s.addToast);

  const dmChannels = useSpaceStore((s) => s.dmChannels);
  const authUser = useAuthStore((s) => s.user);
  const friends = useSocialStore((s) => s.friends);

  const isOpen = activeModal === 'groupDmSettings';
  const dmChannelId = (modalData.dmChannelId as string | undefined) ?? null;
  const initialTab = (modalData.initialTab as Tab | undefined) ?? 'overview';

  const dmChannel = useMemo(
    () => dmChannels.find((dm) => dm.id === dmChannelId) ?? null,
    [dmChannels, dmChannelId],
  );

  // ── Tab + mobile pane state ────────────────────────────────────────────
  const [tab, setTab] = useState<Tab>(initialTab);
  const [mobileView, setMobileView] = useState<'tabs' | 'content'>('tabs');

  useEffect(() => {
    if (isOpen) {
      setTab(initialTab);
      setMobileView('tabs');
    }
  }, [isOpen, initialTab]);

  // ── Overview state ─────────────────────────────────────────────────────
  // `iconState`:
  //   'unchanged' — nothing staged; current dm.icon is in effect
  //   'cleared'   — owner clicked the X; will PATCH `icon: null`
  //   { blob, previewUrl } — owner cropped a fresh blob; deferred upload
  type IconState =
    | { kind: 'unchanged' }
    | { kind: 'cleared' }
    | { kind: 'staged'; blob: Blob; previewUrl: string };

  const [name, setName] = useState('');
  const [iconState, setIconState] = useState<IconState>({ kind: 'unchanged' });
  const [cropSrc, setCropSrc] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState('');
  const [confirmLeave, setConfirmLeave] = useState(false);
  const [leaving, setLeaving] = useState(false);
  // Member-action confirmation state lives at the same level as the rest of
  // the modal's hooks — declared up here so it stays before the early returns
  // below (React's rules-of-hooks forbid conditional hook calls).
  const [pendingKick, setPendingKick] = useState<User | null>(null);
  const [pendingTransfer, setPendingTransfer] = useState<User | null>(null);
  const [memberActionSubmitting, setMemberActionSubmitting] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Reset overview state when the modal opens or the underlying channel changes.
  // Revoking previously-staged preview URLs prevents memory leaks across opens.
  useEffect(() => {
    if (!isOpen || !dmChannel) return;
    setName(dmChannel.name ?? '');
    setIconState((prev) => {
      if (prev.kind === 'staged') URL.revokeObjectURL(prev.previewUrl);
      return { kind: 'unchanged' };
    });
    setSaveError('');
    setConfirmLeave(false);
  }, [isOpen, dmChannel?.id, dmChannel?.name]);

  // Final cleanup: revoke any lingering preview URL on unmount.
  useEffect(() => {
    return () => {
      setIconState((prev) => {
        if (prev.kind === 'staged') URL.revokeObjectURL(prev.previewUrl);
        return prev;
      });
    };
  }, []);

  if (!isOpen || !dmChannel || !dmChannelId) return null;
  // Group DMs only: this modal is meaningless for 1-on-1 conversations.
  if (!dmChannel.ownerId) return null;

  const isOwner = !!authUser && dmChannel.ownerId === authUser.id;

  const otherMembers: User[] = authUser
    ? dmChannel.members.filter((m) => !isSelf(m, authUser))
    : dmChannel.members;

  const fallbackName = otherMembers
    .map((m) => m.displayName ?? parseFederatedUsername(m.username).baseName)
    .join(', ');

  const currentName = dmChannel.name ?? '';
  const trimmedName = name.trim();
  const nameDirty = trimmedName !== currentName.trim();
  const iconDirty = iconState.kind !== 'unchanged';
  const isDirty = nameDirty || iconDirty;

  // What the AvatarStack should show: staged preview > cleared (=no icon) >
  // current dm.icon. Passing `null` falls through to the member-tile layout.
  const previewIconUrl: string | null | undefined =
    iconState.kind === 'staged'
      ? iconState.previewUrl
      : iconState.kind === 'cleared'
        ? null
        : (dmChannel.icon ?? null);

  // ── Icon handlers ──────────────────────────────────────────────────────
  const handleHeroClick = () => {
    if (!isOwner) return;
    fileInputRef.current?.click();
  };

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => setCropSrc(reader.result as string);
    reader.readAsDataURL(file);
    // Reset so picking the same file again re-fires onChange.
    if (fileInputRef.current) fileInputRef.current.value = '';
  };

  const handleCropComplete = (blob: Blob) => {
    setIconState((prev) => {
      if (prev.kind === 'staged') URL.revokeObjectURL(prev.previewUrl);
      const previewUrl = URL.createObjectURL(blob);
      return { kind: 'staged', blob, previewUrl };
    });
    setCropSrc(null);
  };

  const handleClearIcon = () => {
    if (!isOwner) return;
    setIconState((prev) => {
      if (prev.kind === 'staged') URL.revokeObjectURL(prev.previewUrl);
      return { kind: 'cleared' };
    });
  };

  // ── Save / Cancel / Leave ──────────────────────────────────────────────
  const handleCancel = () => {
    // Discard staged blob (no upload fired) and close.
    setIconState((prev) => {
      if (prev.kind === 'staged') URL.revokeObjectURL(prev.previewUrl);
      return { kind: 'unchanged' };
    });
    closeModal();
  };

  const handleSave = async () => {
    if (!isOwner || !isDirty || saving) return;
    setSaving(true);
    setSaveError('');
    try {
      const body: { name?: string | null; icon?: string | null } = {};

      if (nameDirty) {
        // Trimmed, enforced to MAX_NAME_LENGTH client-side; server re-validates.
        body.name = trimmedName.slice(0, MAX_NAME_LENGTH);
      }

      if (iconState.kind === 'cleared') {
        body.icon = null;
      } else if (iconState.kind === 'staged') {
        // Defer-to-save upload: only fires when the user commits the change.
        const file = new File([iconState.blob], 'dm-icon.webp', {
          type: iconState.blob.type || 'image/webp',
        });
        const tid = await useTransferStore.getState().startUpload(file, {
          tray: false,
        });
        const { filename } = await waitForTransferAttachment(tid);
        body.icon = filename;
      }

      await api.dm.updateMetadata(dmChannelId, body);
      // Mirror SpaceSettings save behavior: close the modal. The WS broadcast
      // (`dm_channel_updated`) updates the open channel in-place.
      closeModal();
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Failed to save settings';
      setSaveError(msg);
      addToast(msg, 'warning', 4000);
    } finally {
      setSaving(false);
    }
  };

  const handleLeaveClick = () => {
    setConfirmLeave(true);
  };

  const handleConfirmLeave = async () => {
    if (leaving) return;
    setLeaving(true);
    try {
      await api.dm.leave(dmChannelId);
      closeModal();
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Failed to leave group';
      addToast(msg, 'warning', 4000);
    } finally {
      setLeaving(false);
      setConfirmLeave(false);
    }
  };

  // ── Members panel data ────────────────────────────────────────────────
  // Friend lookup mirrors DmRosterPanel — local-id compare is federation-safe.
  const isFriendOfCaller = (m: User): boolean => friends.some((f) => f.id === m.id);

  const memberCount = dmChannel.members.length;
  const remainingSlots = MAX_GROUP_MEMBERS - memberCount;
  const canAddMembers = remainingSlots > 0;

  // Per-member action handler. The kebab is hidden in this view, but right-click
  // (and `View Profile`) still works via the same context-menu wiring.
  // (State for the two confirmation dialogs is declared up with the other hooks.)
  const handleMemberAction = async (action: DmMemberRowAction, member: User) => {
    if (action === 'profile') {
      // Fallback path — DmMemberRow normally opens the profile itself via
      // its own bounding rect. If we reach this branch, just route to a
      // top-left anchor (matches DmRosterPanel's fallback).
      useUIStore.getState().openUserProfile(member, { top: 100, left: 100 });
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
        await useSocialStore.getState().removeFriend(member.id);
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
    setMemberActionSubmitting(true);
    try {
      await api.dm.kickMember(dmChannelId, pendingKick.id);
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
      setMemberActionSubmitting(false);
    }
  };

  const confirmTransfer = async () => {
    if (!pendingTransfer) return;
    setMemberActionSubmitting(true);
    try {
      await api.dm.transferOwnership(dmChannelId, pendingTransfer.id);
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
      setMemberActionSubmitting(false);
    }
  };

  // ── Render helpers ─────────────────────────────────────────────────────
  const tabBtnClass = (t: Tab) =>
    `w-full text-left px-3 py-2 rounded-md text-sm transition-colors ${
      tab === t
        ? 'bg-interactive-selected text-txt-primary font-medium'
        : 'text-txt-tertiary hover:text-txt-secondary hover:bg-interactive-hover'
    }`;

  const handleTabClick = (t: Tab) => {
    setTab(t);
    if (isMobile) setMobileView('content');
  };

  const headerName = dmChannel.name && dmChannel.name.length > 0 ? dmChannel.name : (fallbackName || 'Group DM');

  // ── Overview panel ─────────────────────────────────────────────────────
  const overviewPanel = (
    <div className="space-y-5">
      <h2 className="text-lg font-semibold text-txt-primary mb-6">Overview</h2>

      {/* Hero icon */}
      <div className="flex flex-col items-center gap-3">
        <div className="relative">
          <button
            type="button"
            onClick={handleHeroClick}
            disabled={!isOwner}
            data-group-dm-icon-hero
            aria-label={isOwner ? 'Change group icon' : 'Group icon'}
            className={`relative block rounded-full overflow-hidden group ${
              isOwner ? 'cursor-pointer' : 'cursor-default'
            }`}
            style={{ width: 80, height: 80 }}
          >
            <AvatarStack
              members={otherMembers}
              size={80}
              border="modal"
              iconUrl={previewIconUrl}
            />
            {isOwner && (
              <div
                data-group-dm-icon-overlay
                className="absolute inset-0 rounded-full bg-black/50 opacity-0 group-hover:opacity-100 transition-opacity flex flex-col items-center justify-center text-white text-[10px] font-medium"
              >
                <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M3 9a2 2 0 012-2h.93a2 2 0 001.664-.89l.812-1.22A2 2 0 0110.07 4h3.86a2 2 0 011.664.89l.812 1.22A2 2 0 0018.07 7H19a2 2 0 012 2v9a2 2 0 01-2 2H5a2 2 0 01-2-2V9z" />
                  <path strokeLinecap="round" strokeLinejoin="round" d="M15 13a3 3 0 11-6 0 3 3 0 016 0z" />
                </svg>
                <span className="mt-1">Click to upload</span>
              </div>
            )}
          </button>

          {/* Clear (X) button — owner-only, only when we have a non-empty icon to clear */}
          {isOwner && previewIconUrl && (
            <button
              type="button"
              onClick={handleClearIcon}
              data-group-dm-icon-clear
              aria-label="Remove group icon"
              className="absolute -top-1 -right-1 w-6 h-6 rounded-full bg-surface-elevated border border-border-hard flex items-center justify-center text-txt-tertiary hover:text-txt-danger hover:bg-accent-rose/10 transition-colors"
            >
              <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor">
                <path d="M18.4 4L12 10.4L5.6 4L4 5.6L10.4 12L4 18.4L5.6 20L12 13.6L18.4 20L20 18.4L13.6 12L20 5.6L18.4 4Z" />
              </svg>
            </button>
          )}
        </div>

        <input
          ref={fileInputRef}
          type="file"
          accept="image/*"
          onChange={handleFileChange}
          className="hidden"
          aria-hidden="true"
          tabIndex={-1}
        />
      </div>

      {/* Group name */}
      <div>
        <label className="block text-[11px] font-semibold text-txt-tertiary uppercase tracking-wider mb-1.5">
          Group Name
        </label>
        <input
          type="text"
          value={name}
          onChange={(e) => setName(e.target.value.slice(0, MAX_NAME_LENGTH))}
          placeholder={fallbackName || 'Group DM'}
          disabled={!isOwner}
          maxLength={MAX_NAME_LENGTH}
          className="input-standard w-full"
          data-group-dm-name-input
          aria-label="Group name"
        />
        {isOwner && (
          <div className="text-[11px] text-txt-tertiary text-right mt-1">
            {trimmedName.length}/{MAX_NAME_LENGTH}
          </div>
        )}
      </div>

      {saveError && (
        <div className="p-2 bg-accent-rose/10 border border-accent-rose/30 rounded text-txt-danger text-sm">
          {saveError}
        </div>
      )}

      {/* Save / Cancel — owner only, only when dirty */}
      {isOwner && (
        <div className="flex items-center justify-end gap-2 pt-2">
          <button
            type="button"
            onClick={handleCancel}
            className="px-3 py-1.5 text-sm text-txt-tertiary hover:text-txt-secondary transition-colors"
            data-group-dm-cancel
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={handleSave}
            disabled={!isDirty || saving}
            className="px-4 py-1.5 bg-accent-primary hover:bg-accent-primary/80 text-white text-sm font-medium rounded-full transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
            data-group-dm-save
          >
            {saving ? 'Saving...' : 'Save'}
          </button>
        </div>
      )}

      {/* For non-owners: a single Close button (no Save). */}
      {!isOwner && (
        <div className="flex items-center justify-end gap-2 pt-2">
          <button
            type="button"
            onClick={closeModal}
            className="px-4 py-1.5 bg-surface-elevated hover:bg-interactive-hover text-txt-primary text-sm font-medium rounded-full transition-colors"
            data-group-dm-close
          >
            Close
          </button>
        </div>
      )}

      {/* Leave Group — destructive footer button, everyone */}
      <div className="pt-4 border-t border-border-soft">
        <div className="text-[11px] font-semibold text-txt-danger uppercase tracking-wider mb-1.5">
          Leave Group
        </div>
        <p className="text-xs text-txt-tertiary mb-3">
          You will stop receiving messages from this conversation. Other members will see a system message.
        </p>
        <button
          type="button"
          onClick={handleLeaveClick}
          disabled={leaving}
          className="px-4 py-2 bg-accent-rose hover:bg-accent-rose/80 text-white text-sm font-medium rounded transition-colors disabled:opacity-50"
          data-group-dm-leave
        >
          {leaving ? 'Leaving...' : 'Leave Group'}
        </button>
      </div>
    </div>
  );

  // ── Members panel ──────────────────────────────────────────────────────
  const ownerMember = dmChannel.members.find((m) => m.id === dmChannel.ownerId) ?? null;
  const sortByDisplayName = (a: User, b: User) => {
    const aName = (a.displayName ?? parseFederatedUsername(a.username).baseName).toLowerCase();
    const bName = (b.displayName ?? parseFederatedUsername(b.username).baseName).toLowerCase();
    return aName.localeCompare(bName);
  };
  const nonOwnerMembers = dmChannel.members
    .filter((m) => m.id !== dmChannel.ownerId)
    .sort(sortByDisplayName);

  const membersPanel = (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h2 className="text-lg font-semibold text-txt-primary">Members</h2>
        <span className="text-[12px] text-txt-tertiary">
          {memberCount}/{MAX_GROUP_MEMBERS}
        </span>
      </div>

      <button
        type="button"
        onClick={() => useUIStore.getState().openModal('addDmMember', { dmChannelId })}
        disabled={!canAddMembers}
        data-group-dm-add-member
        className="w-full flex items-center gap-2.5 px-3 py-2.5 rounded-md bg-accent-mint/10 hover:bg-accent-mint/20 text-accent-mint text-sm font-medium transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
      >
        <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
          <path d="M12 5v14M5 12h14" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
        </svg>
        Add Member
        {!canAddMembers && (
          <span className="ml-auto text-[11px] text-txt-tertiary">Group is full</span>
        )}
      </button>

      <div data-group-dm-member-list className="space-y-0.5">
        {ownerMember && (
          <DmMemberRow
            member={ownerMember}
            isOwner
            isSelf={!!authUser && isSelf(ownerMember, authUser)}
            callerIsOwner={isOwner}
            isFriend={isFriendOfCaller(ownerMember)}
            showKebab={false}
            onMenuAction={handleMemberAction}
          />
        )}
        {nonOwnerMembers.map((m) => (
          <DmMemberRow
            key={m.id}
            member={m}
            isOwner={false}
            isSelf={!!authUser && isSelf(m, authUser)}
            callerIsOwner={isOwner}
            isFriend={isFriendOfCaller(m)}
            showKebab={false}
            onMenuAction={handleMemberAction}
          />
        ))}
      </div>
    </div>
  );

  return (
    <Modal isOpen={isOpen} onClose={closeModal} size="settings" mobileStyle="fullscreen">
      <div className="flex h-full">
        {/* Desktop sidebar */}
        <div className="hidden md:flex w-52 flex-shrink-0 flex-col p-4 gap-3">
          {/* Channel card */}
          <div className="glass-bubble rounded-lg p-3 flex items-center gap-3">
            <AvatarStack
              members={otherMembers}
              size={36}
              border="modal"
              iconUrl={dmChannel.icon}
            />
            <div className="min-w-0">
              <div className="text-sm font-medium text-txt-primary truncate">{headerName}</div>
            </div>
          </div>

          {/* Nav list */}
          <div className="glass-bubble rounded-lg p-2 flex-1 flex flex-col">
            <div className="text-[10px] font-semibold text-txt-tertiary uppercase tracking-wider px-3 py-1">
              General
            </div>
            <button type="button" onClick={() => handleTabClick('overview')} className={tabBtnClass('overview')}>
              Overview
            </button>
            <button type="button" onClick={() => handleTabClick('members')} className={tabBtnClass('members')}>
              Members
            </button>
          </div>
        </div>

        {/* Mobile: tab list */}
        {isMobile && mobileView === 'tabs' && (
          <div className="flex-1 overflow-y-auto p-4 space-y-3">
            <div className="glass-bubble rounded-lg p-3 flex items-center gap-3">
              <AvatarStack
                members={otherMembers}
                size={36}
                border="modal"
                iconUrl={dmChannel.icon}
              />
              <div className="min-w-0">
                <div className="text-sm font-medium text-txt-primary truncate">{headerName}</div>
              </div>
            </div>

            <div className="glass-bubble rounded-lg p-2 space-y-0.5">
              <div className="text-[10px] font-semibold text-txt-tertiary uppercase tracking-wider px-3 py-1">
                General
              </div>
              <button type="button" onClick={() => handleTabClick('overview')} className={tabBtnClass('overview')}>
                Overview
              </button>
              <button type="button" onClick={() => handleTabClick('members')} className={tabBtnClass('members')}>
                Members
              </button>
            </div>
          </div>
        )}

        {/* Content area */}
        {(!isMobile || mobileView === 'content') && (
          <div className="flex-1 min-w-0 overflow-y-auto scrollbar-thin py-6">
            <div className="px-6 max-w-[640px] mx-auto">
              {isMobile && (
                <button
                  type="button"
                  onClick={() => setMobileView('tabs')}
                  className="flex items-center gap-1.5 text-txt-tertiary hover:text-txt-secondary mb-4 text-sm"
                  aria-label="Back to group DM settings menu"
                >
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
                    <path d="M20 11H7.83l5.59-5.59L12 4l-8 8 8 8 1.41-1.41L7.83 13H20v-2z" />
                  </svg>
                  Group Settings
                </button>
              )}
              {tab === 'overview' && overviewPanel}
              {tab === 'members' && membersPanel}
            </div>
          </div>
        )}
      </div>

      {/* Image cropper for new icons (1:1 ratio, matches space-icon convention) */}
      <ImageCropModal
        isOpen={cropSrc !== null}
        onClose={() => setCropSrc(null)}
        imageSrc={cropSrc ?? ''}
        onCropComplete={handleCropComplete}
        title="Crop Group Icon"
        cropShape="round"
        aspectRatio={1}
        maxOutputDimension={256}
      />

      {/* Confirmations for member-row actions and Leave Group */}
      <ConfirmDialog
        isOpen={confirmLeave}
        onClose={() => { if (!leaving) setConfirmLeave(false); }}
        onConfirm={handleConfirmLeave}
        title="Leave Group"
        description={`Leave "${headerName}"? You will stop receiving messages from this conversation.`}
        confirmLabel="Leave"
        variant="danger"
        loading={leaving}
      />

      <ConfirmDialog
        isOpen={!!pendingKick}
        onClose={() => { if (!memberActionSubmitting) setPendingKick(null); }}
        onConfirm={confirmKick}
        title="Remove from Group"
        description={
          pendingKick
            ? `Remove ${pendingKick.displayName ?? parseFederatedUsername(pendingKick.username).baseName} from this group? They won't be able to see new messages.`
            : ''
        }
        confirmLabel="Remove"
        variant="danger"
        loading={memberActionSubmitting}
      />

      <ConfirmDialog
        isOpen={!!pendingTransfer}
        onClose={() => { if (!memberActionSubmitting) setPendingTransfer(null); }}
        onConfirm={confirmTransfer}
        title="Transfer Ownership"
        description={
          pendingTransfer
            ? `Transfer ownership to ${pendingTransfer.displayName ?? parseFederatedUsername(pendingTransfer.username).baseName}? You'll lose owner privileges.`
            : ''
        }
        confirmLabel="Transfer"
        variant="warning"
        loading={memberActionSubmitting}
      />
    </Modal>
  );
}
