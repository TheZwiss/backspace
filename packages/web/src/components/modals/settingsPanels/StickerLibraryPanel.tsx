import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { Area } from 'react-easy-crop';
import {
  MAX_PRIVATE_STICKERS_PER_PACK,
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
import { describeError } from '../../../i18n/errors';

type SpaceLibrary = Awaited<ReturnType<typeof api.stickerLibrary.get>>['spaces'][number];

interface PendingImage {
  file: File;
  preview: string;
  packId: string;
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
    if (!file.size || file.size > max || !/^image\/(png|jpeg|webp|gif)$/.test(file.type)) {
      setError(t('chat:stickers.invalidType'));
      return;
    }
    const preview = URL.createObjectURL(file);
    setPending({ file, preview, packId: activePack.id });
  };

  const uploadCropped = async (_pixels: Area, percentage: Area) => {
    if (!pending) return;
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
        name: pending.file.name.replace(/\.[^.]+$/, '').slice(0, 100),
        image: await imageData(pending.file),
        crop,
      });
      URL.revokeObjectURL(pending.preview);
      setPending(null);
      setNotice(t('chat:stickers.saved'));
      await load();
    } catch (err) {
      setError(describeError(err));
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

  if (!items) {
    return <p className="text-sm text-txt-tertiary">{t('common:states.loading')}</p>;
  }

  return (
    <section className="space-y-5">
      <div>
        <h2 className="text-lg font-semibold text-txt-primary">{t('settings:stickers.title')}</h2>
        <p className="mt-1 text-sm text-txt-secondary">{t('settings:stickers.description')}</p>
      </div>

      {error && <p role="alert" className="rounded-lg bg-accent-rose/10 px-3 py-2 text-sm text-txt-danger">{error}</p>}
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
            <div>
              <h3 className="text-sm font-semibold text-txt-primary">{activePack.name}</h3>
              <p className="text-xs text-txt-tertiary">{activePack.itemCount}/{MAX_PRIVATE_STICKERS_PER_PACK}</p>
            </div>
            <button
              type="button"
              disabled={busy || activePack.itemCount >= MAX_PRIVATE_STICKERS_PER_PACK}
              onClick={() => fileRef.current?.click()}
              className="rounded-lg bg-accent-primary px-3 py-2 text-sm font-medium text-white disabled:opacity-40"
            >
              {t('chat:stickers.addMore')}
            </button>
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
          <div className="mt-4 grid grid-cols-4 gap-3 desktop:grid-cols-6">
            {activePack.items.map((item) => (
              <div key={item.id} className="group relative aspect-square rounded-xl bg-surface-base p-2">
                <img src={stickerImage(item.token)} alt={item.name} className="h-full w-full object-contain" />
                <button
                  type="button"
                  aria-label={t('chat:stickers.remove')}
                  onClick={() => void (async () => {
                    await api.stickerLibrary.removeItem(activePack.id, item.id);
                    await load();
                  })().catch((err) => setError(describeError(err)))}
                  className="absolute right-1 top-1 rounded-full bg-surface-overlay px-1.5 text-xs text-accent-rose opacity-0 group-hover:opacity-100"
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
        <div className="mt-3 grid grid-cols-5 gap-2 desktop:grid-cols-8">
          {items.favorites.map((favorite) => (
            <div key={favorite.id} className="group relative aspect-square rounded-lg bg-surface-base p-1.5">
              <img src={stickerImage(favorite.token)} alt={favorite.name} className="h-full w-full object-contain" />
              <div className="absolute inset-x-1 bottom-1 hidden gap-1 group-hover:flex">
                <button
                  type="button"
                  disabled={!activePack}
                  onClick={() => void (async () => {
                    if (!activePack) return;
                    const name = window.prompt(t('settings:stickers.itemName'), favorite.name)?.trim();
                    if (!name) return;
                    await api.stickerLibrary.addFavoriteToPack(activePack.id, { favoriteId: favorite.id, name });
                    await load();
                  })().catch((err) => setError(describeError(err)))}
                  className="min-w-0 flex-1 truncate rounded bg-accent-primary px-1 py-0.5 text-[10px] text-white disabled:opacity-40"
                >
                  +
                </button>
                <button
                  type="button"
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
          if (pending) URL.revokeObjectURL(pending.preview);
          setPending(null);
        }}
        imageSrc={pending?.preview ?? ''}
        title={t('settings:stickers.cropTitle')}
        cropShape="rect"
        aspectRatio={1}
        onCropComplete={() => {}}
        onCropSelection={uploadCropped}
      />
    </section>
  );
}
