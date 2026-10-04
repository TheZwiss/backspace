import React, { useState, useRef, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { Modal } from '../ui/Modal';
import { Avatar } from '../ui/Avatar';
import { getApiForOrigin } from '../../stores/spaceStore';
import { describeError } from '../../i18n/errors';
import type { BotSearchResult, BotSummary } from '@backspace/shared';

/**
 * A space manager invites a native bot of the instance the space lives on.
 * The server checks MANAGE_SPACE; this modal only lists what /bots/search
 * returns and posts the add.
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

  const handleAdd = async (bot: BotSummary) => {
    setError('');
    setAddingId(bot.id);
    try {
      await api.bots.addToSpace(bot.id, spaceId);
      onAdded();
      onClose();
    } catch (err) {
      setError(describeError(err));
    } finally {
      setAddingId(null);
    }
  };

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
                onClick={() => { void handleAdd(bot); }}
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
