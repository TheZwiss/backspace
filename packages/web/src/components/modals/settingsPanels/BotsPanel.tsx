import { useCallback, useEffect, useRef, useState, type ChangeEvent } from 'react';
import { useTranslation } from 'react-i18next';
import type { BotActivity, BotActivityType, BotSpaceOption, BotSummary, BotTokenSummary } from '@backspace/shared';
import {
  BOT_ACTIVITY_TYPES,
  BOT_NAME_MAX_LENGTH,
  BOT_NAME_SUFFIX,
  BOT_TOKEN_NAME_MAX_LENGTH,
  MAX_BOT_TOKENS_PER_BOT,
  MAX_BOTS_PER_USER,
  PROFILE_BIO_MAX_LENGTH,
} from '@backspace/shared/src/constants';
import { ACTIVITY_LIMITS } from '@backspace/shared/src/activities.js';
import { api } from '../../../api/client';
import { describeError } from '../../../i18n/errors';
import { useFormatters } from '../../../i18n/formatters';
import { Avatar } from '../../ui/Avatar';
import { ImageCropModal } from '../../ui/ImageCropModal';
import { BotPermissionChecklist } from '../../ui/BotPermissionChecklist';
import { ALL_PERMISSIONS, permissionsToString } from '../../../utils/permissions';
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

/** The status select: a stored type, or no status. */
type StatusChoice = BotActivityType | 'none';

const STATUS_TYPE_LABEL_KEYS = {
  custom: 'settings:bots.status.types.custom',
  playing: 'settings:bots.status.types.playing',
  listening: 'settings:bots.status.types.listening',
  watching: 'settings:bots.status.types.watching',
} as const satisfies Record<BotActivityType, string>;

const STATUS_DISPLAY_KEYS = {
  custom: 'settings:bots.status.display.custom',
  playing: 'settings:bots.status.display.playing',
  listening: 'settings:bots.status.display.listening',
  watching: 'settings:bots.status.display.watching',
} as const satisfies Record<BotActivityType, string>;

/** The status the editor describes, or null for none (no type, or no text). */
function statusFromEditor(type: StatusChoice, text: string): BotActivity | null {
  const name = text.trim();
  return type === 'none' || name.length === 0 ? null : { type, name };
}

/** The editable part of a bot name: everything before the fixed `_bot` suffix. */
function stemOf(value: string): string {
  const trimmed = value.trim();
  return trimmed.endsWith(BOT_NAME_SUFFIX) ? trimmed.slice(0, -BOT_NAME_SUFFIX.length).trim() : trimmed;
}

