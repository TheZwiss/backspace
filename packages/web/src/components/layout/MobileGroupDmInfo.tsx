import React, { useEffect, useMemo, useRef, useState } from 'react';
import type { DmChannel, User } from '@backspace/shared';
import { useUIStore } from '../../stores/uiStore';
import { useSpaceStore } from '../../stores/spaceStore';
import { useAuthStore } from '../../stores/authStore';
import { useSocialStore } from '../../stores/socialStore';
import { useTransferStore } from '../../stores/transferStore';
import { waitForTransferAttachment } from '../../utils/waitForTransfer';
import { api } from '../../api/client';
import { isSelf, parseFederatedUsername, isFederationGlobeApplicable } from '../../utils/identity';
import { useVisualViewportInset } from '../../hooks/useVisualViewportInset';
import { AvatarStack } from '../ui/AvatarStack';
import { ImageCropModal } from '../ui/ImageCropModal';
import { ConfirmDialog } from '../ui/ConfirmDialog';
import { MobileScreenHeader } from './MobileScreenHeader';
import { DmMemberRow, type DmMemberRowAction } from './DmMemberRow';

const MAX_NAME_LENGTH = 50;
const MAX_GROUP_MEMBERS = 10;

/**
 * Iconography for the federation globe shown next to the group name on mobile.
 * No tooltip on mobile — the dedicated info screen surfaces federation
 * identity via the per-member rows, so the global indicator is intentionally
 * decorative here.
 */
function GroupGlobeIcon() {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="currentColor"
      className="text-txt-tertiary/80 flex-shrink-0"
      aria-hidden="true"
    >
      <path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-1 17.93c-3.95-.49-7-3.85-7-7.93 0-.62.08-1.21.21-1.79L9 15v1c0 1.1.9 2 2 2v1.93zm6.9-2.54c-.26-.81-1-1.39-1.9-1.39h-1v-3c0-.55-.45-1-1-1H8v-2h2c.55 0 1-.45 1-1V7h2c1.1 0 2-.9 2-2v-.41c2.93 1.19 5 4.06 5 7.41 0 2.08-.8 3.97-2.1 5.39z" />
    </svg>
  );
}

/** Sort helper — alphabetical by display-name fallback, lower-cased. */
function sortByDisplayName(a: User, b: User): number {
  const aName = (a.displayName ?? parseFederatedUsername(a.username).baseName).toLowerCase();
  const bName = (b.displayName ?? parseFederatedUsername(b.username).baseName).toLowerCase();
  return aName.localeCompare(bName);
}

interface MobileGroupDmInfoProps {
  params?: Record<string, string>;
}

/**
 * Pushed mobile screen for group DM info + management.
 *
 * Mirrors `MobileMembersScreen` geometry (header + scrollable body) and
 * surfaces the same surface area as the desktop `GroupDmSettings` modal +
 * `DmRosterPanel`, condensed into a single column. The Edit button toggles an
 * **in-place** edit mode inside the hero — this avoids pushing yet another
 * screen on top of the screen stack (an anti-pattern in MobileScreenStack).
 *
 * Reads its target channel from `params.channelId`, set by the caller (e.g.
 * `MobileChatScreen`'s members button).
 */
