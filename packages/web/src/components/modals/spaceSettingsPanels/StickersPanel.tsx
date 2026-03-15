import { useState, useEffect, useRef } from 'react';
import { api } from '../../../api/client';
import { ConfirmDialog } from '../../ui/ConfirmDialog';
import type { StickerPack, Sticker } from '@backspace/shared';

interface StickersPanelProps {
  spaceId: string;
}

export function StickersPanel({ spaceId }: StickersPanelProps) {
  const [packs, setPacks] = useState<StickerPack[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  // Create pack state
  const [newPackName, setNewPackName] = useState('');
  const [newPackDesc, setNewPackDesc] = useState('');
  const [creating, setCreating] = useState(false);

  // Upload sticker state
  const [uploadPackId, setUploadPackId] = useState<string | null>(null);
  const [stickerName, setStickerName] = useState('');
  const [stickerTags, setStickerTags] = useState('');
  const [stickerFile, setStickerFile] = useState<File | null>(null);
  const [uploading, setUploading] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Delete confirmation
  const [deleteTarget, setDeleteTarget] = useState<{ type: 'pack' | 'sticker'; id: string; name: string } | null>(null);
  const [deleting, setDeleting] = useState(false);

  const fetchPacks = async () => {
    try {
      const { packs: data } = await api.stickers.getPacks(spaceId);
      setPacks(data);
      setLoading(false);
    } catch {
      setError('Failed to load sticker packs');
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchPacks();
  }, [spaceId]);

  const handleCreatePack = async () => {
    if (!newPackName.trim()) return;
    setCreating(true);
    setError('');
    try {
      const pack = await api.stickers.createPack(spaceId, {
        name: newPackName.trim(),
        description: newPackDesc.trim() || undefined,
      });
      setPacks((prev) => [...prev, { ...pack, stickers: [] }]);
      setNewPackName('');
      setNewPackDesc('');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to create pack');
    } finally {
      setCreating(false);
    }
  };

  const handleUploadSticker = async () => {
    if (!uploadPackId || !stickerFile || !stickerName.trim()) return;
    setUploading(true);
    setError('');
    try {
      const sticker = await api.stickers.uploadSticker(
        spaceId,
        uploadPackId,
        stickerFile,
        stickerName.trim(),
        stickerTags.trim(),
      );
      setPacks((prev) =>
        prev.map((p) =>
          p.id === uploadPackId
            ? { ...p, stickers: [...p.stickers, sticker] }
            : p,
        ),
      );
      setStickerName('');
      setStickerTags('');
      setStickerFile(null);
      setUploadPackId(null);
      if (fileInputRef.current) fileInputRef.current.value = '';
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to upload sticker');
    } finally {
      setUploading(false);
    }
  };

  const handleDelete = async () => {
    if (!deleteTarget) return;
    setDeleting(true);
    setError('');
    try {
      if (deleteTarget.type === 'pack') {
        await api.stickers.deletePack(spaceId, deleteTarget.id);
        setPacks((prev) => prev.filter((p) => p.id !== deleteTarget.id));
      } else {
        await api.stickers.deleteSticker(deleteTarget.id);
        setPacks((prev) =>
          prev.map((p) => ({
            ...p,
            stickers: p.stickers.filter((s) => s.id !== deleteTarget.id),
          })),
        );
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to delete');
    } finally {
      setDeleting(false);
      setDeleteTarget(null);
    }
  };

  const getStickerUrl = (sticker: Sticker) => {
    if (sticker.filename.startsWith('http') || sticker.filename.startsWith('/'))
      return sticker.filename;
    return `/api/uploads/${sticker.filename}`;
  };

  if (loading) {
    return <div className="text-sm text-txt-tertiary">Loading sticker packs...</div>;
  }

  return (
    <div className="space-y-5">
      <div className="text-xs text-txt-tertiary">
        Manage sticker packs for this space. Members can use these stickers in messages.
      </div>

      {error && (
        <div className="p-2 bg-accent-rose/10 border border-accent-rose/30 rounded text-txt-danger text-sm">
          {error}
        </div>
      )}

      {/* Create Pack */}
      <div>
        <div className="text-[11px] font-semibold text-txt-tertiary uppercase tracking-wider mb-1.5">
          Create Sticker Pack
        </div>
        <div className="rounded-lg bg-white/[0.02] p-3.5 space-y-2">
          <input
            type="text"
            value={newPackName}
            onChange={(e) => setNewPackName(e.target.value.slice(0, 32))}
            placeholder="Pack name"
            className="input-standard w-full"
          />
          <input
            type="text"
            value={newPackDesc}
            onChange={(e) => setNewPackDesc(e.target.value.slice(0, 100))}
            placeholder="Description (optional)"
            className="input-standard w-full"
          />
          <button
            onClick={handleCreatePack}
            disabled={creating || !newPackName.trim()}
            className="px-3 py-1.5 bg-accent-primary hover:bg-accent-primary/80 text-white text-sm font-medium rounded transition-colors disabled:opacity-50"
          >
            {creating ? 'Creating...' : 'Create Pack'}
          </button>
        </div>
      </div>

      {/* Existing Packs */}
      {packs.length === 0 ? (
        <div className="text-sm text-txt-tertiary">No sticker packs yet.</div>
      ) : (
        <div className="space-y-4">
          {packs.map((pack) => (
            <div key={pack.id} className="rounded-lg bg-white/[0.02] p-3.5">
              <div className="flex items-center justify-between mb-2">
                <div>
                  <div className="text-sm font-medium text-txt-primary">{pack.name}</div>
                  {pack.description && (
                    <div className="text-xs text-txt-tertiary">{pack.description}</div>
                  )}
                </div>
                <div className="flex items-center gap-1">
                  <button
                    onClick={() => setUploadPackId(uploadPackId === pack.id ? null : pack.id)}
                    className="px-2 py-1 text-xs text-txt-secondary hover:text-txt-primary bg-interactive-hover hover:bg-interactive-active rounded transition-colors"
                  >
                    {uploadPackId === pack.id ? 'Cancel' : 'Add Sticker'}
                  </button>
                  <button
                    onClick={() => setDeleteTarget({ type: 'pack', id: pack.id, name: pack.name })}
                    className="px-2 py-1 text-xs text-txt-danger hover:bg-accent-rose/20 rounded transition-colors"
                  >
                    Delete Pack
                  </button>
                </div>
              </div>

              {/* Upload form for this pack */}
              {uploadPackId === pack.id && (
                <div className="border-t border-white/[0.06] pt-2 mt-2 space-y-2">
                  <div className="flex gap-2">
                    <input
                      type="text"
                      value={stickerName}
                      onChange={(e) => setStickerName(e.target.value.slice(0, 32))}
                      placeholder="Sticker name"
                      className="input-standard flex-1"
                    />
                    <input
                      type="text"
                      value={stickerTags}
                      onChange={(e) => setStickerTags(e.target.value.slice(0, 100))}
                      placeholder="Tags (optional)"
                      className="input-standard flex-1"
                    />
                  </div>
                  <div className="flex items-center gap-2">
                    <input
                      ref={fileInputRef}
                      type="file"
                      accept="image/png,image/webp,image/gif"
                      onChange={(e) => setStickerFile(e.target.files?.[0] ?? null)}
                      className="text-sm text-txt-secondary file:mr-2 file:py-1 file:px-2 file:rounded file:border-0 file:text-xs file:bg-interactive-hover file:text-txt-primary hover:file:bg-interactive-active"
                    />
                    <button
                      onClick={handleUploadSticker}
                      disabled={uploading || !stickerFile || !stickerName.trim()}
                      className="px-3 py-1.5 bg-accent-primary hover:bg-accent-primary/80 text-white text-xs font-medium rounded transition-colors disabled:opacity-50 flex-shrink-0"
                    >
                      {uploading ? 'Uploading...' : 'Upload'}
                    </button>
                  </div>
                  <div className="text-[10px] text-txt-tertiary">
                    PNG, WebP, or GIF. Max 512x512px, 500KB.
                  </div>
                </div>
              )}

              {/* Sticker grid */}
              {pack.stickers.length > 0 && (
                <div className="grid grid-cols-5 gap-2 mt-2">
                  {pack.stickers.map((sticker) => (
                    <div
                      key={sticker.id}
                      className="relative group aspect-square rounded-lg bg-surface-base overflow-hidden"
                    >
                      <img
                        src={getStickerUrl(sticker)}
                        alt={sticker.name}
                        className="w-full h-full object-contain p-1"
                        loading="lazy"
                      />
                      <div className="absolute inset-0 bg-black/60 opacity-0 group-hover:opacity-100 transition-opacity flex items-center justify-center">
                        <button
                          onClick={() => setDeleteTarget({ type: 'sticker', id: sticker.id, name: sticker.name })}
                          className="p-1 text-white hover:text-txt-danger transition-colors"
                          title="Delete sticker"
                        >
                          <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
                            <path d="M6 19c0 1.1.9 2 2 2h8c1.1 0 2-.9 2-2V7H6v12zM19 4h-3.5l-1-1h-5l-1 1H5v2h14V4z" />
                          </svg>
                        </button>
                      </div>
                      <div className="absolute bottom-0 left-0 right-0 bg-black/60 px-1 py-0.5 text-[9px] text-white truncate opacity-0 group-hover:opacity-100 transition-opacity">
                        {sticker.name}
                      </div>
                    </div>
                  ))}
                </div>
              )}

              {pack.stickers.length === 0 && (
                <div className="text-xs text-txt-tertiary mt-1">No stickers in this pack yet.</div>
              )}
            </div>
          ))}
        </div>
      )}

      {/* Delete confirmation */}
      <ConfirmDialog
        isOpen={!!deleteTarget}
        onClose={() => setDeleteTarget(null)}
        title={`Delete ${deleteTarget?.type === 'pack' ? 'Sticker Pack' : 'Sticker'}`}
        description={`Are you sure you want to delete "${deleteTarget?.name}"?${
          deleteTarget?.type === 'pack' ? ' All stickers in this pack will be deleted.' : ''
        } Existing messages will show "Sticker unavailable".`}
        confirmLabel={deleting ? 'Deleting...' : 'Delete'}
        onConfirm={handleDelete}
        variant="danger"
        loading={deleting}
      />
    </div>
  );
}
