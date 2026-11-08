import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useAttentionMutes, ATTENTION_MUTE_DURATIONS, attentionMuted, type AttentionMuteTarget } from '../../../stores/attentionMutes';
import { useAuthStore } from '../../../stores/authStore';
import { useSocialStore } from '../../../stores/socialStore';
import { useSpaceStore } from '../../../stores/spaceStore';
import { userKey, isMine, selfIdentityOf } from '../../../utils/identity';
import { attentionMuteDurationLabels } from '../../../utils/attentionMuteMenu';
import { useFormatters } from '../../../i18n/formatters';
import { api } from '../../../api/client';
import { describeError } from '../../../i18n/errors';
import { Avatar } from '../../ui/Avatar';
import { Button } from '../../ui/Button';

type Candidate = { user: AttentionMuteTarget; origin: string };
export function AttentionMutedUsersSection() {
  const { t } = useTranslation(['settings', 'common']);
  const f = useFormatters();
  const self = useAuthStore(s => s.user);
  const rows = useAuthStore(s => s.myRowIds);
  const friends = useSocialStore(s => s.friends);
  const dms = useSpaceStore(s => s.dmChannels);
  const entries = useAttentionMutes(s => s.entries);
  const mute = useAttentionMutes(s => s.mute), unmute = useAttentionMutes(s => s.unmute);
  const owner = self ? userKey(self, '') : '';
  const [query, setQuery] = useState(''), [duration, setDuration] = useState('3600000');
  const [results, setResults] = useState<Candidate[]>([]), [error, setError] = useState('');
  const [now, setNow] = useState(Date.now);
  const active = useMemo(() => entries.filter(entry => entry.owner === owner && (entry.until === null || entry.until > now)), [entries, owner, now]);
  useEffect(() => {
    const next = Math.min(...active.flatMap(entry => entry.until === null ? [] : [entry.until]));
    if (!Number.isFinite(next)) return;
    const timer = setTimeout(() => setNow(Date.now()), Math.max(1, next - Date.now() + 1));
    return () => clearTimeout(timer);
  }, [active]);
  useEffect(() => {
    let cancelled = false;
    setError(''); setResults([]);
    if (query.trim().length < 2) return;
    const timer = setTimeout(() => {
      void api.social.search(query.trim()).then(users => { if (!cancelled) setResults(users.map(user => ({ user, origin: '' }))); }).catch(error => { if (!cancelled) setError(describeError(error)); });
    }, 250);
    return () => { cancelled = true; clearTimeout(timer); };
  }, [query, owner]);
  const candidates = useMemo(() => {
    const map = new Map<string, Candidate>();
    for (const friend of friends) map.set(userKey(friend, friend._instanceOrigin), { user: friend, origin: friend._instanceOrigin });
    for (const dm of dms) for (const member of dm.members) {
      const origin = useSpaceStore.getState().channelOriginMap.get(dm.id) ?? '';
      map.set(userKey(member, origin), { user: member, origin });
    }
    for (const candidate of results) map.set(userKey(candidate.user, candidate.origin), candidate);
    const search = query.trim().toLocaleLowerCase();
    return [...map.values()].filter(({ user, origin }) => !isMine(user, origin, selfIdentityOf(self, rows)) && !attentionMuted(owner, user, origin) && (!search || `${user.displayName ?? ''} ${user.username}`.toLocaleLowerCase().includes(search))).slice(0, 20);
  }, [friends, dms, results, query, owner, self, rows]);
  if (!self) return null;
  return <section className="settings-section space-y-4" aria-labelledby="attention-muted-users-title">
    <div><h3 id="attention-muted-users-title" className="text-sm font-semibold text-txt-primary">{t('settings:attentionMutes.title')}</h3><p className="text-xs text-txt-secondary mt-1">{t('settings:attentionMutes.description')}</p></div>
    <div className="space-y-2">
      <label className="block text-ui-label text-txt-secondary" htmlFor="attention-mute-search">{t('settings:attentionMutes.searchLabel')}</label>
      <input id="attention-mute-search" className="input-search w-full" value={query} onChange={event => setQuery(event.target.value)} placeholder={t('settings:attentionMutes.searchPlaceholder')} />
      <label className="block text-ui-label text-txt-secondary" htmlFor="attention-mute-duration">{t('settings:attentionMutes.duration')}</label>
      <select id="attention-mute-duration" className="ui-select" value={duration} onChange={event => setDuration(event.target.value)}>
        {[...ATTENTION_MUTE_DURATIONS, null].map((value, index) => <option key={String(value)} value={value === null ? 'forever' : String(value)}>{t(`settings:attentionMutes.${attentionMuteDurationLabels[index]!}`)}</option>)}
      </select>
      {error && <p role="alert" className="text-xs text-txt-danger">{error}</p>}
      <div className="max-h-44 overflow-y-auto space-y-1">
        {candidates.map(({ user, origin }) => <div key={userKey(user, origin)} className="flex items-center gap-2 rounded-lg p-2 hover:bg-interactive-hover">
          <Avatar src={user.avatar} name={user.displayName || user.username} userId={user.id} size={28} />
          <span className="min-w-0 flex-1 truncate text-ui-label text-txt-primary">{user.displayName || user.username}</span>
          <Button data-icon-motion="toggle" variant="secondary" onClick={() => mute(owner, user, origin, duration === 'forever' ? null : Number(duration))}>{t('settings:attentionMutes.muteShort')}</Button>
        </div>)}
        {candidates.length === 0 && <p className="py-2 text-xs text-txt-secondary">{t('settings:attentionMutes.noResults')}</p>}
      </div>
    </div>
    <div className="border-t border-border-soft pt-3 space-y-2">
      {active.length === 0 && <p className="text-xs text-txt-secondary">{t('settings:attentionMutes.empty')}</p>}
      {active.map(entry => <div key={entry.key} className="flex items-center gap-2 rounded-lg bg-surface-input/50 p-2">
        <Avatar src={entry.avatar} name={entry.name} size={28} />
        <div className="min-w-0 flex-1"><p className="truncate text-ui-label text-txt-primary">{entry.name}</p><p className="text-xs text-txt-secondary">{entry.until === null ? t('settings:attentionMutes.forever') : t('settings:attentionMutes.until', { time: f.formatDateTime(entry.until) })}</p></div>
        <Button data-icon-motion="toggle" variant="secondary" onClick={() => unmute(owner, entry.key)}>{t('settings:attentionMutes.unmuteShort')}</Button>
      </div>)}
    </div>
  </section>;
}
