import React, { useState, useRef, useEffect, useMemo } from 'react';
import { ImageCropModal } from '../../ui/ImageCropModal';
import { getSpaceGradient, SPACE_GRADIENT_MAP } from '../../../utils/gradients';
import { AVATAR_COLORS } from '@backspace/shared';
import type { AvatarColor } from '@backspace/shared';
import { useSpaceStore } from '../../../stores/spaceStore';
import { useAuthStore } from '../../../stores/authStore';
import { useUIStore } from '../../../stores/uiStore';
import { useNavigate } from 'react-router-dom';
import { api } from '../../../api/client';
import { getApiForOrigin, getMyUserIdForOrigin } from '../../../stores/spaceStore';
import { hasPermissionBit, PermissionBits } from '../../../utils/permissions';

interface OverviewPanelProps {
  spaceId: string;
}

export function OverviewPanel({ spaceId }: OverviewPanelProps) {
  const spaces = useSpaceStore((s) => s.spaces);
  const updateSpace = useSpaceStore((s) => s.updateSpace);
  const deleteSpace = useSpaceStore((s) => s.deleteSpace);
  const currentUser = useAuthStore((s) => s.user);
  const closeModal = useUIStore((s) => s.closeModal);
  const spacePermissions = useSpaceStore((s) => s.spacePermissions);
  const navigate = useNavigate();

  const space = spaces.find((s) => s.id === spaceId);
  const isOwner = space?.ownerId === getMyUserIdForOrigin((space as any)?._instanceOrigin ?? '');
  const myPerms = spacePermissions.get(spaceId);
  const canManageSpace = hasPermissionBit(myPerms, PermissionBits.MANAGE_SPACE);

  const [spaceName, setSpaceName] = useState(space?.name ?? '');
  // null = no change, '' = remove, 'filename.png' = new uploaded
  const [iconFilename, setIconFilename] = useState<string | null>(null);
  const [iconPreview, setIconPreview] = useState<string | null>(null);
  const [uploadingIcon, setUploadingIcon] = useState(false);
  const [cropSrc, setCropSrc] = useState<string | null>(null);

  // Banner state (same pattern as icon)
  const [bannerFilename, setBannerFilename] = useState<string | null>(null);
  const [bannerPreview, setBannerPreview] = useState<string | null>(null);
  const [uploadingBanner, setUploadingBanner] = useState(false);
  const [bannerCropSrc, setBannerCropSrc] = useState<string | null>(null);
  const bannerFileInputRef = useRef<HTMLInputElement>(null);

  const [avatarColorState, setAvatarColorState] = useState<AvatarColor | null>(space?.avatarColor ?? null);

  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState('');
  const [saveSuccess, setSaveSuccess] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Transfer ownership state
  const members = useSpaceStore((s) => s.members);
  const transferOwnership = useSpaceStore((s) => s.transferOwnership);
  const addToast = useUIStore((s) => s.addToast);
  const [showTransfer, setShowTransfer] = useState(false);
  const [transferSearch, setTransferSearch] = useState('');
  const [transferTargetId, setTransferTargetId] = useState<string | null>(null);
  const [transferring, setTransferring] = useState(false);

  useEffect(() => {
    if (space) {
      setSpaceName(space.name);
      setAvatarColorState(space.avatarColor ?? null);
      setIconFilename(null);
      if (iconPreview) {
        URL.revokeObjectURL(iconPreview);
        setIconPreview(null);
      }
      setBannerFilename(null);
      if (bannerPreview) {
        URL.revokeObjectURL(bannerPreview);
        setBannerPreview(null);
      }
    }
  }, [space?.name, space?.icon, space?.banner, space?.avatarColor]);

  if (!space) return null;

  const hasNameChange = spaceName.trim() !== space.name;
  const hasIconChange = iconFilename !== null;
  const hasBannerChange = bannerFilename !== null;
  const hasAvatarColorChange = avatarColorState !== (space.avatarColor ?? null);
  const hasChanges = hasNameChange || hasIconChange || hasBannerChange || hasAvatarColorChange;

  const currentIconUrl = space.icon
    ? (space.icon.startsWith('http') ? space.icon : api.uploads.url(space.icon))
    : null;

  const currentBannerUrl = space.banner
    ? (space.banner.startsWith('http') ? space.banner : api.uploads.url(space.banner))
    : null;

  // ─── Icon handlers ────────────────────────────────────────────────────────

  const handleIconSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => setCropSrc(reader.result as string);
    reader.readAsDataURL(file);
    if (fileInputRef.current) fileInputRef.current.value = '';
  };

  const handleCropComplete = async (blob: Blob) => {
    if (iconPreview) URL.revokeObjectURL(iconPreview);
    const previewUrl = URL.createObjectURL(blob);
    setIconPreview(previewUrl);
    setCropSrc(null);

    const file = new File([blob], 'icon.webp', { type: blob.type || 'image/webp' });
    setUploadingIcon(true);
    try {
      const spaceApi = getApiForOrigin(space._instanceOrigin);
      const attachment = await spaceApi.uploads.upload(file);
      setIconFilename(attachment.filename);
    } catch {
      setSaveError('Failed to upload icon');
      setIconPreview(null);
      URL.revokeObjectURL(previewUrl);
    } finally {
      setUploadingIcon(false);
    }
  };

  const handleRemoveIcon = () => {
    if (iconPreview) URL.revokeObjectURL(iconPreview);
    setIconPreview(null);
    setIconFilename('');
  };

  // ─── Banner handlers ──────────────────────────────────────────────────────

  const handleBannerSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => setBannerCropSrc(reader.result as string);
    reader.readAsDataURL(file);
    if (bannerFileInputRef.current) bannerFileInputRef.current.value = '';
  };

  const handleBannerCropComplete = async (blob: Blob) => {
    if (bannerPreview) URL.revokeObjectURL(bannerPreview);
    const previewUrl = URL.createObjectURL(blob);
    setBannerPreview(previewUrl);
    setBannerCropSrc(null);

    const file = new File([blob], 'banner.webp', { type: blob.type || 'image/webp' });
    setUploadingBanner(true);
    try {
      const spaceApi = getApiForOrigin(space._instanceOrigin);
      const attachment = await spaceApi.uploads.upload(file);
      setBannerFilename(attachment.filename);
    } catch {
      setSaveError('Failed to upload banner');
      setBannerPreview(null);
      URL.revokeObjectURL(previewUrl);
    } finally {
      setUploadingBanner(false);
    }
  };

  const handleRemoveBanner = () => {
    if (bannerPreview) URL.revokeObjectURL(bannerPreview);
    setBannerPreview(null);
    setBannerFilename('');
  };

  // ─── Save / Discard / Delete ──────────────────────────────────────────────

  const handleSave = async () => {
    setSaving(true);
    setSaveError('');
    setSaveSuccess(false);
    try {
      const updates: { name?: string; icon?: string; banner?: string; avatarColor?: string } = {};
      if (hasNameChange) updates.name = spaceName.trim();
      if (hasIconChange) {
        updates.icon = iconFilename === '' ? '' : iconFilename!;
      }
      if (hasBannerChange) {
        updates.banner = bannerFilename === '' ? '' : bannerFilename!;
      }
      if (hasAvatarColorChange) {
        updates.avatarColor = avatarColorState ?? '';
      }
      await updateSpace(spaceId, updates);
      setIconFilename(null);
      if (iconPreview) {
        URL.revokeObjectURL(iconPreview);
        setIconPreview(null);
      }
      setBannerFilename(null);
      if (bannerPreview) {
        URL.revokeObjectURL(bannerPreview);
        setBannerPreview(null);
      }
      setSaveSuccess(true);
      setTimeout(() => setSaveSuccess(false), 2000);
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : 'Failed to save');
    } finally {
      setSaving(false);
    }
  };

  const handleDiscard = () => {
    setSpaceName(space.name);
    setAvatarColorState(space.avatarColor ?? null);
    setIconFilename(null);
    if (iconPreview) {
      URL.revokeObjectURL(iconPreview);
      setIconPreview(null);
    }
    setBannerFilename(null);
    if (bannerPreview) {
      URL.revokeObjectURL(bannerPreview);
      setBannerPreview(null);
    }
    setSaveError('');
  };

  const handleDelete = async () => {
    if (!confirmDelete) {
      setConfirmDelete(true);
      return;
    }
    try {
      await deleteSpace(spaceId);
      closeModal();
      navigate('/channels/@me');
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : 'Failed to delete space');
    }
  };

  // Transfer ownership logic
  const transferCandidates = useMemo(() => {
    const candidates = members.filter(m => m.userId !== currentUser?.id);
    if (!transferSearch.trim()) return candidates;
    const q = transferSearch.toLowerCase();
    return candidates.filter(m =>
      m.user.displayName?.toLowerCase().includes(q) ||
      m.user.username.toLowerCase().includes(q)
    );
  }, [members, currentUser?.id, transferSearch]);

  const transferTarget = transferTargetId ? members.find(m => m.userId === transferTargetId) : null;

  const handleTransfer = async () => {
    if (!transferTargetId) return;
    setTransferring(true);
    try {
      await transferOwnership(spaceId, transferTargetId);
      addToast(`Ownership transferred to ${transferTarget?.user.displayName || transferTarget?.user.username}`, 'success', 3000);
      setShowTransfer(false);
      setTransferTargetId(null);
      setTransferSearch('');
    } catch (err) {
      addToast(err instanceof Error ? err.message : 'Failed to transfer ownership', 'warning', 3000);
    } finally {
      setTransferring(false);
    }
  };

  const displayIconSrc = iconPreview ?? (iconFilename === '' ? null : currentIconUrl);
  const displayIconName = space.name;
  const displayBannerSrc = bannerPreview ?? (bannerFilename === '' ? null : currentBannerUrl);

  return (
    <>
      <div className="space-y-5">
        <h2 className="text-lg font-semibold text-txt-primary mb-6">Overview</h2>
        {/* Space Identity */}
        <div>
          <div className="text-[11px] font-semibold text-txt-tertiary uppercase tracking-wider mb-1.5">Space Identity</div>
          <div className="rounded-lg bg-white/[0.02] p-3.5 space-y-4">
        {/* Space Icon */}
        <div>
          <label className="block text-xs text-txt-secondary mb-1.5">
            Space Icon
          </label>
          <div className="flex items-center gap-3">
            <button
              type="button"
              onClick={() => canManageSpace && fileInputRef.current?.click()}
              disabled={!canManageSpace || uploadingIcon}
              className={`relative w-16 h-16 rounded-full bg-surface-input border-2 border-dashed border-border-subtle flex items-center justify-center overflow-hidden group ${
                canManageSpace ? 'hover:border-accent-primary cursor-pointer' : 'cursor-default'
              } transition-colors`}
            >
              {displayIconSrc ? (
                <>
                  <img src={displayIconSrc} alt="Space icon" className="w-full h-full object-cover" />
                  {canManageSpace && (
                    <div className="absolute inset-0 bg-black/50 opacity-0 group-hover:opacity-100 transition-opacity flex items-center justify-center">
                      <svg className="w-5 h-5 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                        <path strokeLinecap="round" strokeLinejoin="round" d="M3 9a2 2 0 012-2h.93a2 2 0 001.664-.89l.812-1.22A2 2 0 0110.07 4h3.86a2 2 0 011.664.89l.812 1.22A2 2 0 0018.07 7H19a2 2 0 012 2v9a2 2 0 01-2 2H5a2 2 0 01-2-2V9z" />
                        <path strokeLinecap="round" strokeLinejoin="round" d="M15 13a3 3 0 11-6 0 3 3 0 016 0z" />
                      </svg>
                    </div>
                  )}
                </>
              ) : (
                <div
                  className="w-full h-full rounded-full flex items-center justify-center text-white text-xl font-bold"
                  style={{ background: getSpaceGradient(space.id, space.name, avatarColorState).gradient }}
                >
                  {space.name.charAt(0).toUpperCase()}
                </div>
              )}
              {uploadingIcon && (
                <div className="absolute inset-0 bg-black/50 flex items-center justify-center">
                  <svg className="w-5 h-5 text-white animate-spin" fill="none" viewBox="0 0 24 24">
                    <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                    <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
                  </svg>
                </div>
              )}
            </button>
            <input
              ref={fileInputRef}
              type="file"
              accept="image/*"
              onChange={handleIconSelect}
              className="hidden"
            />
            {canManageSpace && (displayIconSrc || space.icon) && iconFilename !== '' && (
              <button
                type="button"
                onClick={handleRemoveIcon}
                className="text-xs text-txt-tertiary hover:text-txt-danger transition-colors"
              >
                Remove
              </button>
            )}
          </div>
        </div>

        {/* Space Avatar Color */}
        <div>
          <label className="block text-xs text-txt-secondary mb-1.5">
            Icon Color
          </label>
          <div className="flex gap-2">
            {AVATAR_COLORS.map((key) => {
              const entry = SPACE_GRADIENT_MAP[key];
              return (
                <button
                  key={key}
                  type="button"
                  onClick={() => canManageSpace && setAvatarColorState(key)}
                  disabled={!canManageSpace}
                  className="w-7 h-7 rounded-full border-2 transition-all hover:scale-110 disabled:cursor-default disabled:hover:scale-100"
                  style={{
                    background: entry.gradient,
                    borderColor: avatarColorState === key ? 'white' : 'transparent',
                    boxShadow: avatarColorState === key ? `0 0 0 2px ${entry.glow}40` : 'none',
                  }}
                  title={key.charAt(0).toUpperCase() + key.slice(1)}
                />
              );
            })}
          </div>
        </div>

        {/* Space Banner */}
        <div>
          <label className="block text-xs text-txt-secondary mb-1.5">
            Space Banner
          </label>
          <div className="flex flex-col gap-2">
            <button
              type="button"
              onClick={() => canManageSpace && bannerFileInputRef.current?.click()}
              disabled={!canManageSpace || uploadingBanner}
              className={`relative w-full h-24 rounded-lg bg-surface-input border-2 border-dashed border-border-subtle flex items-center justify-center overflow-hidden group ${
                canManageSpace ? 'hover:border-accent-primary cursor-pointer' : 'cursor-default'
              } transition-colors`}
            >
              {displayBannerSrc ? (
                <>
                  <img src={displayBannerSrc} alt="Space banner" className="w-full h-full object-cover" />
                  {canManageSpace && (
                    <div className="absolute inset-0 bg-black/50 opacity-0 group-hover:opacity-100 transition-opacity flex items-center justify-center">
                      <svg className="w-5 h-5 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                        <path strokeLinecap="round" strokeLinejoin="round" d="M3 9a2 2 0 012-2h.93a2 2 0 001.664-.89l.812-1.22A2 2 0 0110.07 4h3.86a2 2 0 011.664.89l.812 1.22A2 2 0 0018.07 7H19a2 2 0 012 2v9a2 2 0 01-2 2H5a2 2 0 01-2-2V9z" />
                        <path strokeLinecap="round" strokeLinejoin="round" d="M15 13a3 3 0 11-6 0 3 3 0 016 0z" />
                      </svg>
                    </div>
                  )}
                </>
              ) : (
                <div className="flex flex-col items-center gap-1 text-txt-tertiary">
                  <svg className="w-6 h-6 opacity-40" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M2.25 15.75l5.159-5.159a2.25 2.25 0 013.182 0l5.159 5.159m-1.5-1.5l1.409-1.409a2.25 2.25 0 013.182 0l2.909 2.909M3.75 21h16.5A2.25 2.25 0 0022.5 18.75V5.25A2.25 2.25 0 0020.25 3H3.75A2.25 2.25 0 001.5 5.25v13.5A2.25 2.25 0 003.75 21z" />
                  </svg>
                  <span className="text-[11px]">Upload banner (16:9)</span>
                </div>
              )}
              {uploadingBanner && (
                <div className="absolute inset-0 bg-black/50 flex items-center justify-center">
                  <svg className="w-5 h-5 text-white animate-spin" fill="none" viewBox="0 0 24 24">
                    <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                    <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
                  </svg>
                </div>
              )}
            </button>
            <input
              ref={bannerFileInputRef}
              type="file"
              accept="image/*"
              onChange={handleBannerSelect}
              className="hidden"
            />
            {canManageSpace && (displayBannerSrc || space.banner) && bannerFilename !== '' && (
              <button
                type="button"
                onClick={handleRemoveBanner}
                className="text-xs text-txt-tertiary hover:text-txt-danger transition-colors self-start"
              >
                Remove banner
              </button>
            )}
          </div>
        </div>

        {/* Space Name */}
        <div>
          <label className="block text-xs text-txt-secondary mb-1.5">
            Space Name
          </label>
          <input
            type="text"
            value={spaceName}
            onChange={(e) => setSpaceName(e.target.value)}
            className="input-standard w-full"
            disabled={!canManageSpace}
          />
        </div>
          </div>
        </div>

        {/* Save / Discard */}
        {saveError && (
          <div className="p-2 bg-accent-rose/10 border border-accent-rose/30 rounded text-txt-danger text-sm">{saveError}</div>
        )}
        {saveSuccess && (
          <div className="p-2 bg-status-online/10 border border-status-online/30 rounded text-status-online text-sm">Settings saved</div>
        )}
        {/* Danger Zone */}
        {isOwner && (
          <div>
            <div className="text-[11px] font-semibold text-txt-danger uppercase tracking-wider mb-1.5">Danger Zone</div>
            <div className="rounded-lg bg-white/[0.02] p-3.5 space-y-4">
              {/* Transfer Ownership */}
              <div>
                <p className="text-xs text-txt-tertiary mb-3">Transfer ownership to another member. You will become a regular member.</p>
                {showTransfer ? (
                  transferTargetId && transferTarget ? (
                    /* Confirm step */
                    <div className="space-y-3">
                      <div className="p-2.5 rounded-lg bg-accent-amber/10 border border-accent-amber/20">
                        <p className="text-sm text-txt-secondary">
                          Transfer ownership to{' '}
                          <span className="font-semibold text-txt-primary">{transferTarget.user.displayName || transferTarget.user.username}</span>?
                        </p>
                      </div>
                      <div className="flex gap-2">
                        <button
                          onClick={() => setTransferTargetId(null)}
                          className="px-3 py-1.5 text-sm text-txt-secondary hover:text-txt-primary transition-colors"
                          disabled={transferring}
                        >
                          Back
                        </button>
                        <button
                          onClick={handleTransfer}
                          disabled={transferring}
                          className="px-3 py-1.5 bg-accent-amber hover:bg-accent-amber/80 text-white text-sm font-medium rounded transition-colors disabled:opacity-50"
                        >
                          {transferring ? 'Transferring...' : 'Transfer'}
                        </button>
                      </div>
                    </div>
                  ) : (
                    /* Member picker */
                    <div className="space-y-2">
                      <input
                        type="text"
                        value={transferSearch}
                        onChange={(e) => setTransferSearch(e.target.value)}
                        placeholder="Search members..."
                        className="input-search w-full"
                        autoFocus
                      />
                      <div className="max-h-[160px] overflow-y-auto space-y-0.5">
                        {transferCandidates.length === 0 ? (
                          <p className="text-xs text-txt-tertiary text-center py-3">No members found</p>
                        ) : (
                          transferCandidates.map((member) => {
                            const avatarUrl = member.user.avatar
                              ? (member.user.avatar.startsWith('http') || member.user.avatar.startsWith('/') ? member.user.avatar : `/api/uploads/${member.user.avatar}`)
                              : null;
                            return (
                              <button
                                key={member.userId}
                                onClick={() => setTransferTargetId(member.userId)}
                                className="w-full flex items-center gap-2.5 px-2 py-1.5 rounded-md hover:bg-white/[0.06] transition-colors"
                              >
                                <div className="w-7 h-7 rounded-full bg-surface-input flex-shrink-0 overflow-hidden flex items-center justify-center">
                                  {avatarUrl ? (
                                    <img src={avatarUrl} alt="" className="w-full h-full object-cover" />
                                  ) : (
                                    <span className="text-[10px] font-bold text-txt-secondary">
                                      {(member.user.displayName || member.user.username).charAt(0).toUpperCase()}
                                    </span>
                                  )}
                                </div>
                                <div className="flex flex-col items-start min-w-0">
                                  <span className="text-sm text-txt-primary truncate max-w-full">
                                    {member.user.displayName || member.user.username}
                                  </span>
                                  {member.user.displayName && (
                                    <span className="text-[11px] text-txt-tertiary truncate max-w-full">
                                      {member.user.username}
                                    </span>
                                  )}
                                </div>
                              </button>
                            );
                          })
                        )}
                      </div>
                      <button
                        onClick={() => { setShowTransfer(false); setTransferSearch(''); }}
                        className="text-xs text-txt-tertiary hover:text-txt-secondary transition-colors"
                      >
                        Cancel
                      </button>
                    </div>
                  )
                ) : (
                  <button
                    onClick={() => setShowTransfer(true)}
                    className="px-4 py-2 bg-accent-amber hover:bg-accent-amber/80 text-white text-sm font-medium rounded transition-colors"
                  >
                    Transfer Ownership
                  </button>
                )}
              </div>

              {/* Divider */}
              <div className="border-t border-white/[0.05]" />

              {/* Delete Space */}
              <div>
                <p className="text-xs text-txt-tertiary mb-3">Permanently delete this space and all its data. This cannot be undone.</p>
                <button
                  onClick={handleDelete}
                  className="px-4 py-2 bg-accent-rose hover:bg-accent-rose/80 text-white text-sm font-medium rounded transition-colors"
                >
                  {confirmDelete ? 'Click again to confirm deletion' : 'Delete Space'}
                </button>
              </div>
            </div>
          </div>
        )}

        {canManageSpace && hasChanges && (
          <div className="sticky bottom-0 z-10 pointer-events-none">
            <div className="flex justify-center pt-3 pb-1">
              <div className="glass-bubble rounded-full px-4 py-2 flex items-center gap-2 animate-slide-up pointer-events-auto">
                <button
                  onClick={handleDiscard}
                  className="px-3 py-1 text-sm text-txt-tertiary hover:text-txt-secondary transition-colors"
                >
                  Discard
                </button>
                <button
                  onClick={handleSave}
                  disabled={saving || uploadingIcon || uploadingBanner || !spaceName.trim()}
                  className="px-3 py-1.5 bg-accent-primary hover:bg-accent-primary/80 text-white text-sm font-medium rounded-full transition-colors disabled:opacity-50"
                >
                  {saving ? 'Saving...' : 'Save'}
                </button>
              </div>
            </div>
          </div>
        )}
      </div>

      <ImageCropModal
        isOpen={cropSrc !== null}
        onClose={() => setCropSrc(null)}
        imageSrc={cropSrc ?? ''}
        onCropComplete={handleCropComplete}
        title="Crop Space Icon"
        cropShape="round"
        aspectRatio={1}
        maxOutputDimension={256}
      />

      <ImageCropModal
        isOpen={bannerCropSrc !== null}
        onClose={() => setBannerCropSrc(null)}
        imageSrc={bannerCropSrc ?? ''}
        onCropComplete={handleBannerCropComplete}
        title="Crop Space Banner"
        cropShape="rect"
        aspectRatio={16 / 9}
        maxOutputDimension={1280}
      />
    </>
  );
}
