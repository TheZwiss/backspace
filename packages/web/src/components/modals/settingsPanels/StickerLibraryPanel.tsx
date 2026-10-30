import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { Area } from 'react-easy-crop';
import {
  MAX_PRIVATE_STICKERS_PER_PACK,
  MAX_STICKER_NAME_LENGTH,
  normalizeStickerName,
  stickerPreviewUrl,
  stickerUrl,
  type FavoriteSticker,
  type StickerCrop,
  type StickerPackDetail,
} from '@backspace/shared/src/stickers';
import { api } from '../../../api/client';
import { useAuthStore } from '../../../stores/authStore';
import { useHomeInstanceInfo } from '../../../hooks/useHomeInstanceInfo';
import { ImageCropModal } from '../../ui/ImageCropModal';
import { ConfirmDialog } from '../../ui/ConfirmDialog';
import { describeError } from '../../../i18n/errors';

type SpaceLibrary = Awaited<ReturnType<typeof api.stickerLibrary.get>>['spaces'][number];

interface PendingImage {
  file: File;
  preview: string;
  packId: string;
  name: string;
}

function imageData(file: File | Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(',')[1] ?? '');
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}

function stickerImage(token: string): string {
  return stickerPreviewUrl(token) ?? stickerUrl(token) ?? '';
}

