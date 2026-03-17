import React, { useState, useRef } from 'react';
import { Modal } from '../ui/Modal';
import { ImageCropModal } from '../ui/ImageCropModal';
import { useSpaceStore } from '../../stores/spaceStore';
import { useUIStore } from '../../stores/uiStore';
import { useNavigate } from 'react-router-dom';
import { api } from '../../api/client';
import { AVATAR_COLORS } from '@backspace/shared';
import type { SpaceVisibility, AvatarColor } from '@backspace/shared';
import { SPACE_GRADIENT_MAP, getSpaceGradient } from '../../utils/gradients';

const visibilityOptions: { value: SpaceVisibility; label: string; desc: string }[] = [
  { value: 'private', label: 'Private', desc: 'Only people with an invite link can join' },
  { value: 'request', label: 'Request to Join', desc: 'Visible in Explore — people can request to join' },
  { value: 'public', label: 'Public', desc: 'Visible in Explore — anyone can join instantly' },
];

export function CreateSpaceModal() {
  const [name, setName] = useState('');
  const [visibility, setVisibility] = useState<SpaceVisibility>('private');
  const [description, setDescription] = useState('');
  const [iconFilename, setIconFilename] = useState<string | null>(null);
  const [iconPreview, setIconPreview] = useState<string | null>(null);
  const [uploadingIcon, setUploadingIcon] = useState(false);
  const [cropSrc, setCropSrc] = useState<string | null>(null);
  const [avatarColor, setAvatarColor] = useState<AvatarColor>(
    AVATAR_COLORS[Math.floor(Math.random() * AVATAR_COLORS.length)] ?? 'mint'
  );
  const [error, setError] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const createSpace = useSpaceStore((s) => s.createSpace);
  const activeModal = useUIStore((s) => s.activeModal);
  const closeModal = useUIStore((s) => s.closeModal);
  const navigate = useNavigate();

  const isOpen = activeModal === 'createSpace';

  const handleIconSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    const reader = new FileReader();
    reader.onload = () => setCropSrc(reader.result as string);
    reader.readAsDataURL(file);

    // Reset the input so re-selecting the same file triggers onChange
    if (fileInputRef.current) fileInputRef.current.value = '';
  };

  const handleCropComplete = async (blob: Blob) => {
    // Show cropped preview
    if (iconPreview) URL.revokeObjectURL(iconPreview);
    const previewUrl = URL.createObjectURL(blob);
    setIconPreview(previewUrl);
    setCropSrc(null);

    // Upload the cropped image
    const file = new File([blob], 'icon.png', { type: 'image/png' });
    setUploadingIcon(true);
    try {
      const attachment = await api.uploads.upload(file);
      setIconFilename(attachment.filename);
    } catch {
      setError('Failed to upload icon');
      setIconPreview(null);
      URL.revokeObjectURL(previewUrl);
    } finally {
      setUploadingIcon(false);
    }
  };

  const handleRemoveIcon = () => {
    if (iconPreview) URL.revokeObjectURL(iconPreview);
    setIconFilename(null);
    setIconPreview(null);
  };

  const handleClose = () => {
    closeModal();
    setName('');
    setVisibility('private');
    setDescription('');
    setIconFilename(null);
    if (iconPreview) URL.revokeObjectURL(iconPreview);
    setIconPreview(null);
    setCropSrc(null);
    setAvatarColor(AVATAR_COLORS[Math.floor(Math.random() * AVATAR_COLORS.length)] ?? 'mint');
    setError('');
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');

    if (!name.trim()) {
      setError('Space name is required');
      return;
    }

    setIsLoading(true);
    try {
      const space = await createSpace({
        name: name.trim(),
        icon: iconFilename ?? undefined,
        avatarColor,
        visibility,
        description: description.trim() || undefined,
      });
      handleClose();
      navigate(`/channels/${space.id}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to create space');
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <>
    <Modal isOpen={isOpen} onClose={handleClose} title="Create a Space" mobileStyle="sheet">
      <form onSubmit={handleSubmit}>
        {error && (
          <div className="mb-3 p-2 bg-accent-rose/10 border border-accent-rose/30 rounded text-txt-danger text-sm">
            {error}
          </div>
        )}

        {/* Icon Picker */}
        <div className="flex justify-center mb-4">
          <button
            type="button"
            onClick={() => fileInputRef.current?.click()}
            disabled={uploadingIcon}
            className="relative w-20 h-20 rounded-full border-2 border-dashed border-border-subtle hover:border-accent-primary transition-colors flex items-center justify-center overflow-hidden group"
            style={!iconPreview ? { background: getSpaceGradient(undefined, name || 'S', avatarColor).gradient } : undefined}
          >
            {iconPreview ? (
              <>
                <img src={iconPreview} alt="Icon preview" className="w-full h-full object-cover" />
                <div className="absolute inset-0 bg-black/50 opacity-0 group-hover:opacity-100 transition-opacity flex items-center justify-center">
                  <svg className="w-5 h-5 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M3 9a2 2 0 012-2h.93a2 2 0 001.664-.89l.812-1.22A2 2 0 0110.07 4h3.86a2 2 0 011.664.89l.812 1.22A2 2 0 0018.07 7H19a2 2 0 012 2v9a2 2 0 01-2 2H5a2 2 0 01-2-2V9z" />
                    <path strokeLinecap="round" strokeLinejoin="round" d="M15 13a3 3 0 11-6 0 3 3 0 016 0z" />
                  </svg>
                </div>
              </>
            ) : (
              <div className="flex flex-col items-center gap-1 text-white/90 group-hover:text-white transition-colors">
                {uploadingIcon ? (
                  <svg className="w-6 h-6 animate-spin" fill="none" viewBox="0 0 24 24">
                    <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                    <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
                  </svg>
                ) : (
                  <>
                    <span className="text-2xl font-bold">{(name || 'S').charAt(0).toUpperCase()}</span>
                    <span className="text-[9px] font-medium opacity-60">Upload</span>
                  </>
                )}
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
          {iconPreview && (
            <button
              type="button"
              onClick={handleRemoveIcon}
              className="ml-2 self-start mt-1 text-txt-tertiary hover:text-txt-danger text-xs transition-colors"
            >
              Remove
            </button>
          )}
        </div>

        {/* Icon Color */}
        <div className="mb-4">
          <label className="block text-xs font-bold text-txt-secondary uppercase mb-2">
            Icon Color
          </label>
          <div className="flex gap-2 justify-center">
            {AVATAR_COLORS.map((key) => {
              const entry = SPACE_GRADIENT_MAP[key];
              return (
                <button
                  key={key}
                  type="button"
                  onClick={() => setAvatarColor(key)}
                  className="w-7 h-7 rounded-full border-2 transition-all hover:scale-110"
                  style={{
                    background: entry.gradient,
                    borderColor: avatarColor === key ? 'white' : 'transparent',
                    boxShadow: avatarColor === key ? `0 0 0 2px ${entry.glow}40` : 'none',
                  }}
                  title={key.charAt(0).toUpperCase() + key.slice(1)}
                />
              );
            })}
          </div>
        </div>

        {/* Space Name */}
        <div className="mb-4">
          <label className="block text-xs font-bold text-txt-secondary uppercase mb-2">
            Space Name
          </label>
          <input
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            className="input-standard w-full"
            placeholder="My Awesome Space"
            autoFocus
          />
        </div>

        {/* Visibility */}
        <div className="mb-4">
          <div className="text-[11px] text-txt-tertiary font-semibold uppercase tracking-wider mb-2">
            Visibility
          </div>
          <div className="space-y-1.5">
            {visibilityOptions.map((opt) => (
              <label
                key={opt.value}
                className={`flex items-start gap-3 p-2.5 rounded cursor-pointer transition-colors ${
                  visibility === opt.value
                    ? 'bg-interactive-selected'
                    : 'hover:bg-interactive-hover'
                }`}
              >
                <input
                  type="radio"
                  name="create-visibility"
                  value={opt.value}
                  checked={visibility === opt.value}
                  onChange={() => setVisibility(opt.value)}
                  className="mt-0.5 accent-accent-primary"
                />
                <div>
                  <div className="text-sm font-medium text-txt-primary">{opt.label}</div>
                  <div className="text-xs text-txt-tertiary">{opt.desc}</div>
                </div>
              </label>
            ))}
          </div>
        </div>

        {/* Description */}
        <div className="mb-4">
          <div className="text-[11px] text-txt-tertiary font-semibold uppercase tracking-wider mb-1.5">
            Description
          </div>
          <textarea
            value={description}
            onChange={(e) => setDescription(e.target.value.slice(0, 200))}
            placeholder="A short description for your space..."
            rows={3}
            className="input-standard w-full resize-none"
          />
          <div className="text-[11px] text-txt-tertiary text-right">{description.length}/200</div>
        </div>

        {/* Actions */}
        <div className="sticky bottom-0 z-10 pointer-events-none">
          <div className="flex justify-center pt-3 pb-1">
            <div className="glass-bubble rounded-full px-3 py-2 flex items-center gap-3 pointer-events-auto">
              <button
                type="button"
                onClick={handleClose}
                className="px-3 py-1 text-sm text-txt-tertiary hover:text-txt-secondary transition-colors"
              >
                Cancel
              </button>
              <button
                type="submit"
                disabled={isLoading || uploadingIcon}
                className="px-3 py-1.5 bg-accent-primary hover:bg-accent-primary/80 text-white text-sm font-medium rounded-full transition-colors disabled:opacity-50"
              >
                {isLoading ? 'Creating...' : 'Create'}
              </button>
            </div>
          </div>
        </div>
      </form>
    </Modal>

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
  </>
  );
}