export function BotsPanel() {
  const { t } = useTranslation(['settings']);
  const { formatMediumDate, formatRelativeTime } = useFormatters();
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
  const [editBio, setEditBio] = useState('');
  const [editStatusType, setEditStatusType] = useState<StatusChoice>('none');
  const [editStatusText, setEditStatusText] = useState('');
  const [editRequested, setEditRequested] = useState('0');
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [avatarBotId, setAvatarBotId] = useState<string | null>(null);
  const [cropSrc, setCropSrc] = useState<string | null>(null);
  const [spacesBotId, setSpacesBotId] = useState<string | null>(null);
  const [spaceOptions, setSpaceOptions] = useState<BotSpaceOption[]>([]);
  const [spacesLoading, setSpacesLoading] = useState(false);
  const [tokensBotId, setTokensBotId] = useState<string | null>(null);
  const [tokenList, setTokenList] = useState<BotTokenSummary[]>([]);
  const [tokensLegacy, setTokensLegacy] = useState(false);
  const [tokensLoading, setTokensLoading] = useState(false);
  const [tokenName, setTokenName] = useState('');
  const [confirmRevokeId, setConfirmRevokeId] = useState<string | null>(null);

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
      if (tokensBotId === bot.id) setTokensBotId(null);
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

  // A chosen status type needs its text; saving it empty would clear the status unasked.
  const editValid = stemOf(editName).length > 0 && (editStatusType === 'none' || editStatusText.trim().length > 0);

  const startEdit = (bot: BotSummary) => {
    setEditingId(bot.id);
    setEditName(stemOf(bot.displayName || bot.username));
    setEditBio(bot.bio ?? '');
    setEditStatusType(bot.activity?.type ?? 'none');
    setEditStatusText(bot.activity?.name ?? '');
    setEditRequested(bot.requestedPermissions);
    setConfirmDeleteId(null);
    setError(null);
  };

  const handleSaveEdit = async (bot: BotSummary) => {
    setBusy(true);
    setError(null);
    try {
      const bio = editBio.trim();
      const res = await api.bots.update(bot.id, {
        displayName: stemOf(editName) + BOT_NAME_SUFFIX,
        bio: bio.length > 0 ? bio : null,
        activity: statusFromEditor(editStatusType, editStatusText),
        requestedPermissions: editRequested,
      });
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

  const toggleTokens = async (bot: BotSummary) => {
    if (tokensBotId === bot.id) {
      setTokensBotId(null);
      return;
    }
    setTokensBotId(bot.id);
    setTokenList([]);
    setTokensLegacy(false);
    setTokenName('');
    setConfirmRevokeId(null);
    setTokensLoading(true);
    setError(null);
    try {
      const res = await api.bots.listTokens(bot.id);
      setTokenList(res.tokens);
      setTokensLegacy(res.legacy);
    } catch (err) {
      setError(describeError(err));
      setTokensBotId(null);
    } finally {
      setTokensLoading(false);
    }
  };

  const handleCreateToken = async (bot: BotSummary) => {
    setBusy(true);
    setError(null);
    try {
      const label = tokenName.trim();
      const res = await api.bots.createToken(bot.id, label.length > 0 ? { name: label } : {});
      const { token, ...summary } = res;
      setTokenList((prev) => [...prev, summary]);
      setTokensLegacy(false);
      setTokenName('');
      setRevealed({ username: bot.username, token });
      setCopied(false);
    } catch (err) {
      setError(describeError(err));
    } finally {
      setBusy(false);
    }
  };

  const handleRevokeToken = async (bot: BotSummary, tokenId: string) => {
    setBusy(true);
    setError(null);
    try {
      await api.bots.revokeToken(bot.id, tokenId);
      setTokenList((prev) => prev.filter((tk) => tk.id !== tokenId));
      setConfirmRevokeId(null);
    } catch (err) {
      setError(describeError(err));
    } finally {
      setBusy(false);
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
        {!loading && bots.length === 0 && (
          <div className="rounded-lg bg-white/[0.03] border border-white/[0.04] p-3.5 text-sm text-txt-tertiary">
            {t('settings:bots.list.empty')}
          </div>
        )}
        <ul className="space-y-3">
          {bots.map((bot) => {
            const editing = editingId === bot.id;
            const tokensOpen = tokensBotId === bot.id;
            const spacesOpen = spacesBotId === bot.id;
            return (
              <li
                key={bot.id}
                className="rounded-lg bg-white/[0.03] border border-white/[0.04] p-3.5 space-y-3"
                aria-label={bot.displayName || bot.username}
              >
                <div className="flex items-center gap-3">
                  <Avatar
                    src={bot.avatar ? api.uploads.url(bot.avatar) : null}
                    name={bot.displayName || bot.username}
                    size={40}
                    avatarColor={bot.avatarColor}
                  />
                  <div className="min-w-0 flex-1">
                    {editing ? (
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
                              if (e.key === 'Enter' && editValid && !busy) void handleSaveEdit(bot);
                              if (e.key === 'Escape') setEditingId(null);
                            }}
                          />
                          <span className="shrink-0 text-sm text-txt-tertiary select-none">{BOT_NAME_SUFFIX}</span>
                        </div>
                        <div className="text-xs text-txt-tertiary">
                          {t('settings:bots.edit.hint', { username: bot.username, max: BOT_NAME_MAX_LENGTH - BOT_NAME_SUFFIX.length })}
                        </div>
                      </div>
                    ) : (
                      <>
                        <div className="text-sm font-medium text-txt-primary truncate">{bot.displayName || bot.username}</div>
                        <div className="text-xs text-txt-tertiary truncate">
                          @{bot.username} · {t('settings:bots.list.createdOn', { date: formatMediumDate(bot.createdAt) })}
                        </div>
                        {bot.activity && (
                          <div className="text-xs text-txt-secondary truncate">
                            {t(STATUS_DISPLAY_KEYS[bot.activity.type], { name: bot.activity.name })}
                          </div>
                        )}
                      </>
                    )}
                  </div>
                </div>

                {editing && (
                  <div className="space-y-3">
                    <div>
                      <label className="block text-xs text-txt-secondary mb-1.5" htmlFor={`bot-bio-${bot.id}`}>
                        {t('settings:bots.edit.bioLabel')}
                      </label>
                      <div className="relative">
                        <textarea
                          id={`bot-bio-${bot.id}`}
                          className="input-standard w-full resize-none"
                          rows={3}
                          value={editBio}
                          maxLength={PROFILE_BIO_MAX_LENGTH}
                          placeholder={t('settings:bots.edit.bioPlaceholder')}
                          onChange={(e) => setEditBio(e.target.value.slice(0, PROFILE_BIO_MAX_LENGTH))}
                        />
                        <span className="absolute bottom-2 right-2 text-[10px] text-txt-tertiary">
                          {t('settings:bots.edit.bioCounter', { used: editBio.length, max: PROFILE_BIO_MAX_LENGTH })}
                        </span>
                      </div>
                    </div>
                    <div>
                      <label className="block text-xs text-txt-secondary mb-1.5" htmlFor={`bot-status-type-${bot.id}`}>
                        {t('settings:bots.status.label')}
                      </label>
                      <div className="flex flex-wrap gap-2">
                        <select
                          id={`bot-status-type-${bot.id}`}
                          className="input-standard appearance-none w-full desktop:w-44"
                          value={editStatusType}
                          onChange={(e) => setEditStatusType(e.target.value as StatusChoice)}
                        >
                          <option value="none">{t('settings:bots.status.none')}</option>
                          {BOT_ACTIVITY_TYPES.map((type) => (
                            <option key={type} value={type}>{t(STATUS_TYPE_LABEL_KEYS[type])}</option>
                          ))}
                        </select>
                        <input
                          className="input-standard flex-1 min-w-0"
                          aria-label={t('settings:bots.status.textLabel')}
                          value={editStatusText}
                          maxLength={ACTIVITY_LIMITS.MAX_NAME_LENGTH}
                          disabled={editStatusType === 'none'}
                          placeholder={t('settings:bots.status.placeholder')}
                          autoComplete="off"
                          onChange={(e) => setEditStatusText(e.target.value)}
                        />
                      </div>
                      <div className="text-xs text-txt-tertiary mt-1">{t('settings:bots.status.hint')}</div>
                    </div>
                    <div>
                      <div className="text-xs text-txt-secondary mb-1">{t('settings:bots.permissions.label')}</div>
                      <div className="text-xs text-txt-tertiary mb-2">{t('settings:bots.permissions.hint')}</div>
                      <div className="rounded-lg bg-white/[0.02] p-3">
                        <BotPermissionChecklist
                          offered={permissionsToString(ALL_PERMISSIONS)}
                          value={editRequested}
                          onChange={setEditRequested}
                          disabled={busy}
                        />
                      </div>
                    </div>
                  </div>
                )}

                {editing ? (
                  <div className="flex flex-wrap items-center gap-1">
                    <button
                      type="button"
                      className={buttonClass}
                      disabled={busy || !editValid}
                      onClick={() => void handleSaveEdit(bot)}
                    >
                      {t('settings:bots.actions.save')}
                    </button>
                    <button type="button" className={quietButtonClass} onClick={() => setEditingId(null)}>
                      {t('settings:bots.actions.cancel')}
                    </button>
                    <div className="flex flex-wrap gap-1 ml-auto">
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
                  <div className="space-y-2">
                    <div className="flex flex-wrap gap-1">
                      <button type="button" className={quietButtonClass} disabled={busy} onClick={() => startEdit(bot)}>
                        {t('settings:bots.actions.edit')}
                      </button>
                      <button
                        type="button"
                        className={spacesOpen ? buttonClass : quietButtonClass}
                        aria-expanded={spacesOpen}
                        disabled={busy}
                        onClick={() => void toggleSpaces(bot)}
                      >
                        {t('settings:bots.actions.addToServer')}
                      </button>
                      <button
                        type="button"
                        className={tokensOpen ? buttonClass : quietButtonClass}
                        aria-expanded={tokensOpen}
                        disabled={busy}
                        onClick={() => void toggleTokens(bot)}
                      >
                        {t('settings:bots.actions.tokens')}
                      </button>
                    </div>
                    <div className="flex flex-wrap items-center gap-1 border-t border-white/[0.04] pt-2">
                      <button type="button" className={quietButtonClass} disabled={busy} onClick={() => void handleRegenerate(bot)}>
                        {t('settings:bots.actions.regenerate')}
                      </button>
                      <div className="flex flex-wrap gap-1 ml-auto">
                        {confirmDeleteId === bot.id ? (
                          <>
                            <button type="button" className={quietButtonClass} onClick={() => setConfirmDeleteId(null)}>
                              {t('settings:bots.actions.cancel')}
                            </button>
                            <button type="button" className={dangerButtonClass} disabled={busy} onClick={() => void handleDelete(bot)}>
                              {t('settings:bots.actions.confirmDelete')}
                            </button>
                          </>
                        ) : (
                          <button type="button" className={dangerButtonClass} disabled={busy} onClick={() => setConfirmDeleteId(bot.id)}>
                            {t('settings:bots.actions.delete')}
                          </button>
                        )}
                      </div>
                    </div>
                  </div>
                )}

                {tokensOpen && (
                  <div className="rounded-md bg-surface-input p-2.5 space-y-1.5">
                    <div className="text-xs font-semibold text-txt-tertiary">{t('settings:bots.tokens.title')}</div>
                    {tokensLoading && <div className="text-xs text-txt-tertiary">{t('settings:bots.tokens.loading')}</div>}
                    {!tokensLoading && tokensLegacy && (
                      <div className="text-xs text-txt-tertiary">{t('settings:bots.tokens.legacy')}</div>
                    )}
                    {!tokensLoading && !tokensLegacy && tokenList.length === 0 && (
                      <div className="text-xs text-txt-tertiary">{t('settings:bots.tokens.empty')}</div>
                    )}
                    {tokenList.map((tk) => (
                      <div key={tk.id} className="flex flex-wrap items-center justify-between gap-2">
                        <div className="min-w-0 flex-1">
                          <div className="text-sm text-txt-primary truncate">{tk.name ?? t('settings:bots.tokens.unnamed')}</div>
                          <div className="text-xs text-txt-tertiary truncate">
                            {t('settings:bots.tokens.createdOn', { date: formatMediumDate(tk.createdAt) })} ·{' '}
                            {tk.lastUsedAt === null
                              ? t('settings:bots.tokens.neverUsed')
                              : t('settings:bots.tokens.lastUsed', { time: formatRelativeTime(tk.lastUsedAt) })}
                          </div>
                        </div>
                        <div className="flex flex-wrap shrink-0 gap-1">
                          {confirmRevokeId === tk.id ? (
                            <>
                              <button type="button" className={quietButtonClass} onClick={() => setConfirmRevokeId(null)}>
                                {t('settings:bots.actions.cancel')}
                              </button>
                              <button type="button" className={dangerButtonClass} disabled={busy} onClick={() => void handleRevokeToken(bot, tk.id)}>
                                {t('settings:bots.tokens.confirmRevoke')}
                              </button>
                            </>
                          ) : (
                            <button type="button" className={dangerButtonClass} disabled={busy} onClick={() => setConfirmRevokeId(tk.id)}>
                              {t('settings:bots.tokens.revoke')}
                            </button>
                          )}
                        </div>
                      </div>
                    ))}
                    {!tokensLoading && (
                      <div className="flex gap-2 pt-1">
                        <label className="sr-only" htmlFor={`bot-token-name-${bot.id}`}>
                          {t('settings:bots.tokens.nameLabel')}
                        </label>
                        <input
                          id={`bot-token-name-${bot.id}`}
                          className="input-standard flex-1 min-w-0"
                          value={tokenName}
                          placeholder={t('settings:bots.tokens.namePlaceholder')}
                          maxLength={BOT_TOKEN_NAME_MAX_LENGTH}
                          autoComplete="off"
                          onChange={(e) => setTokenName(e.target.value)}
                          onKeyDown={(e) => {
                            if (e.key === 'Enter' && !busy && tokenList.length < MAX_BOT_TOKENS_PER_BOT) void handleCreateToken(bot);
                          }}
                        />
                        <button
                          type="button"
                          className={`${buttonClass} shrink-0`}
                          disabled={busy || tokenList.length >= MAX_BOT_TOKENS_PER_BOT}
                          onClick={() => void handleCreateToken(bot)}
                        >
                          {t('settings:bots.tokens.create')}
                        </button>
                      </div>
                    )}
                    <div className="text-xs text-txt-tertiary">{t('settings:bots.tokens.limitHint', { max: MAX_BOT_TOKENS_PER_BOT })}</div>
                  </div>
                )}
                {spacesOpen && (
                  <div className="rounded-md bg-surface-input p-2.5 space-y-1.5">
                    <div className="text-xs font-semibold text-txt-tertiary">{t('settings:bots.spaces.title')}</div>
                    {spacesLoading && (
                      <div className="text-xs text-txt-tertiary">{t('settings:bots.spaces.loading')}</div>
                    )}
                    {!spacesLoading && spaceOptions.length === 0 && (
                      <div className="text-xs text-txt-tertiary">{t('settings:bots.spaces.empty')}</div>
                    )}
                    {spaceOptions.map((space) => (
                      <div key={space.id} className="flex flex-wrap items-center justify-between gap-2">
                        <span className="min-w-0 flex-1 text-sm text-txt-primary truncate">{space.name}</span>
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
                            className={`${buttonClass} shrink-0`}
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
              </li>
            );
          })}
        </ul>
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
