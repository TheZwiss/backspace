import { useCallback, useEffect, useRef, useState, type ChangeEvent } from 'react';
import { useTranslation } from 'react-i18next';
import type { BotSpaceOption, BotSummary } from '@backspace/shared';
import { BOT_NAME_MAX_LENGTH, BOT_NAME_SUFFIX, MAX_BOTS_PER_USER } from '@backspace/shared/src/constants';
import { api } from '../../../api/client';
import { describeError } from '../../../i18n/errors';
import { useFormatters } from '../../../i18n/formatters';
import { Avatar } from '../../ui/Avatar';
import { ImageCropModal } from '../../ui/ImageCropModal';
import { useTransferStore } from '../../../stores/transferStore';
import { waitForTransferAttachment } from '../../../utils/waitForTransfer';

interface RevealedToken {
  username: string;
  token: string;
}

const buttonClass =
  'px-3 py-1.5 rounded-md text-sm bg-interactive-selected text-txt-primary hover:bg-interactive-hover transition-colors disabled:opacity-50';
const quietButtonClass =
  'px-3 py-1.5 rounded-md text-sm text-txt-tertiary hover:text-txt-secondary hover:bg-interactive-hover transition-colors disabled:opacity-50';
const dangerButtonClass =
  'px-3 py-1.5 rounded-md text-sm text-txt-danger hover:bg-accent-rose/10 transition-colors disabled:opacity-50';

/** The editable part of a bot name: everything before the fixed `_bot` suffix. */
function stemOf(value: string): string {
  const trimmed = value.trim();
  return trimmed.endsWith(BOT_NAME_SUFFIX) ? trimmed.slice(0, -BOT_NAME_SUFFIX.length).trim() : trimmed;
}