export function MobileGroupDmInfo({ params }: MobileGroupDmInfoProps) {
  const channelId = params?.channelId ?? null;

  const dmChannels = useSpaceStore((s) => s.dmChannels);
  const authUser = useAuthStore((s) => s.user);
  const friends = useSocialStore((s) => s.friends);
  const openModal = useUIStore((s) => s.openModal);
  const popMobileScreen = useUIStore((s) => s.popMobileScreen);
  const pushMobileScreen = useUIStore((s) => s.pushMobileScreen);
  const addToast = useUIStore((s) => s.addToast);

  const dmChannel = useMemo(
    () => dmChannels.find((dm) => dm.id === channelId) ?? null,
    [dmChannels, channelId],
  );

  // ── Inline edit state ──────────────────────────────────────────────────
  type IconState =
    | { kind: 'unchanged' }
    | { kind: 'cleared' }
    | { kind: 'staged'; blob: Blob; previewUrl: string };

  const [editing, setEditing] = useState(false);
  const [name, setName] = useState('');
  const [iconState, setIconState] = useState<IconState>({ kind: 'unchanged' });
  const [cropSrc, setCropSrc] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState('');
  const fileInputRef = useRef<HTMLInputElement>(null);

  // ── Destructive confirms (kick + transfer + leave) ─────────────────────
  const [pendingKick, setPendingKick] = useState<User | null>(null);
  const [pendingTransfer, setPendingTransfer] = useState<User | null>(null);
  const [submittingMemberAction, setSubmittingMemberAction] = useState(false);
  const [confirmLeave, setConfirmLeave] = useState(false);
  const [leaving, setLeaving] = useState(false);

  // ── iOS keyboard-aware Save/Cancel bar ─────────────────────────────────
  // `useVisualViewportInset` returns a CSS value that resolves to
  // `env(safe-area-inset-bottom)` when no keyboard is open, or `<n>px` of
  // occlusion when one is. We paste that straight into the bar's `bottom`
  // style so it rides above the soft keyboard on iOS PWA.
  const { value: bottomInset, keyboardOpen } = useVisualViewportInset();

  // Reset edit state whenever the channel changes or edit mode opens.
  useEffect(() => {
    if (!dmChannel) return;
    if (editing) {
      setName(dmChannel.name ?? '');
      setIconState((prev) => {
        if (prev.kind === 'staged') URL.revokeObjectURL(prev.previewUrl);
        return { kind: 'unchanged' };
      });
      setSaveError('');
    }
  }, [editing, dmChannel?.id, dmChannel?.name]);

  // Final cleanup: revoke any lingering preview URL on unmount.
  useEffect(() => {
    return () => {
      setIconState((prev) => {
        if (prev.kind === 'staged') URL.revokeObjectURL(prev.previewUrl);
        return prev;
      });
    };
  }, []);

  // ── Empty / non-group safety ───────────────────────────────────────────
  if (!dmChannel) {
    return (
      <div className="flex flex-col h-full bg-surface-base">
        <MobileScreenHeader title="Group Info" />
        <div className="flex-1 flex items-center justify-center text-txt-tertiary text-sm">
          Conversation not found.
        </div>
      </div>
    );
  }
  // This screen is meaningless for 1-on-1 DMs.
  if (!dmChannel.ownerId) {
    return (
      <div className="flex flex-col h-full bg-surface-base">
        <MobileScreenHeader title="Info" />
        <div className="flex-1 flex items-center justify-center text-txt-tertiary text-sm">
          This conversation has no group info.
        </div>
      </div>
    );
  }

  const isOwner = !!authUser && dmChannel.ownerId === authUser.id;

  const otherMembers: User[] = authUser
    ? dmChannel.members.filter((m) => !isSelf(m, authUser))
    : dmChannel.members;

  const fallbackName = otherMembers
    .map((m) => m.displayName ?? parseFederatedUsername(m.username).baseName)
    .join(', ');

  const displayName = dmChannel.name && dmChannel.name.length > 0 ? dmChannel.name : fallbackName || 'Group DM';

  const currentName = dmChannel.name ?? '';
  const trimmedName = name.trim();
  const nameDirty = trimmedName !== currentName.trim();
  const iconDirty = iconState.kind !== 'unchanged';
  const isDirty = nameDirty || iconDirty;

  const previewIconUrl: string | null | undefined =
    iconState.kind === 'staged'
      ? iconState.previewUrl
      : iconState.kind === 'cleared'
        ? null
        : (dmChannel.icon ?? null);

  // Show the global federation globe next to the group name when any member
  // (besides self) is federated. Mobile intentionally omits the tooltip —
  // per-member rows below carry the federation identity explicitly.
  const hasFederatedMember = otherMembers.some((m) => isFederationGlobeApplicable(m));

  // Member buckets — owner first, then online/offline alphabetically.
  const ownerMember = dmChannel.members.find((m) => m.id === dmChannel.ownerId) ?? null;
  const nonOwnerMembers = dmChannel.members.filter((m) => m.id !== dmChannel.ownerId);
  const onlineMembers = nonOwnerMembers
    .filter((m) => m.status !== 'offline')
    .sort(sortByDisplayName);
  const offlineMembers = nonOwnerMembers
    .filter((m) => m.status === 'offline')
    .sort(sortByDisplayName);

  const memberCount = dmChannel.members.length;
  const canAddMembers = memberCount < MAX_GROUP_MEMBERS;

  // Friend lookup — federation-safe local-id compare (mirrors DmRosterPanel).
  const isFriendOfCaller = (m: User): boolean => friends.some((f) => f.id === m.id);

  // ── Icon handlers ──────────────────────────────────────────────────────
  const handleHeroClick = () => {
    if (!editing || !isOwner) return;
    fileInputRef.current?.click();
  };

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => setCropSrc(reader.result as string);
    reader.readAsDataURL(file);
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

  // ── Save / Cancel ─────────────────────────────────────────────────────
  const handleCancel = () => {
    setIconState((prev) => {
      if (prev.kind === 'staged') URL.revokeObjectURL(prev.previewUrl);
      return { kind: 'unchanged' };
    });
    setSaveError('');
    setEditing(false);
  };

  const handleSave = async () => {
    if (!channelId || !isOwner || !isDirty || saving) return;
    setSaving(true);
    setSaveError('');
    try {
      const body: { name?: string | null; icon?: string | null } = {};

      if (nameDirty) {
        body.name = trimmedName.slice(0, MAX_NAME_LENGTH);
      }

      if (iconState.kind === 'cleared') {
        body.icon = null;
      } else if (iconState.kind === 'staged') {
        const file = new File([iconState.blob], 'dm-icon.webp', {
          type: iconState.blob.type || 'image/webp',
        });
        const tid = await useTransferStore.getState().startUpload(file, {
          tray: false,
        });
        const { filename } = await waitForTransferAttachment(tid);
        body.icon = filename;
      }

      await api.dm.updateMetadata(channelId, body);
      // Reset state and exit edit mode. The WS `dm_channel_updated` event
      // will refresh `dmChannels` in-place.
      setIconState((prev) => {
        if (prev.kind === 'staged') URL.revokeObjectURL(prev.previewUrl);
        return { kind: 'unchanged' };
      });
      setEditing(false);
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Failed to save settings';
      setSaveError(msg);
      addToast(msg, 'warning', 4000);
    } finally {
      setSaving(false);
    }
  };

  // ── Leave ──────────────────────────────────────────────────────────────
  const handleConfirmLeave = async () => {
    if (!channelId || leaving) return;
    setLeaving(true);
    try {
      await api.dm.leave(channelId);
      // Return to the previous screen (typically MobileDmsScreen via
      // MobileChatScreen). The user is no longer a member.
      popMobileScreen();
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Failed to leave group';
      addToast(msg, 'warning', 4000);
    } finally {
      setLeaving(false);
      setConfirmLeave(false);
    }
  };

  // ── Per-member action handler ──────────────────────────────────────────
  const handleMemberAction = async (action: DmMemberRowAction, member: User) => {
    if (action === 'profile') {
      // DmMemberRow normally opens the profile itself. Fallback path —
      // push the mobile user-profile screen directly.
      pushMobileScreen('user-profile', { userId: member.id });
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
    if (!pendingKick || !channelId) return;
    setSubmittingMemberAction(true);
    try {
      await api.dm.kickMember(channelId, pendingKick.id);
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
      setSubmittingMemberAction(false);
    }
  };

  const confirmTransfer = async () => {
    if (!pendingTransfer || !channelId) return;
    setSubmittingMemberAction(true);
    try {
      await api.dm.transferOwnership(channelId, pendingTransfer.id);
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
      setSubmittingMemberAction(false);
    }
  };

  // ── Render helpers ─────────────────────────────────────────────────────
  const renderMemberRow = (member: User, ownerFlag: boolean) => (
    <DmMemberRow
      key={member.id}
      member={member}
      isOwner={ownerFlag}
      isSelf={!!authUser && isSelf(member, authUser)}
      callerIsOwner={isOwner}
      isFriend={isFriendOfCaller(member)}
      showKebab
      alwaysShowKebab
      onMenuAction={handleMemberAction}
    />
  );

  // The header acts as the back button. When in edit mode we add a `Cancel`
  // text action on the right — pairs with the Save/Cancel bar at the bottom
  // (intentional duplication so a tap-target is always reachable above the
  // keyboard).
  const headerRight = editing ? (
    <button
      type="button"
      onClick={handleCancel}
      className="px-2 py-1 text-sm text-txt-tertiary hover:text-txt-secondary"
      data-mobile-edit-cancel
      aria-label="Cancel edit"
    >
      Cancel
    </button>
  ) : null;

  // ── Render ─────────────────────────────────────────────────────────────
  return (
    <div className="flex flex-col h-full bg-surface-base">
      <MobileScreenHeader title="Group Info" rightActions={headerRight} />

      <div
        className="flex-1 overflow-y-auto"
        // Reserve room for the Save/Cancel bar when it's pinned to the
        // bottom — otherwise the destructive footer can hide under it.
        style={editing ? { paddingBottom: keyboardOpen ? 72 : 96 } : undefined}
      >
        {/* HERO ────────────────────────────────────────────────────────── */}
        <div className="flex flex-col items-center gap-3 px-4 pt-8 pb-6 border-b border-border-soft">
          <div className="relative">
            <button
              type="button"
              onClick={handleHeroClick}
              disabled={!editing || !isOwner}
              data-mobile-group-icon-hero
              aria-label={editing && isOwner ? 'Change group icon' : 'Group icon'}
              className={`relative block rounded-full overflow-hidden ${
                editing && isOwner ? 'cursor-pointer' : 'cursor-default'
              }`}
              style={{ width: 80, height: 80 }}
            >
              <AvatarStack
                members={otherMembers}
                size={80}
                border="chat"
                iconUrl={previewIconUrl}
              />
            </button>

            {/* Clear (X) — owner-only, edit mode only, only when there's an icon to clear. */}
            {editing && isOwner && previewIconUrl && (
              <button
                type="button"
                onClick={handleClearIcon}
                data-mobile-group-icon-clear
                aria-label="Remove group icon"
                className="absolute -top-1 -right-1 w-6 h-6 rounded-full bg-surface-elevated border border-border-hard flex items-center justify-center text-txt-tertiary hover:text-txt-danger hover:bg-accent-rose/10 transition-colors"
              >
                <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor">
                  <path d="M18.4 4L12 10.4L5.6 4L4 5.6L10.4 12L4 18.4L5.6 20L12 13.6L18.4 20L20 18.4L13.6 12L20 5.6L18.4 4Z" />
                </svg>
              </button>
            )}

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

          {/* Name — input in edit mode, header otherwise. */}
          {editing ? (
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value.slice(0, MAX_NAME_LENGTH))}
              placeholder={fallbackName || 'Group DM'}
              maxLength={MAX_NAME_LENGTH}
              disabled={!isOwner}
              data-mobile-group-name-input
              aria-label="Group name"
              className="input-standard w-full max-w-[280px] text-center text-base"
            />
          ) : (
            <div className="flex items-center justify-center gap-1.5 max-w-full">
              <h1
                data-mobile-group-name
                className="text-xl font-semibold text-txt-primary text-center truncate max-w-[260px]"
                title={displayName}
              >
                {displayName}
              </h1>
              {hasFederatedMember && (
                <span data-mobile-group-globe className="inline-flex" aria-label="Federated group">
                  <GroupGlobeIcon />
                </span>
              )}
            </div>
          )}

          <p className="text-xs text-txt-tertiary">
            {memberCount} {memberCount === 1 ? 'member' : 'members'}
          </p>

          {/* Edit toggle — owner-only, hidden during edit (Cancel header action takes its place). */}
          {isOwner && !editing && (
            <button
              type="button"
              onClick={() => setEditing(true)}
              data-mobile-group-edit
              className="mt-1 px-4 py-1.5 rounded-full bg-surface-elevated hover:bg-interactive-hover text-txt-secondary text-xs font-medium transition-colors"
            >
              Edit
            </button>
          )}

          {saveError && editing && (
            <div className="w-full max-w-[280px] mt-1 p-2 bg-accent-rose/10 border border-accent-rose/30 rounded text-txt-danger text-xs text-center">
              {saveError}
            </div>
          )}
        </div>

        {/* ACTIONS ROW ──────────────────────────────────────────────────── */}
        <div className="px-4 py-3 border-b border-border-soft">
          <button
            type="button"
            onClick={() => channelId && openModal('addDmMember', { dmChannelId: channelId })}
            disabled={!canAddMembers}
            data-mobile-group-add-member
            className="w-full flex items-center justify-center gap-2 px-3 py-2.5 rounded-md bg-accent-mint/10 hover:bg-accent-mint/20 text-accent-mint text-sm font-medium transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
              <path d="M12 5v14M5 12h14" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
            </svg>
            Add Member
            {!canAddMembers && (
              <span className="text-[11px] text-txt-tertiary">— Group is full</span>
            )}
          </button>
        </div>

        {/* MEMBERS LIST ─────────────────────────────────────────────────── */}
        <div className="p-3">
          {ownerMember && (
            <div data-mobile-group-section="owner" className="mb-4">
              <h3 className="text-[10.5px] font-bold text-txt-tertiary uppercase tracking-[0.06em] px-2 mb-1">
                OWNER
              </h3>
              {renderMemberRow(ownerMember, true)}
            </div>
          )}

          {onlineMembers.length > 0 && (
            <div data-mobile-group-section="online" className="mb-4">
              <h3 className="text-[10.5px] font-bold text-txt-tertiary uppercase tracking-[0.06em] px-2 mb-1">
                ONLINE — {onlineMembers.length}
              </h3>
              {onlineMembers.map((m) => renderMemberRow(m, false))}
            </div>
          )}

          {offlineMembers.length > 0 && (
            <div data-mobile-group-section="offline" className="opacity-60">
              <h3 className="text-[10.5px] font-bold text-txt-tertiary uppercase tracking-[0.06em] px-2 mb-1">
                OFFLINE — {offlineMembers.length}
              </h3>
              {offlineMembers.map((m) => renderMemberRow(m, false))}
            </div>
          )}
        </div>

        {/* DESTRUCTIVE FOOTER ────────────────────────────────────────────── */}
        <div className="px-4 py-4 border-t border-border-soft">
          <button
            type="button"
            onClick={() => setConfirmLeave(true)}
            disabled={leaving}
            data-mobile-group-leave
            className="w-full px-4 py-2.5 text-accent-rose hover:bg-accent-rose/10 text-sm font-medium rounded-md transition-colors disabled:opacity-50"
          >
            {leaving ? 'Leaving...' : 'Leave Group'}
          </button>
        </div>
      </div>

      {/* Save / Cancel bar — pinned to the visual viewport bottom so the
          iOS soft keyboard doesn't occlude it. Mounted only in edit mode. */}
      {editing && (
        <div
          data-mobile-group-edit-bar
          className="fixed left-0 right-0 z-30 bg-surface-base border-t border-border-hard px-4 py-3 flex items-center justify-end gap-2"
          style={{ bottom: bottomInset }}
        >
          <button
            type="button"
            onClick={handleCancel}
            disabled={saving}
            className="px-3 py-1.5 text-sm text-txt-tertiary hover:text-txt-secondary transition-colors disabled:opacity-50"
            data-mobile-group-save-cancel
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={handleSave}
            disabled={!isDirty || saving || !isOwner}
            className="px-4 py-1.5 bg-accent-primary hover:bg-accent-primary/80 text-white text-sm font-medium rounded-full transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
            data-mobile-group-save
          >
            {saving ? 'Saving...' : 'Save'}
          </button>
        </div>
      )}

      {/* Cropper for new icons — 1:1, 256px max, matches GroupDmSettings. */}
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

      {/* Destructive confirms — leave + kick + transfer */}
      <ConfirmDialog
        isOpen={confirmLeave}
        onClose={() => { if (!leaving) setConfirmLeave(false); }}
        onConfirm={handleConfirmLeave}
        title="Leave Group"
        description={`Leave "${displayName}"? You will stop receiving messages from this conversation.`}
        confirmLabel="Leave"
        variant="danger"
        loading={leaving}
      />

      <ConfirmDialog
        isOpen={!!pendingKick}
        onClose={() => { if (!submittingMemberAction) setPendingKick(null); }}
        onConfirm={confirmKick}
        title="Remove from Group"
        description={
          pendingKick
            ? `Remove ${pendingKick.displayName ?? parseFederatedUsername(pendingKick.username).baseName} from this group? They won't be able to see new messages.`
            : ''
        }
        confirmLabel="Remove"
        variant="danger"
        loading={submittingMemberAction}
      />

      <ConfirmDialog
        isOpen={!!pendingTransfer}
        onClose={() => { if (!submittingMemberAction) setPendingTransfer(null); }}
        onConfirm={confirmTransfer}
        title="Transfer Ownership"
        description={
          pendingTransfer
            ? `Transfer ownership to ${pendingTransfer.displayName ?? parseFederatedUsername(pendingTransfer.username).baseName}? You'll lose owner privileges.`
            : ''
        }
        confirmLabel="Transfer"
        variant="warning"
        loading={submittingMemberAction}
      />
    </div>
  );
}

// Re-export the DmChannel shape for downstream test fixtures (kept tiny).
export type { DmChannel };
