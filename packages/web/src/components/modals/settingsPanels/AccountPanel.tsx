import { useState, useEffect, useRef } from 'react';
import { useAuthStore } from '../../../stores/authStore';
import { Avatar } from '../../ui/Avatar';
import { ImageCropModal } from '../../ui/ImageCropModal';
import { api } from '../../../api/client';
import { getAvatarGradient, adjustColor } from '../../../utils/gradients';
import type { UserStatus } from '@backspace/shared';

const ACCENT_PRESETS = [
  '#86efac', '#fca5a5', '#c4b5fd', '#7dd3fc',
  '#fcd34d', '#fda4af', '#fb923c', '#7c6cf6',
  '#ef4444', '#f97316', '#22d3ee', '#a3e635',
  '#f472b6', '#818cf8', '#2dd4bf', '#e879f9',
];

export function AccountPanel() {
  const user = useAuthStore((s) => s.user);
  const updateProfile = useAuthStore((s) => s.updateProfile);

  const [displayName, setDisplayName] = useState(user?.displayName ?? '');
  const [customStatus, setCustomStatus] = useState(user?.customStatus ?? '');
  const [status, setStatus] = useState<UserStatus>(user?.status ?? 'online');
  const [bio, setBio] = useState(user?.bio ?? '');
  const [accentColor, setAccentColor] = useState<string | null>(user?.accentColor ?? null);
  const [customHex, setCustomHex] = useState(user?.accentColor ?? '');

  // Avatar upload state
  const [avatarPreview, setAvatarPreview] = useState<string | null>(null);
  const [avatarFilename, setAvatarFilename] = useState<string | null>(null);
  const [uploadingAvatar, setUploadingAvatar] = useState(false);
  const [avatarCropSrc, setAvatarCropSrc] = useState<string | null>(null);
  const avatarInputRef = useRef<HTMLInputElement>(null);

  // Banner upload state
  const [bannerPreview, setBannerPreview] = useState<string | null>(null);
  const [bannerFilename, setBannerFilename] = useState<string | null>(null);
  const [uploadingBanner, setUploadingBanner] = useState(false);
  const [bannerCropSrc, setBannerCropSrc] = useState<string | null>(null);
  const bannerInputRef = useRef<HTMLInputElement>(null);

  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');
  const [isLoading, setIsLoading] = useState(false);

  useEffect(() => {
    if (user) {
      setDisplayName(user.displayName ?? '');
      setCustomStatus(user.customStatus ?? '');
      setStatus(user.status ?? 'online');
      setBio(user.bio ?? '');
      setAccentColor(user.accentColor ?? null);
      setCustomHex(user.accentColor ?? '');
      // Reset upload state
      if (avatarPreview) URL.revokeObjectURL(avatarPreview);
      if (bannerPreview) URL.revokeObjectURL(bannerPreview);
      setAvatarPreview(null);
      setAvatarFilename(null);
      setBannerPreview(null);
      setBannerFilename(null);
    }
  }, [user?.displayName, user?.customStatus, user?.status, user?.bio, user?.accentColor, user?.avatar, user?.banner]);

  if (!user) return null;

  const effectiveDisplayName = displayName.trim() || user.username;
  const effectiveAccent = accentColor;

  // Change detection
  const hasChanges =
    displayName !== (user.displayName ?? '') ||
    customStatus !== (user.customStatus ?? '') ||
    status !== (user.status ?? 'online') ||
    bio !== (user.bio ?? '') ||
    accentColor !== (user.accentColor ?? null) ||
    avatarFilename !== null ||
    bannerFilename !== null;

  // Compute banner display
  const currentBannerUrl = user.banner
    ? (user.banner.startsWith('http') ? user.banner : api.uploads.url(user.banner))
    : null;
  const displayBannerSrc = bannerPreview ?? (bannerFilename === '' ? null : currentBannerUrl);

  // Compute avatar display
  const currentAvatarSrc = user.avatar
    ? (user.avatar.startsWith('http') ? user.avatar : api.uploads.url(user.avatar))
    : null;
  const displayAvatarSrc = avatarPreview ?? (avatarFilename === '' ? null : currentAvatarSrc);

  // Banner fallback: accent gradient or avatar gradient
  const bannerFallback = effectiveAccent
    ? `linear-gradient(135deg, ${effectiveAccent}, ${adjustColor(effectiveAccent, -40)})`
    : getAvatarGradient(user.homeUserId ?? user.id, effectiveDisplayName).gradient;

  // ── File selection handlers ──
  const handleAvatarSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => setAvatarCropSrc(reader.result as string);
    reader.readAsDataURL(file);
    if (avatarInputRef.current) avatarInputRef.current.value = '';
  };

  const handleBannerSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => setBannerCropSrc(reader.result as string);
    reader.readAsDataURL(file);
    if (bannerInputRef.current) bannerInputRef.current.value = '';
  };

  // ── Crop complete handlers ──
  const handleAvatarCropComplete = async (blob: Blob) => {
    if (avatarPreview) URL.revokeObjectURL(avatarPreview);
    const previewUrl = URL.createObjectURL(blob);
    setAvatarPreview(previewUrl);
    setAvatarCropSrc(null);
    const file = new File([blob], 'avatar.png', { type: 'image/png' });
    setUploadingAvatar(true);
    try {
      const attachment = await api.uploads.upload(file);
      setAvatarFilename(attachment.filename);
    } catch {
      setError('Failed to upload avatar');
      setAvatarPreview(null);
      URL.revokeObjectURL(previewUrl);
    } finally {
      setUploadingAvatar(false);
    }
  };

  const handleBannerCropComplete = async (blob: Blob) => {
    if (bannerPreview) URL.revokeObjectURL(bannerPreview);
    const previewUrl = URL.createObjectURL(blob);
    setBannerPreview(previewUrl);
    setBannerCropSrc(null);
    const file = new File([blob], 'banner.png', { type: 'image/png' });
    setUploadingBanner(true);
    try {
      const attachment = await api.uploads.upload(file);
      setBannerFilename(attachment.filename);
    } catch {
      setError('Failed to upload banner');
      setBannerPreview(null);
      URL.revokeObjectURL(previewUrl);
    } finally {
      setUploadingBanner(false);
    }
  };

  const handleRemoveAvatar = () => {
    if (avatarPreview) URL.revokeObjectURL(avatarPreview);
    setAvatarPreview(null);
    setAvatarFilename('');
  };

  const handleRemoveBanner = () => {
    if (bannerPreview) URL.revokeObjectURL(bannerPreview);
    setBannerPreview(null);
    setBannerFilename('');
  };

  const handleSave = async () => {
    setError('');
    setSuccess('');
    setIsLoading(true);
    try {
      const updates: Record<string, string | undefined> = {};
      if (displayName !== (user.displayName ?? '')) updates.displayName = displayName.trim();
      if (customStatus !== (user.customStatus ?? '')) updates.customStatus = customStatus.trim();
      if (status !== (user.status ?? 'online')) updates.status = status;
      if (bio !== (user.bio ?? '')) updates.bio = bio.trim();
      if (accentColor !== (user.accentColor ?? null)) updates.accentColor = accentColor ?? '';
      if (avatarFilename !== null) updates.avatar = avatarFilename;
      if (bannerFilename !== null) updates.banner = bannerFilename;

      await updateProfile(updates as Parameters<typeof updateProfile>[0]);
      setSuccess('Profile updated!');
      setTimeout(() => setSuccess(''), 2000);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to update profile');
    } finally {
      setIsLoading(false);
    }
  };

  const handleReset = () => {
    setDisplayName(user.displayName ?? '');
    setCustomStatus(user.customStatus ?? '');
    setStatus(user.status ?? 'online');
    setBio(user.bio ?? '');
    setAccentColor(user.accentColor ?? null);
    setCustomHex(user.accentColor ?? '');
    if (avatarPreview) URL.revokeObjectURL(avatarPreview);
    if (bannerPreview) URL.revokeObjectURL(bannerPreview);
    setAvatarPreview(null);
    setAvatarFilename(null);
    setBannerPreview(null);
    setBannerFilename(null);
    setError('');
  };

  return (
    <div className="space-y-5">
      {/* ── Profile Customization ── */}
      <div>
        <div className="text-[11px] font-semibold text-txt-tertiary uppercase tracking-wider mb-1.5">
          Profile Customization
        </div>

        {/* Live Preview Card */}
        <div className="rounded-lg overflow-hidden border border-white/[0.06] mb-4">
          {/* Banner area */}
          <div
            className="h-[80px] relative"
            style={displayBannerSrc
              ? { backgroundImage: `url(${displayBannerSrc})`, backgroundSize: 'cover', backgroundPosition: 'center' }
              : { background: bannerFallback, opacity: 0.6 }
            }
          />
          {/* Avatar + info */}
          <div className="px-4 pb-3 bg-surface-channel">
            <div
              className="mt-[-28px] mb-2 w-fit rounded-full"
              style={{ border: '4px solid var(--color-surface-channel, #1e1e2a)' }}
            >
              {displayAvatarSrc ? (
                <img
                  src={displayAvatarSrc}
                  alt="Avatar"
                  className="w-[56px] h-[56px] rounded-full object-cover"
                />
              ) : (
                <Avatar
                  src={null}
                  name={effectiveDisplayName}
                  size={56}
                  userId={user.homeUserId ?? user.id}
                />
              )}
            </div>
            <div
              className="font-semibold text-[15px] leading-tight"
              style={{ color: effectiveAccent ?? 'var(--color-txt-primary)' }}
            >
              {effectiveDisplayName}
            </div>
            <div className="text-[12px] text-txt-tertiary">@{user.username}</div>
            {bio.trim() && (
              <div className="text-[12px] text-txt-secondary mt-1.5 whitespace-pre-wrap break-words line-clamp-3">
                {bio.trim()}
              </div>
            )}
          </div>
        </div>

        {/* Upload controls */}
        <div className="rounded-lg bg-white/[0.03] border border-white/[0.04] p-3.5 space-y-4">
          {/* Avatar upload */}
          <div>
            <label className="block text-xs text-txt-secondary mb-1.5">Avatar</label>
            <div className="flex items-center gap-3">
              <button
                type="button"
                onClick={() => avatarInputRef.current?.click()}
                disabled={uploadingAvatar}
                className="relative group"
              >
                <div className="w-[64px] h-[64px] rounded-full overflow-hidden">
                  {displayAvatarSrc ? (
                    <img src={displayAvatarSrc} alt="Avatar" className="w-full h-full object-cover" />
                  ) : (
                    <Avatar
                      src={null}
                      name={effectiveDisplayName}
                      size={64}
                      userId={user.homeUserId ?? user.id}
                    />
                  )}
                </div>
                <div className="absolute inset-0 rounded-full bg-black/50 flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity">
                  <svg className="w-5 h-5 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M3 9a2 2 0 012-2h.93a2 2 0 001.664-.89l.812-1.22A2 2 0 0110.07 4h3.86a2 2 0 011.664.89l.812 1.22A2 2 0 0018.07 7H19a2 2 0 012 2v9a2 2 0 01-2 2H5a2 2 0 01-2-2V9z" />
                    <path strokeLinecap="round" strokeLinejoin="round" d="M15 13a3 3 0 11-6 0 3 3 0 016 0z" />
                  </svg>
                </div>
                {uploadingAvatar && (
                  <div className="absolute inset-0 rounded-full bg-black/60 flex items-center justify-center">
                    <svg className="animate-spin w-5 h-5 text-white" viewBox="0 0 24 24" fill="none">
                      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                      <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
                    </svg>
                  </div>
                )}
              </button>
              <div className="flex flex-col gap-1">
                <button
                  type="button"
                  onClick={() => avatarInputRef.current?.click()}
                  disabled={uploadingAvatar}
                  className="text-xs text-accent-primary hover:underline text-left"
                >
                  Change Avatar
                </button>
                {(displayAvatarSrc || user.avatar) && avatarFilename !== '' && (
                  <button
                    type="button"
                    onClick={handleRemoveAvatar}
                    className="text-xs text-txt-danger hover:underline text-left"
                  >
                    Remove
                  </button>
                )}
              </div>
            </div>
            <input
              ref={avatarInputRef}
              type="file"
              accept="image/*"
              onChange={handleAvatarSelect}
              className="hidden"
            />
          </div>

          {/* Banner upload */}
          <div>
            <label className="block text-xs text-txt-secondary mb-1.5">Banner</label>
            <button
              type="button"
              onClick={() => bannerInputRef.current?.click()}
              disabled={uploadingBanner}
              className="relative group w-full h-[72px] rounded-lg overflow-hidden border border-white/[0.06]"
            >
              <div
                className="w-full h-full"
                style={displayBannerSrc
                  ? { backgroundImage: `url(${displayBannerSrc})`, backgroundSize: 'cover', backgroundPosition: 'center' }
                  : { background: bannerFallback, opacity: 0.5 }
                }
              />
              <div className="absolute inset-0 bg-black/40 flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity">
                <svg className="w-5 h-5 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M3 9a2 2 0 012-2h.93a2 2 0 001.664-.89l.812-1.22A2 2 0 0110.07 4h3.86a2 2 0 011.664.89l.812 1.22A2 2 0 0018.07 7H19a2 2 0 012 2v9a2 2 0 01-2 2H5a2 2 0 01-2-2V9z" />
                  <path strokeLinecap="round" strokeLinejoin="round" d="M15 13a3 3 0 11-6 0 3 3 0 016 0z" />
                </svg>
              </div>
              {uploadingBanner && (
                <div className="absolute inset-0 bg-black/60 flex items-center justify-center">
                  <svg className="animate-spin w-5 h-5 text-white" viewBox="0 0 24 24" fill="none">
                    <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                    <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
                  </svg>
                </div>
              )}
            </button>
            <div className="flex gap-2 mt-1">
              <button
                type="button"
                onClick={() => bannerInputRef.current?.click()}
                disabled={uploadingBanner}
                className="text-xs text-accent-primary hover:underline"
              >
                Change Banner
              </button>
              {(displayBannerSrc || user.banner) && bannerFilename !== '' && (
                <button
                  type="button"
                  onClick={handleRemoveBanner}
                  className="text-xs text-txt-danger hover:underline"
                >
                  Remove
                </button>
              )}
            </div>
            <input
              ref={bannerInputRef}
              type="file"
              accept="image/*"
              onChange={handleBannerSelect}
              className="hidden"
            />
          </div>

          {/* Accent Color */}
          <div>
            <label className="block text-xs text-txt-secondary mb-1.5">Accent Color</label>
            <div className="grid grid-cols-8 gap-1.5 mb-2">
              {ACCENT_PRESETS.map((color) => (
                <button
                  key={color}
                  type="button"
                  onClick={() => { setAccentColor(color); setCustomHex(color); }}
                  className="w-7 h-7 rounded-full border-2 transition-all hover:scale-110"
                  style={{
                    backgroundColor: color,
                    borderColor: accentColor === color ? 'white' : 'transparent',
                    boxShadow: accentColor === color ? `0 0 0 2px ${color}40` : 'none',
                  }}
                  title={color}
                />
              ))}
            </div>
            <div className="flex items-center gap-2">
              <input
                type="text"
                value={customHex}
                onChange={(e) => {
                  const val = e.target.value;
                  setCustomHex(val);
                  if (/^#[0-9a-fA-F]{6}$/.test(val)) {
                    setAccentColor(val);
                  }
                }}
                placeholder="#hex"
                className="w-24 px-2 py-1.5 bg-surface-input rounded text-xs text-txt-primary outline-none focus:ring-2 focus:ring-accent-primary font-mono"
                maxLength={7}
              />
              {accentColor && (
                <div
                  className="w-6 h-6 rounded-full border border-white/10 flex-shrink-0"
                  style={{ backgroundColor: accentColor }}
                />
              )}
              {accentColor && (
                <button
                  type="button"
                  onClick={() => { setAccentColor(null); setCustomHex(''); }}
                  className="text-xs text-txt-tertiary hover:text-txt-secondary transition-colors"
                >
                  Clear
                </button>
              )}
            </div>
          </div>

          {/* Bio */}
          <div>
            <label className="block text-xs text-txt-secondary mb-1.5">About Me</label>
            <div className="relative">
              <textarea
                value={bio}
                onChange={(e) => {
                  if (e.target.value.length <= 190) setBio(e.target.value);
                }}
                rows={3}
                placeholder="Tell the world about yourself..."
                className="w-full px-3 py-2 bg-surface-input rounded text-sm text-txt-primary outline-none focus:ring-2 focus:ring-accent-primary resize-none"
                maxLength={190}
              />
              <span className="absolute bottom-2 right-2 text-[10px] text-txt-tertiary">
                {bio.length}/190
              </span>
            </div>
          </div>
        </div>
      </div>

      {/* ── Account ── */}
      <div>
        <div className="text-[11px] font-semibold text-txt-tertiary uppercase tracking-wider mb-1.5">Account</div>
        <div className="rounded-lg bg-white/[0.03] border border-white/[0.04] p-3.5 space-y-4">
          <div>
            <label className="block text-xs text-txt-secondary mb-1.5">Status</label>
            <select
              value={status}
              onChange={(e) => setStatus(e.target.value as UserStatus)}
              className="w-full px-3 py-2 bg-surface-input rounded text-txt-primary outline-none focus:ring-2 focus:ring-accent-primary appearance-none"
            >
              <option value="online">Online</option>
              <option value="idle">Idle</option>
              <option value="dnd">Do Not Disturb</option>
            </select>
          </div>

          <div>
            <label className="block text-xs text-txt-secondary mb-1.5">Display Name</label>
            <input
              type="text"
              value={displayName}
              onChange={(e) => setDisplayName(e.target.value)}
              className="w-full px-3 py-2 bg-surface-input rounded text-txt-primary outline-none focus:ring-2 focus:ring-accent-primary"
            />
          </div>

          <div>
            <label className="block text-xs text-txt-secondary mb-1.5">Custom Status</label>
            <input
              type="text"
              value={customStatus}
              onChange={(e) => setCustomStatus(e.target.value)}
              className="w-full px-3 py-2 bg-surface-input rounded text-txt-primary outline-none focus:ring-2 focus:ring-accent-primary"
              placeholder="What are you up to?"
            />
          </div>
        </div>
      </div>

      {error && (
        <div className="p-2 bg-accent-rose/10 border border-accent-rose/30 rounded text-txt-danger text-sm">{error}</div>
      )}
      {success && (
        <div className="p-2 bg-status-online/10 border border-status-online/30 rounded text-status-online text-sm">{success}</div>
      )}

      {hasChanges && (
        <div className="sticky bottom-0 z-10 pointer-events-none">
          <div className="flex justify-center pt-3 pb-1">
            <div className="glass-bubble rounded-full px-4 py-2 flex items-center gap-2 animate-slide-up pointer-events-auto">
              <button
                onClick={handleReset}
                className="px-3 py-1 text-sm text-txt-tertiary hover:text-txt-secondary transition-colors"
              >
                Reset
              </button>
              <button
                onClick={handleSave}
                disabled={isLoading || uploadingAvatar || uploadingBanner}
                className="px-3 py-1.5 bg-accent-primary hover:bg-accent-primary/80 text-white text-sm font-medium rounded-full transition-colors disabled:opacity-50"
              >
                {isLoading ? 'Saving...' : 'Save'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Crop Modals */}
      <ImageCropModal
        isOpen={avatarCropSrc !== null}
        onClose={() => setAvatarCropSrc(null)}
        imageSrc={avatarCropSrc ?? ''}
        onCropComplete={handleAvatarCropComplete}
        title="Crop Avatar"
        cropShape="round"
        aspectRatio={1}
      />
      <ImageCropModal
        isOpen={bannerCropSrc !== null}
        onClose={() => setBannerCropSrc(null)}
        imageSrc={bannerCropSrc ?? ''}
        onCropComplete={handleBannerCropComplete}
        title="Crop Banner"
        cropShape="rect"
        aspectRatio={3}
      />
    </div>
  );
}