export function StickerLibraryPanel() {
  const { t } = useTranslation(['settings', 'chat', 'common']);
  const user = useAuthStore((state) => state.user);
  const home = useHomeInstanceInfo();
  const fileRef = useRef<HTMLInputElement>(null);
  const [items, setItems] = useState<{
    privatePacks: StickerPackDetail[];
    spaces: SpaceLibrary[];
    favorites: FavoriteSticker[];
  } | null>(null);
  const [activePackId, setActivePackId] = useState('');
  const [newPackName, setNewPackName] = useState('');
  const [shareTargets, setShareTargets] = useState<Record<string, string>>({});
  const [pending, setPending] = useState<PendingImage | null>(null);
  const [packToDelete, setPackToDelete] = useState<StickerPackDetail | null>(null);
  const [renamingPack, setRenamingPack] = useState(false);
  const [packNameDraft, setPackNameDraft] = useState('');
  const [renamingItem, setRenamingItem] = useState<{ id: string; name: string } | null>(null);
  const [favoriteToAdd, setFavoriteToAdd] = useState<FavoriteSticker | null>(null);
  const [favoriteNameDraft, setFavoriteNameDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');

  const load = async () => {
    try {
      const next = await api.stickerLibrary.get();
      setItems(next);
      setActivePackId((current) => (
        current && next.privatePacks.some((pack) => pack.id === current)
          ? current
          : next.privatePacks[0]?.id ?? ''
      ));
    } catch (err) {
      setError(describeError(err));
    }
  };

  useEffect(() => {
    if (user?.id) void load();
  }, [user?.id]);

  useEffect(() => () => {
    if (pending) URL.revokeObjectURL(pending.preview);
  }, [pending]);

  const activePack = items?.privatePacks.find((pack) => pack.id === activePackId) ?? null;

  const chooseFiles = (files: FileList | null) => {
    const file = files?.[0];
    if (!file || !activePack) return;
    setError('');
    setNotice('');
    const max = (home?.maxStickerSizeMb ?? 5) * 1024 * 1024;
    if (!file.size || file.size > max) {
      setError(t('chat:stickers.invalidSize'));
      return;
    }
    if (!/^image\/(png|jpeg|webp|gif)$/.test(file.type)) {
      setError(t('chat:stickers.invalidType'));
      return;
    }
    const preview = URL.createObjectURL(file);
    setPending({
      file,
      preview,
      packId: activePack.id,
      name: file.name.replace(/\.[^.]+$/, '').slice(0, MAX_STICKER_NAME_LENGTH),
    });
  };

  const uploadCropped = async (_pixels: Area, percentage: Area) => {
    if (!pending) return;
    const name = normalizeStickerName(pending.name);
    if (!name) {
      setError(t('chat:stickers.invalidName'));
      throw new Error('invalid sticker name');
    }
    setBusy(true);
    setError('');
    try {
      const crop: StickerCrop = {
        x: percentage.x / 100,
        y: percentage.y / 100,
        width: percentage.width / 100,
        height: percentage.height / 100,
      };
      await api.stickerLibrary.addItem(pending.packId, {
        name,
        image: await imageData(pending.file),
        crop,
      });
      URL.revokeObjectURL(pending.preview);
      setPending(null);
      setNotice(t('chat:stickers.saved'));
      await load();
    } catch (err) {
      setError(describeError(err));
      throw err;
    } finally {
      setBusy(false);
    }
  };

  const createPack = async () => {
    const name = newPackName.trim();
    if (!name) return;
    setBusy(true);
    setError('');
    try {
      const pack = await api.stickerLibrary.createPrivatePack({ name });
      setNewPackName('');
      setActivePackId(pack.id);
      await load();
    } catch (err) {
      setError(describeError(err));
    } finally {
      setBusy(false);
    }
  };

  const sharePack = async () => {
    if (!activePack) return;
    const target = shareTargets[activePack.id] ?? 'instance';
    setBusy(true);
    setError('');
    try {
      await api.stickerLibrary.requestShare(activePack.id, target === 'instance'
        ? { targetType: 'instance' }
        : { targetType: 'space', targetId: target });
      setNotice(t('settings:stickers.shareRequested'));
      await load();
    } catch (err) {
      setError(describeError(err));
    } finally {
      setBusy(false);
    }
  };

  const renamePack = async () => {
    if (!activePack) return;
    const name = normalizeStickerName(packNameDraft);
    if (!name) {
      setError(t('chat:stickers.invalidName'));
      return;
    }
    setBusy(true);
    setError('');
    try {
      await api.stickerLibrary.renamePrivatePack(activePack.id, name);
      setRenamingPack(false);
      await load();
    } catch (err) {
      setError(describeError(err));
    } finally {
      setBusy(false);
    }
  };

  const deletePack = async () => {
    if (!packToDelete) return;
    setBusy(true);
    setError('');
    try {
      await api.stickerLibrary.deletePrivatePack(packToDelete.id);
      setPackToDelete(null);
      setNotice(t('settings:stickers.deletePackSuccess'));
      await load();
    } catch (err) {
      setError(describeError(err));
    } finally {
      setBusy(false);
    }
  };

  const renameItem = async () => {
    if (!activePack || !renamingItem) return;
    const name = normalizeStickerName(renamingItem.name);
    if (!name) {
      setError(t('chat:stickers.invalidName'));
      return;
    }
    setBusy(true);
    setError('');
    try {
      await api.stickerLibrary.renameItem(activePack.id, renamingItem.id, name);
      setRenamingItem(null);
      await load();
    } catch (err) {
      setError(describeError(err));
    } finally {
      setBusy(false);
    }
  };

  const addFavorite = async () => {
    if (!activePack || !favoriteToAdd) return;
    const name = normalizeStickerName(favoriteNameDraft);
    if (!name) {
      setError(t('chat:stickers.invalidName'));
      return;
    }
    setBusy(true);
    setError('');
    try {
      await api.stickerLibrary.addFavoriteToPack(activePack.id, { favoriteId: favoriteToAdd.id, name });
      setFavoriteToAdd(null);
      await load();
    } catch (err) {
      setError(describeError(err));
    } finally {
      setBusy(false);
    }
  };

  if (!items) {
    return <p className="text-sm text-txt-tertiary">{t('common:states.loading')}</p>;
  }

  return (
    <section className="space-y-5">
      <div>
        <h2 className="text-lg font-semibold text-txt-primary">{t('settings:stickers.title')}</h2>
        <p className="mt-1 text-sm text-txt-secondary">{t('settings:stickers.description')}</p>
      </div>

      {error && !pending && <p role="alert" className="rounded-lg bg-accent-rose/10 px-3 py-2 text-sm text-txt-danger">{error}</p>}
      {notice && <p role="status" className="rounded-lg bg-accent-mint/10 px-3 py-2 text-sm text-txt-positive">{notice}</p>}

      <div className="rounded-xl border border-border-soft bg-surface-elevated/50 p-4">
        <h3 className="text-sm font-semibold text-txt-primary">{t('settings:stickers.packs')}</h3>
        <div className="mt-3 flex flex-wrap gap-2">
          {items.privatePacks.map((pack) => (
            <button
              key={pack.id}
              type="button"
              onClick={() => setActivePackId(pack.id)}
              className={`rounded-lg px-3 py-2 text-sm ${pack.id === activePackId ? 'bg-accent-primary text-white' : 'bg-interactive-hover text-txt-secondary'}`}
            >
              {pack.name} <span className="text-xs opacity-70">{pack.itemCount}/{MAX_PRIVATE_STICKERS_PER_PACK}</span>
            </button>
          ))}
        </div>
        <div className="mt-3 flex gap-2">
          <input
            value={newPackName}
            onChange={(event) => setNewPackName(event.target.value)}
            maxLength={100}
            placeholder={t('settings:stickers.newPack')}
            className="input-standard min-w-0 flex-1"
          />
          <button type="button" disabled={busy || !newPackName.trim()} onClick={() => void createPack()} className="rounded-lg bg-accent-primary px-3 py-2 text-sm text-white disabled:opacity-40">
            {t('settings:stickers.createPack')}
          </button>
        </div>
      </div>

      {activePack && (
        <div className="rounded-xl border border-border-soft bg-surface-elevated/50 p-4">
          <div className="flex flex-wrap items-center justify-between gap-3">
            {renamingPack ? (
              <form
                className="flex min-w-0 flex-1 flex-wrap items-center gap-2"
                onSubmit={(event) => {
                  event.preventDefault();
                  void renamePack();
                }}
              >
                <input
                  autoFocus
                  value={packNameDraft}
                  maxLength={MAX_STICKER_NAME_LENGTH}
                  onChange={(event) => setPackNameDraft(event.target.value)}
                  aria-label={t('chat:stickers.packName')}
                  className="input-standard min-w-48 flex-1"
                />
                <button type="submit" disabled={busy || !normalizeStickerName(packNameDraft)} className="sticker-primary-button">
                  {t('chat:stickers.save')}
                </button>
                <button type="button" disabled={busy} onClick={() => setRenamingPack(false)} className="sticker-secondary-button">
                  {t('chat:stickers.cancel')}
                </button>
              </form>
            ) : (
              <div className="min-w-0">
                <h3 className="truncate text-sm font-semibold text-txt-primary">{activePack.name}</h3>
                <p className="text-xs text-txt-tertiary">{activePack.itemCount}/{MAX_PRIVATE_STICKERS_PER_PACK}</p>
              </div>
            )}
            {!renamingPack && (
              <div className="flex flex-wrap items-center gap-2">
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => {
                    setPackNameDraft(activePack.name);
                    setRenamingPack(true);
                  }}
                  className="sticker-secondary-button"
                >
                  {t('chat:stickers.rename')}
                </button>
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => setPackToDelete(activePack)}
                  className="sticker-secondary-button text-txt-danger hover:bg-accent-rose/10"
                >
                  {t('settings:stickers.deletePack')}
                </button>
                <button
                  type="button"
                  disabled={busy || activePack.itemCount >= MAX_PRIVATE_STICKERS_PER_PACK}
                  onClick={() => fileRef.current?.click()}
                  className="rounded-lg bg-accent-primary px-3 py-2 text-sm font-medium text-white disabled:opacity-40"
                >
                  {t('chat:stickers.addMore')}
                </button>
              </div>
            )}
          </div>
          <input
            ref={fileRef}
            type="file"
            accept="image/png,image/jpeg,image/webp,image/gif"
            className="hidden"
            onChange={(event) => {
              chooseFiles(event.target.files);
              event.target.value = '';
            }}
          />
          {renamingItem && (
            <form
              className="mt-4 flex flex-wrap items-center gap-2 rounded-lg border border-border-soft bg-surface-base/50 p-2"
              onSubmit={(event) => {
                event.preventDefault();
                void renameItem();
              }}
            >
              <input
                autoFocus
                value={renamingItem.name}
                maxLength={MAX_STICKER_NAME_LENGTH}
                onChange={(event) => setRenamingItem({ ...renamingItem, name: event.target.value })}
                aria-label={t('settings:stickers.itemName')}
                className="input-standard min-w-48 flex-1"
              />
              <button type="submit" disabled={busy || !normalizeStickerName(renamingItem.name)} className="sticker-primary-button">
                {t('chat:stickers.save')}
              </button>
              <button type="button" disabled={busy} onClick={() => setRenamingItem(null)} className="sticker-secondary-button">
                {t('chat:stickers.cancel')}
              </button>
            </form>
          )}
          <div className="mt-4 grid grid-cols-4 gap-3 desktop:grid-cols-6">
            {activePack.items.map((item) => (
              <div key={item.id} className="group relative aspect-square rounded-xl bg-surface-base p-2">
                <img src={stickerImage(item.token)} alt={item.name} className="h-full w-full object-contain" />
                <button
                  type="button"
                  aria-label={t('chat:stickers.renameNamed', { name: item.name })}
                  onClick={() => setRenamingItem({ id: item.id, name: item.name })}
                  className="absolute left-1 top-1 rounded-full bg-surface-overlay px-1.5 text-xs text-txt-secondary opacity-100 transition-opacity focus-visible:opacity-100 sm:opacity-0 sm:group-hover:opacity-100 sm:group-focus-within:opacity-100"
                >
                  ✎
                </button>
                <button
                  type="button"
                  aria-label={t('chat:stickers.remove')}
                  onClick={() => void (async () => {
                    await api.stickerLibrary.removeItem(activePack.id, item.id);
                    await load();
                  })().catch((err) => setError(describeError(err)))}
                  className="absolute right-1 top-1 rounded-full bg-surface-overlay px-1.5 text-xs text-accent-rose opacity-100 transition-opacity focus-visible:opacity-100 sm:opacity-0 sm:group-hover:opacity-100 sm:group-focus-within:opacity-100"
                >
                  ×
                </button>
              </div>
            ))}
          </div>
        </div>
      )}

      <div className="rounded-xl border border-border-soft bg-surface-elevated/50 p-4">
        <h3 className="text-sm font-semibold text-txt-primary">{t('settings:stickers.favorites')}</h3>
        <p className="mt-1 text-xs text-txt-tertiary">{t('settings:stickers.favoritesHint')}</p>
        {favoriteToAdd && activePack && (
          <form
            className="mt-3 flex flex-wrap items-center gap-2 rounded-lg border border-border-soft bg-surface-base/50 p-2"
            onSubmit={(event) => {
              event.preventDefault();
              void addFavorite();
            }}
          >
            <input
              autoFocus
              value={favoriteNameDraft}
              maxLength={MAX_STICKER_NAME_LENGTH}
              onChange={(event) => setFavoriteNameDraft(event.target.value)}
              aria-label={t('settings:stickers.itemName')}
              className="input-standard min-w-48 flex-1"
            />
            <button type="submit" disabled={busy || !normalizeStickerName(favoriteNameDraft)} className="sticker-primary-button">
              {t('chat:stickers.addMore')}
            </button>
            <button type="button" disabled={busy} onClick={() => setFavoriteToAdd(null)} className="sticker-secondary-button">
              {t('chat:stickers.cancel')}
            </button>
          </form>
        )}
        <div className="mt-3 grid grid-cols-5 gap-2 desktop:grid-cols-8">
          {items.favorites.map((favorite) => (
            <div key={favorite.id} className="group relative aspect-square rounded-lg bg-surface-base p-1.5">
              <img src={stickerImage(favorite.token)} alt={favorite.name} className="h-full w-full object-contain" />
              <div className="absolute inset-x-1 bottom-1 flex gap-1 opacity-100 sm:opacity-0 sm:group-hover:opacity-100 sm:group-focus-within:opacity-100">
                <button
                  type="button"
                  disabled={!activePack}
                  aria-label={`${t('settings:stickers.itemName')}: ${favorite.name}`}
                  onClick={() => {
                    setFavoriteToAdd(favorite);
                    setFavoriteNameDraft(favorite.name);
                  }}
                  className="min-w-0 flex-1 truncate rounded bg-accent-primary px-1 py-0.5 text-[10px] text-white disabled:opacity-40"
                >
                  +
                </button>
                <button
                  type="button"
                  aria-label={`${t('chat:stickers.remove')}: ${favorite.name}`}
                  onClick={() => void (async () => {
                    await api.stickerLibrary.unfavorite(favorite.id);
                    await load();
                  })().catch((err) => setError(describeError(err)))}
                  className="rounded bg-surface-overlay px-1 py-0.5 text-[10px] text-accent-rose"
                >
                  ×
                </button>
              </div>
            </div>
          ))}
        </div>
        {!items.favorites.length && <p className="mt-2 text-xs text-txt-tertiary">{t('settings:stickers.noFavorites')}</p>}
      </div>

      {activePack && (
        <div className="rounded-xl border border-border-soft bg-surface-elevated/50 p-4">
          <h3 className="text-sm font-semibold text-txt-primary">{t('settings:stickers.share')}</h3>
          <div className="mt-3 flex flex-wrap gap-2">
            <select
              value={shareTargets[activePack.id] ?? 'instance'}
              onChange={(event) => setShareTargets((current) => ({ ...current, [activePack.id]: event.target.value }))}
              className="input-standard min-w-48"
            >
              <option value="instance">{t('settings:stickers.instance')}</option>
              {items.spaces.map((space) => (
                <option key={space.spaceId} value={space.spaceId}>{space.name}</option>
              ))}
            </select>
            <button type="button" disabled={busy} onClick={() => void sharePack()} className="rounded-lg bg-accent-primary px-3 py-2 text-sm text-white disabled:opacity-40">
              {t('settings:stickers.requestShare')}
            </button>
          </div>
          <div className="mt-3 space-y-1 text-xs text-txt-tertiary">
            {(activePack.shares ?? []).map((share) => (
              <p key={share.id}>
                {share.targetType === 'instance'
                  ? t('settings:stickers.instance')
                  : items.spaces.find((space) => space.spaceId === share.targetId)?.name ?? share.targetId}
                {' · '}{share.status}
              </p>
            ))}
          </div>
        </div>
      )}

      <ImageCropModal
        isOpen={!!pending}
        onClose={() => {
          if (busy) return;
          if (pending) URL.revokeObjectURL(pending.preview);
          setPending(null);
        }}
        imageSrc={pending?.preview ?? ''}
        title={t('settings:stickers.cropTitle')}
        cropShape="rect"
        aspectRatio={1}
        onCropComplete={() => {}}
        onCropSelection={uploadCropped}
        error={pending ? error : undefined}
        applyDisabled={!pending || !normalizeStickerName(pending.name)}
        extraContent={pending ? (
          <label className="block">
            <span className="mb-1.5 block text-xs font-medium text-txt-secondary">{t('settings:stickers.itemName')}</span>
            <input
              autoFocus
              value={pending.name}
              maxLength={MAX_STICKER_NAME_LENGTH}
              onChange={(event) => setPending({ ...pending, name: event.target.value })}
              className="input-standard w-full"
            />
          </label>
        ) : null}
      />

      <ConfirmDialog
        isOpen={!!packToDelete}
        onClose={() => { if (!busy) setPackToDelete(null); }}
        onConfirm={() => void deletePack()}
        title={t('settings:stickers.deletePackTitle', { name: packToDelete?.name ?? '' })}
        description={t('settings:stickers.deletePackDescription')}
        confirmLabel={t('settings:stickers.deletePack')}
        loading={busy}
      />
    </section>
  );
}
