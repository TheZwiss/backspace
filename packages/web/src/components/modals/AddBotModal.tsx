import React, { useState, useRef, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { Modal } from '../ui/Modal';
import { Avatar } from '../ui/Avatar';
import { getApiForOrigin } from '../../stores/spaceStore';
import { describeError } from '../../i18n/errors';
import { BotPermissionChecklist } from '../ui/BotPermissionChecklist';
import { permissionsToString, stringToPermissions } from '../../utils/permissions';
import { useViewerHeldPermissions, viewerCanSwitchBit } from '../../utils/roleHierarchy';
import type { BotSearchResult } from '@backspace/shared';

/**
 * A space manager adds a bot to a space: a native bot of the instance the
 * space lives on, or a bot of another instance that registered an account
 * there. The server checks MANAGE_SPACE; this modal lists what /bots/search
 * returns and posts the add. A bot that asks for permissions gets a second
 * step: the manager picks which of them its managed role carries, all ticked
 * at first; the ones the manager does not hold cannot be given (bots.md,
 * "Permissions on invite").
 */
interface AddBotModalProps {
  isOpen: boolean;
  onClose: () => void;
  /** The space's instance origin: bots are searched and added there. */
  origin: string;
  spaceId: string;
  onAdded: () => void;
}

export function AddBotModal({ isOpen, onClose, origin, spaceId, onAdded }: AddBotModalProps) {
  const { t } = useTranslation('spaces');
  const api = getApiForOrigin(origin);
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<BotSearchResult[]>([]);
  const [isSearching, setIsSearching] = useState(false);
  const [addingId, setAddingId] = useState<string | null>(null);
  const [error, setError] = useState('');
  /** The bot whose requested permissions are being reviewed, and the grant ticked so far. */
  const [reviewing, setReviewing] = useState<BotSearchResult | null>(null);
  const [grant, setGrant] = useState('0');
  const held = useViewerHeldPermissions(spaceId);
  const searchTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);
  /** Bumped on every keystroke and on close: a slower, older answer must not overwrite a newer one. */
  const searchSeq = useRef(0);

  useEffect(() => {
    if (isOpen) {
      setQuery('');
      setResults([]);
      setError('');
      setAddingId(null);
      setIsSearching(false);
      setReviewing(null);
      setGrant('0');
      searchSeq.current += 1;
      if (searchTimer.current) clearTimeout(searchTimer.current);
      setTimeout(() => inputRef.current?.focus(), 100);
    }
  }, [isOpen]);

  const handleSearch = (value: string) => {
    setQuery(value);
    setError('');
    if (searchTimer.current) clearTimeout(searchTimer.current);
    const seq = ++searchSeq.current;
    if (value.trim().length < 2) {
      setResults([]);
      setIsSearching(false);
      return;
    }
    searchTimer.current = setTimeout(async () => {
      setIsSearching(true);
      try {
        const res = await api.bots.search(value.trim());
        if (seq === searchSeq.current) setResults(res.bots);
      } catch (err) {
        if (seq === searchSeq.current) {
          setResults([]);
          setError(describeError(err));
        }
      } finally {
        if (seq === searchSeq.current) setIsSearching(false);
      }
    }, 300);
  };

  /** The requested bits of `bot` the viewer may not hand out (held-bits rule). */
  const unswitchable = (bot: BotSearchResult): bigint => {
    let locked = 0n;
    const requested = stringToPermissions(bot.requestedPermissions);
    for (let rest = requested; rest !== 0n; rest &= rest - 1n) {
      const bit = rest & -rest;
      if (!viewerCanSwitchBit(held, bit)) locked |= bit;
    }
    return locked;
  };

  const add = async (bot: BotSearchResult, permissions: string | undefined) => {
    setError('');
    setAddingId(bot.id);
    try {
      await api.bots.addToSpace(bot.id, spaceId, permissions);
      onAdded();
      onClose();
    } catch (err) {
      setError(describeError(err));
    } finally {
      setAddingId(null);
    }
  };

  const handleAdd = (bot: BotSearchResult) => {
    const requested = stringToPermissions(bot.requestedPermissions);
    if (requested === 0n) {
      void add(bot, '0');
      return;
    }
    setError('');
    setGrant(permissionsToString(requested & ~unswitchable(bot)));
    setReviewing(bot);
  };

  if (reviewing) {
    const locked = unswitchable(reviewing);
    const name = reviewing.displayName || reviewing.username;
    return (
      <Modal isOpen={isOpen} onClose={onClose} title={t('settings.members.botInvite.permissionsTitle', { name })} mobileStyle="sheet">
        <div className="space-y-3">
          <div className="text-sm text-txt-secondary">{t('settings.members.botInvite.permissionsIntro')}</div>
          <div className="max-h-72 overflow-y-auto rounded-lg bg-white/[0.02] p-3">
            <BotPermissionChecklist
              offered={reviewing.requestedPermissions}
              value={grant}
              onChange={setGrant}
              locked={permissionsToString(locked)}
              disabled={addingId !== null}
            />
          </div>
          {locked !== 0n && (
            <div className="text-xs text-txt-tertiary">{t('settings.members.botInvite.permissionsUnheld')}</div>
          )}
          {grant === '0' && (
            <div className="text-xs text-txt-tertiary">{t('settings.members.botInvite.permissionsNone')}</div>
          )}
          {error && (
            <div className="p-2 bg-accent-rose/10 border border-accent-rose/30 rounded text-txt-danger text-sm">{error}</div>
          )}
          <div className="flex justify-end gap-2">
            <button
              type="button"
              onClick={() => { setReviewing(null); setError(''); }}
              disabled={addingId !== null}
              className="px-3 py-1.5 rounded-md text-sm text-txt-tertiary hover:text-txt-secondary transition-colors disabled:opacity-50"
            >
              {t('settings.members.botInvite.back')}
            </button>
            <button
              type="button"
              onClick={() => { void add(reviewing, grant); }}
              disabled={addingId !== null}
              className="px-3 py-1.5 rounded-md text-sm font-medium bg-accent-primary hover:bg-accent-primary/80 text-white transition-colors disabled:opacity-50"
            >
              {addingId === reviewing.id
                ? t('settings.members.botInvite.adding')
                : t('settings.members.botInvite.add')}
            </button>
          </div>
        </div>
      </Modal>
    );
  }

  return (
    <Modal isOpen={isOpen} onClose={onClose} title={t('settings.members.botInvite.title')} mobileStyle="sheet">
      <div className="space-y-3">
        <input
          ref={inputRef}
          type="text"
          value={query}
          onChange={(e) => handleSearch(e.target.value)}
          placeholder={t('settings.members.botInvite.searchPlaceholder')}
          className="input-search w-full py-2 text-[14px]"
        />
        <div className="p-2 bg-white/[0.03] border border-white/10 rounded text-xs text-txt-secondary">
          {t('settings.members.botInvite.warning')}
        </div>
        {error && (
          <div className="p-2 bg-accent-rose/10 border border-accent-rose/30 rounded text-txt-danger text-sm">{error}</div>
        )}
        {isSearching && (
          <div className="text-xs text-txt-tertiary">{t('settings.members.botInvite.searching')}</div>
        )}
        {!isSearching && query.trim().length >= 2 && results.length === 0 && (
          <div className="text-xs text-txt-tertiary">{t('settings.members.botInvite.noResults')}</div>
        )}
        <div className="space-y-1 max-h-64 overflow-y-auto">
          {results.map((bot) => (
            <div key={bot.id} className="flex items-center justify-between gap-3 px-2 py-1.5 rounded-md hover:bg-white/[0.03]">
              <div className="flex items-center gap-3 min-w-0">
                <Avatar src={bot.avatar ? api.uploads.url(bot.avatar) : null} name={bot.displayName || bot.username} />
                <div className="min-w-0">
                  <div className="text-sm text-txt-primary truncate">{bot.displayName || bot.username}</div>
                  <div className="text-xs text-txt-tertiary truncate">
                    {bot.ownerUsername
                      ? `${bot.username} · ${t('settings.members.botInvite.owner', { owner: bot.ownerUsername })}`
                      : bot.username}
                  </div>
                </div>
              </div>
              <button
                type="button"
                onClick={() => handleAdd(bot)}
                disabled={addingId !== null}
                className="px-3 py-1 rounded-md border border-white/10 text-xs font-medium text-txt-secondary hover:text-txt-primary transition-colors disabled:opacity-50"
              >
                {addingId === bot.id
                  ? t('settings.members.botInvite.adding')
                  : t('settings.members.botInvite.add')}
              </button>
            </div>
          ))}
        </div>
      </div>
    </Modal>
  );
}
