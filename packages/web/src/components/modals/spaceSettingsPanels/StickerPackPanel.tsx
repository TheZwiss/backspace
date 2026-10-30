import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { Area } from 'react-easy-crop';
import {
  MAX_SPACE_STICKERS,
  MAX_STICKER_NAME_LENGTH,
  normalizeStickerName,
  stickerPreviewUrl,
  stickerUrl,
  type StickerCrop,
  type StickerPackDetail,
  type StickerPackShare,
} from '@backspace/shared/src/stickers';
import { api } from '../../../api/client';
import { useHomeInstanceInfo } from '../../../hooks/useHomeInstanceInfo';
import { ImageCropModal } from '../../ui/ImageCropModal';
import { describeError } from '../../../i18n/errors';

interface PendingImage {
  file: File;
  preview: string;
  name: string;
}

function imageData(file: File): Promise<string> {
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

export function StickerPackPanel({ spaceId }: { spaceId: string }) {
  const { t } = useTranslation(['spaces', 'chat', 'common', 'settings']);
  const home = useHomeInstanceInfo();
  const inputRef = useRef<HTMLInputElement>(null);
  const [pack, setPack] = useState<StickerPackDetail | null>(null);
  const [canCreate, setCanCreate] = useState(false);
  const [canManage, setCanManage] = useState(false);
  const [pending, setPending] = useState<PendingImage | null>(null);
  const [renamingItem, setRenamingItem] = useState<{ id: string; name: string } | null>(null);
  const [shares, setShares] = useState<Array<StickerPackShare & { pack: StickerPackDetail | null }>>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');

  const load = useCallback(async () => {
    try {
      const library = await api.stickerLibrary.get();
      const space = library.spaces.find((entry) => entry.spaceId === spaceId);
      setPack(space?.pack ?? null);
      setCanCreate(space?.canCreate ?? false);
      setCanManage(space?.canManage ?? false);
      if (space?.canManage) setShares(await api.stickerLibrary.listShares({ targetType: 'space', targetId: spaceId }));
      else setShares([]);
    } catch (err) {
      setError(describeError(err));
    }
  }, [spaceId]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => () => {
    if (pending) URL.revokeObjectURL(pending.preview);
  }, [pending]);

  const createPack = async () => {
    setBusy(true);
    setError('');
    try {
      const created = await api.stickerLibrary.createSpacePack(spaceId);
      setPack(created);
      await load();
    } catch (err) {
      setError(describeError(err));
    } finally {
      setBusy(false);
    }
  };

  const chooseFile = (files: FileList | null) => {
    const file = files?.[0];
    if (!file) return;
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
    setPending({
      file,
      preview: URL.createObjectURL(file),
      name: file.name.replace(/\.[^.]+$/, '').slice(0, MAX_STICKER_NAME_LENGTH),
    });
  };

  const upload = async (_pixels: Area, percentage: Area) => {
    if (!pack || !pending) return;
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
      await api.stickerLibrary.addItem(pack.id, {
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

  const renameItem = async () => {
    if (!pack || !renamingItem) return;
    const name = normalizeStickerName(renamingItem.name);
    if (!name) {
      setError(t('chat:stickers.invalidName'));
      return;
    }
    setBusy(true);
    setError('');
    try {
      await api.stickerLibrary.renameItem(pack.id, renamingItem.id, name);
      setRenamingItem(null);
      await load();
    } catch (err) {
      setError(describeError(err));
    } finally {
      setBusy(false);
    }
  };

  const decide = async (id: string, decision: 'approved' | 'rejected') => {
    setBusy(true);
    try {
      await api.stickerLibrary.decideShare(id, decision);
      await load();
    } catch (err) {
      setError(describeError(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="space-y-5">
      <div>
        <h2 className="text-lg font-semibold text-txt-primary">{t('spaces:stickers.title')}</h2>
        <p className="mt-1 text-sm text-txt-secondary">{t('spaces:stickers.description')}</p>
      </div>
      {error && !pending && <p role="alert" className="rounded-lg bg-accent-rose/10 px-3 py-2 text-sm text-txt-danger">{error}</p>}
      {notice && <p role="status" className="rounded-lg bg-accent-mint/10 px-3 py-2 text-sm text-txt-positive">{notice}</p>}

      {!pack ? (
        <div className="rounded-xl border border-border-soft bg-surface-elevated/50 p-5 text-center">
          <p className="text-sm text-txt-secondary">{t('spaces:stickers.empty')}</p>
          {(canCreate || canManage) && (
            <button type="button" disabled={busy} onClick={() => void createPack()} className="mt-3 rounded-lg bg-accent-primary px-4 py-2 text-sm font-medium text-white disabled:opacity-40">
              {t('spaces:stickers.create')}
            </button>
          )}
        </div>
      ) : (
        <div className="rounded-xl border border-border-soft bg-surface-elevated/50 p-4">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <h3 className="text-sm font-semibold text-txt-primary">{pack.name}</h3>
              <p className="text-xs text-txt-tertiary">{pack.itemCount}/{MAX_SPACE_STICKERS}</p>
            </div>
            {(pack.canAdd || pack.canManage) && (
              <button
                type="button"
                disabled={busy || pack.itemCount >= MAX_SPACE_STICKERS}
                onClick={() => inputRef.current?.click()}
                className="rounded-lg bg-accent-primary px-3 py-2 text-sm font-medium text-white disabled:opacity-40"
              >
                {t('spaces:stickers.add')}
              </button>
            )}
          </div>
          <input
            ref={inputRef}
            type="file"
            accept="image/png,image/jpeg,image/webp,image/gif"
            className="hidden"
            onChange={(event) => {
              chooseFile(event.target.files);
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
            {pack.items.map((item) => (
              <div key={item.id} className="group relative aspect-square rounded-xl bg-surface-base p-2">
                <img src={stickerImage(item.token)} alt={item.name} className="h-full w-full object-contain" />
                {pack.canManage && (
                  <>
                    <button
                      type="button"
                      onClick={() => setRenamingItem({ id: item.id, name: item.name })}
                      className="absolute left-1 top-1 rounded-full bg-surface-overlay px-1.5 text-xs text-txt-secondary opacity-100 transition-opacity focus-visible:opacity-100 sm:opacity-0 sm:group-hover:opacity-100 sm:group-focus-within:opacity-100"
                      aria-label={t('chat:stickers.renameNamed', { name: item.name })}
                    >
                      ✎
                    </button>
                    <button
                      type="button"
                      onClick={() => void (async () => {
                        await api.stickerLibrary.removeItem(pack.id, item.id);
                        await load();
                      })().catch((err) => setError(describeError(err)))}
                      className="absolute right-1 top-1 rounded-full bg-surface-overlay px-1.5 text-xs text-accent-rose opacity-100 transition-opacity focus-visible:opacity-100 sm:opacity-0 sm:group-hover:opacity-100 sm:group-focus-within:opacity-100"
                      aria-label={t('chat:stickers.remove')}
                    >
                      ×
                    </button>
                  </>
                )}
              </div>
            ))}
          </div>
        </div>
      )}

      {canManage && shares.length > 0 && (
        <div className="rounded-xl border border-border-soft bg-surface-elevated/50 p-4">
          <h3 className="text-sm font-semibold text-txt-primary">{t('spaces:stickers.pendingShares')}</h3>
          <div className="mt-3 space-y-3">
            {shares.map((share) => (
              <div key={share.id} className="flex flex-wrap items-center justify-between gap-3 rounded-lg bg-surface-base/60 p-3">
                <div>
                  <p className="text-sm font-medium text-txt-primary">{share.pack?.name ?? share.packId}</p>
                  <p className="text-xs text-txt-tertiary">{t('spaces:stickers.sharePending')}</p>
                </div>
                <div className="flex gap-2">
                  <button type="button" disabled={busy} onClick={() => void decide(share.id, 'rejected')} className="rounded-lg bg-accent-rose/10 px-3 py-1.5 text-xs text-accent-rose">
                    {t('spaces:stickers.reject')}
                  </button>
                  <button type="button" disabled={busy} onClick={() => void decide(share.id, 'approved')} className="rounded-lg bg-accent-mint/10 px-3 py-1.5 text-xs text-accent-mint">
                    {t('spaces:stickers.approve')}
                  </button>
                </div>
              </div>
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
        onCropSelection={upload}
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
    </section>
  );
}