export function BotsPanel() {
  const { t } = useTranslation(['settings']);
  const { formatMediumDate } = useFormatters();
  const [bots, setBots] = useState<BotSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [revealed, setRevealed] = useState<RevealedToken | null>(null);
  const [copied, setCopied] = useState(false);
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editName, setEditName] = useState('');
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [avatarBotId, setAvatarBotId] = useState<string | null>(null);
  const [cropSrc, setCropSrc] = useState<string | null>(null);
  const [spacesBotId, setSpacesBotId] = useState<string | null>(null);
  const [spaceOptions, setSpaceOptions] = useState<BotSpaceOption[]>([]);
  const [spacesLoading, setSpacesLoading] = useState(false);

  const load = useCallback(async () => {
    try {
      const res = await api.bots.list();
      setBots(res.bots);
      setError(null);
    } catch (err) {
      setError(describeError(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const handleCreate = async () => {
    setBusy(true);
    setError(null);
    try {
      const res = await api.bots.create({ name: stemOf(name) + BOT_NAME_SUFFIX });
      setBots((prev) => [...prev, res.bot]);
      setRevealed({ username: res.bot.username, token: res.token });
      setCopied(false);
      setName('');
    } catch (err) {
      setError(describeError(err));
    } finally {
      setBusy(false);
    }
  };

  const handleRegenerate = async (bot: BotSummary) => {
    setBusy(true);
    setError(null);
    try {
      const res = await api.bots.regenerateToken(bot.id);
      setRevealed({ username: bot.username, token: res.token });
      setCopied(false);
    } catch (err) {
      setError(describeError(err));
    } finally {
      setBusy(false);
    }
  };

  const handleDelete = async (bot: BotSummary) => {
    setBusy(true);
    setError(null);
    try {
      await api.bots.delete(bot.id);
      setBots((prev) => prev.filter((b) => b.id !== bot.id));
      setConfirmDeleteId(null);
      setRevealed((prev) => (prev?.username === bot.username ? null : prev));
    } catch (err) {
      setError(describeError(err));
    } finally {
      setBusy(false);
    }
  };

  const startEdit = (bot: BotSummary) => {
    setEditingId(bot.id);
    setEditName(stemOf(bot.displayName || bot.username));
    setConfirmDeleteId(null);
    setError(null);
  };

  const handleSaveEdit = async (bot: BotSummary) => {
    setBusy(true);
    setError(null);
    try {
      const res = await api.bots.update(bot.id, { displayName: stemOf(editName) + BOT_NAME_SUFFIX });
      setBots((prev) => prev.map((b) => (b.id === bot.id ? res.bot : b)));
      setEditingId(null);
    } catch (err) {
      setError(describeError(err));
    } finally {
      setBusy(false);
    }
  };

  const pickAvatar = (bot: BotSummary) => {
    setAvatarBotId(bot.id);
    setError(null);
    fileInputRef.current?.click();
  };

  const handleFileChosen = (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    if (!file.type.startsWith('image/')) {
      setError(t('settings:bots.avatar.notImage'));
      return;
    }
    setCropSrc(URL.createObjectURL(file));
  };

  const closeCrop = () => {
    if (cropSrc) URL.revokeObjectURL(cropSrc);
    setCropSrc(null);
  };

  const handleCropComplete = async (blob: Blob) => {
    const botId = avatarBotId;
    if (!botId) return;
    setBusy(true);
    setError(null);
    try {
      let filename: string;
      try {
        const file = new File([blob], 'avatar.webp', { type: blob.type || 'image/webp' });
        const tid = await useTransferStore.getState().startUpload(file, { tray: false });
        ({ filename } = await waitForTransferAttachment(tid));
      } catch (uploadErr) {
        console.warn('[bot avatar upload]', uploadErr);
        const detail = uploadErr instanceof Error && uploadErr.message ? `: ${uploadErr.message}` : '';
        setError(`${t('settings:bots.avatar.uploadFailed')}${detail}`);
        return;
      }
      const res = await api.bots.update(botId, { avatar: filename });
      setBots((prev) => prev.map((b) => (b.id === botId ? res.bot : b)));
    } catch (err) {
      setError(describeError(err));
    } finally {
      setBusy(false);
      setAvatarBotId(null);
    }
  };

  const handleRemoveAvatar = async (bot: BotSummary) => {
    setBusy(true);
    setError(null);
    try {
      const res = await api.bots.update(bot.id, { avatar: null });
      setBots((prev) => prev.map((b) => (b.id === bot.id ? res.bot : b)));
    } catch (err) {
      setError(describeError(err));
    } finally {
      setBusy(false);
    }
  };

  const toggleSpaces = async (bot: BotSummary) => {
    if (spacesBotId === bot.id) {
      setSpacesBotId(null);
      return;
    }
    setSpacesBotId(bot.id);
    setSpaceOptions([]);
    setSpacesLoading(true);
    setError(null);
    try {
      const res = await api.bots.spaces(bot.id);
      setSpaceOptions(res.spaces);
    } catch (err) {
      setError(describeError(err));
      setSpacesBotId(null);
    } finally {
      setSpacesLoading(false);
    }
  };

  const handleAddToSpace = async (bot: BotSummary, spaceId: string) => {
    setBusy(true);
    setError(null);
    try {
      await api.bots.addToSpace(bot.id, spaceId);
      setSpaceOptions((prev) => prev.map((s) => (s.id === spaceId ? { ...s, botIsMember: true } : s)));
    } catch (err) {
      setError(describeError(err));
    } finally {
      setBusy(false);
    }
  };

  const handleRemoveFromSpace = async (bot: BotSummary, spaceId: string) => {
    setBusy(true);
    setError(null);
    try {
      await api.bots.removeFromSpace(bot.id, spaceId);
      setSpaceOptions((prev) => prev.map((s) => (s.id === spaceId ? { ...s, botIsMember: false } : s)));
    } catch (err) {
      setError(describeError(err));
    } finally {
      setBusy(false);
    }
  };

  const handleCopy = () => {
    if (!revealed) return;
    Promise.resolve()
      .then(() => navigator.clipboard.writeText(revealed.token))
      .then(() => setCopied(true))
      .catch(() => setCopied(false));
  };

  return (
    <div className="space-y-5">
      <h2 className="text-lg font-semibold text-txt-primary mb-2">{t('settings:bots.title')}</h2>
      <p className="text-sm text-txt-tertiary">{t('settings:bots.description')}</p>

      {error && (
        <div className="rounded-lg bg-accent-rose/10 border border-accent-rose/20 p-3 text-sm text-txt-danger">
          {error}
        </div>
      )}

      {revealed && (
        <div className="rounded-lg bg-white/[0.03] border border-white/[0.04] p-3.5 space-y-2">
          <div className="text-sm font-medium text-txt-primary">
            {t('settings:bots.token.title', { name: revealed.username })}
          </div>
          <div className="text-xs text-txt-tertiary">{t('settings:bots.token.warning')}</div>
          <code className="block break-all rounded-md bg-surface-input p-2 text-xs text-txt-primary select-all">
            {revealed.token}
          </code>
          <div className="flex gap-2">
            <button type="button" className={buttonClass} onClick={handleCopy}>
              {copied ? t('settings:bots.token.copied') : t('settings:bots.token.copy')}
            </button>
            <button type="button" className={quietButtonClass} onClick={() => setRevealed(null)}>
              {t('settings:bots.token.dismiss')}
            </button>
          </div>
        </div>
      )}

      <div>
        <div className="text-[11px] font-semibold text-txt-tertiary uppercase tracking-wider mb-1.5">
          {t('settings:bots.create.sectionTitle')}
        </div>
        <div className="rounded-lg bg-white/[0.03] border border-white/[0.04] p-3.5 space-y-2">
          <label className="block text-sm text-txt-primary" htmlFor="bot-name">
            {t('settings:bots.create.nameLabel')}
          </label>
          <div className="flex gap-2">
            <div className="flex flex-1 min-w-0 items-center gap-1">
              <input
                id="bot-name"
                className="input-standard flex-1 min-w-0"
                value={name}
                maxLength={BOT_NAME_MAX_LENGTH - BOT_NAME_SUFFIX.length}
                autoComplete="off"
                onChange={(e) => setName(e.target.value.toLowerCase())}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && stemOf(name).length > 0 && !busy) void handleCreate();
                }}
              />
              <span className="shrink-0 text-sm text-txt-tertiary select-none">{BOT_NAME_SUFFIX}</span>
            </div>
            <button
              type="button"
              className={buttonClass}
              disabled={busy || stemOf(name).length === 0}
              onClick={() => void handleCreate()}
            >
              {t('settings:bots.create.submit')}
            </button>
          </div>
          <div className="text-xs text-txt-tertiary">
            {t('settings:bots.create.hint', {
              min: 1,
              max: BOT_NAME_MAX_LENGTH - BOT_NAME_SUFFIX.length,
              limit: MAX_BOTS_PER_USER,
            })}
          </div>
        </div>
      </div>

      <div>
        <div className="text-[11px] font-semibold text-txt-tertiary uppercase tracking-wider mb-1.5">
          {t('settings:bots.list.sectionTitle')}
        </div>
        <div className="rounded-lg bg-white/[0.03] border border-white/[0.04] p-3.5 space-y-3">
          {!loading && bots.length === 0 && (
            <div className="text-sm text-txt-tertiary">{t('settings:bots.list.empty')}</div>
          )}
          {bots.map((bot) => (
            <div key={bot.id} className="space-y-2">
              <div className="flex items-center gap-3">
                <Avatar
                  src={bot.avatar ? api.uploads.url(bot.avatar) : null}
                  name={bot.displayName || bot.username}
                  size={40}
                  avatarColor={bot.avatarColor}
                />
                <div className="min-w-0 flex-1">
                  {editingId === bot.id ? (
                    <div className="space-y-1">
                      <label className="sr-only" htmlFor={`bot-edit-${bot.id}`}>
                        {t('settings:bots.edit.nameLabel')}
                      </label>
                      <div className="flex items-center gap-1">
                        <input
                          id={`bot-edit-${bot.id}`}
                          className="input-standard flex-1 min-w-0"
                          value={editName}
                          maxLength={BOT_NAME_MAX_LENGTH - BOT_NAME_SUFFIX.length}
                          autoComplete="off"
                          onChange={(e) => setEditName(e.target.value)}
                          onKeyDown={(e) => {
                            if (e.key === 'Enter' && stemOf(editName).length > 0 && !busy) void handleSaveEdit(bot);
                            if (e.key === 'Escape') setEditingId(null);
                          }}
                        />
                        <span className="shrink-0 text-sm text-txt-tertiary select-none">{BOT_NAME_SUFFIX}</span>
                      </div>
                      <div className="text-xs text-txt-tertiary">
                        {t('settings:bots.edit.hint', { username: bot.username, max: BOT_NAME_MAX_LENGTH - BOT_NAME_SUFFIX.length })}
                      </div>
                      <div className="flex gap-1">
                        <button type="button" className={quietButtonClass} disabled={busy} onClick={() => pickAvatar(bot)}>
                          {t('settings:bots.avatar.change')}
                        </button>
                        {bot.avatar && (
                          <button type="button" className={quietButtonClass} disabled={busy} onClick={() => void handleRemoveAvatar(bot)}>
                            {t('settings:bots.avatar.remove')}
                          </button>
                        )}
                      </div>
                    </div>
                  ) : (
                    <>
                      <div className="text-sm text-txt-primary truncate">{bot.displayName || bot.username}</div>
                      <div className="text-xs text-txt-tertiary truncate">
                        @{bot.username} · {t('settings:bots.list.createdOn', { date: formatMediumDate(bot.createdAt) })}
                      </div>
                    </>
                  )}
                </div>
                <div className="flex shrink-0 gap-1">
                  {editingId === bot.id ? (
                    <>
                      <button
                        type="button"
                        className={buttonClass}
                        disabled={busy || stemOf(editName).length === 0}
                        onClick={() => void handleSaveEdit(bot)}
                      >
                        {t('settings:bots.actions.save')}
                      </button>
                      <button type="button" className={quietButtonClass} onClick={() => setEditingId(null)}>
                        {t('settings:bots.actions.cancel')}
                      </button>
                    </>
                  ) : (
                    <>
                      <button type="button" className={quietButtonClass} disabled={busy} onClick={() => startEdit(bot)}>
                        {t('settings:bots.actions.edit')}
                      </button>
                      <button type="button" className={quietButtonClass} disabled={busy} onClick={() => void toggleSpaces(bot)}>
                        {t('settings:bots.actions.addToServer')}
                      </button>
                      <button type="button" className={quietButtonClass} disabled={busy} onClick={() => void handleRegenerate(bot)}>
                        {t('settings:bots.actions.regenerate')}
                      </button>
                      {confirmDeleteId === bot.id ? (
                        <>
                          <button type="button" className={dangerButtonClass} disabled={busy} onClick={() => void handleDelete(bot)}>
                            {t('settings:bots.actions.confirmDelete')}
                          </button>
                          <button type="button" className={quietButtonClass} onClick={() => setConfirmDeleteId(null)}>
                            {t('settings:bots.actions.cancel')}
                          </button>
                        </>
                      ) : (
                        <button type="button" className={dangerButtonClass} disabled={busy} onClick={() => setConfirmDeleteId(bot.id)}>
                          {t('settings:bots.actions.delete')}
                        </button>
                      )}
                    </>
                  )}
                </div>
              </div>
              {spacesBotId === bot.id && (
                <div className="ml-[52px] rounded-md bg-surface-input p-2.5 space-y-1.5">
                  <div className="text-xs font-semibold text-txt-tertiary">{t('settings:bots.spaces.title')}</div>
                  {spacesLoading && (
                    <div className="text-xs text-txt-tertiary">{t('settings:bots.spaces.loading')}</div>
                  )}
                  {!spacesLoading && spaceOptions.length === 0 && (
                    <div className="text-xs text-txt-tertiary">{t('settings:bots.spaces.empty')}</div>
                  )}
                  {spaceOptions.map((space) => (
                    <div key={space.id} className="flex items-center justify-between gap-2">
                      <span className="text-sm text-txt-primary truncate">{space.name}</span>
                      {space.botIsMember ? (
                        <div className="flex items-center gap-2 shrink-0">
                          <span className="text-xs text-txt-tertiary">{t('settings:bots.spaces.added')}</span>
                          <button
                            type="button"
                            className={dangerButtonClass}
                            disabled={busy}
                            onClick={() => void handleRemoveFromSpace(bot, space.id)}
                          >
                            {t('settings:bots.spaces.remove')}
                          </button>
                        </div>
                      ) : (
                        <button
                          type="button"
                          className={buttonClass}
                          disabled={busy}
                          onClick={() => void handleAddToSpace(bot, space.id)}
                        >
                          {t('settings:bots.spaces.add')}
                        </button>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </div>
          ))}
        </div>
      </div>
      <input ref={fileInputRef} type="file" accept="image/*" className="hidden" onChange={handleFileChosen} />
      <ImageCropModal
        isOpen={cropSrc !== null}
        onClose={closeCrop}
        imageSrc={cropSrc ?? ''}
        onCropComplete={(blob) => void handleCropComplete(blob)}
        title={t('settings:bots.avatar.cropTitle')}
        cropShape="round"
        aspectRatio={1}
        maxOutputDimension={256}
      />
    </div>
  );
}
