import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useSoundboard } from '../../hooks/useSoundboard';
import { useAuthStore, getMyUserIdForOrigin } from '../../stores/authStore';
import { useSpaceStore } from '../../stores/spaceStore';
import { useVoiceStore } from '../../stores/voiceStore';
import { soundboardKey, useSoundboardPreferences } from '../../stores/soundboardStore';
import { hasPermissionBit, PermissionBits } from '../../utils/permissions';
import { sameShortcut, shortcutFromEvent, conflictsWithVoiceShortcut } from '../../utils/soundboardShortcuts';
import { getApiForOrigin } from '../../utils/crossStoreResolvers';
import { describeError } from '../../i18n/errors';
import { useFormatters } from '../../i18n/formatters';
import { SoundboardUpload } from './SoundboardUpload';
import { receiveSoundboardPlay, stopSoundboardPlayback } from '../../audio/soundboardPlayback';

export function SoundboardLibrary({ origin, spaceId, channelId }: { origin: string; spaceId: string; channelId?: string }) {
  const { t } = useTranslation(['voice', 'common']);
  const { formatNumber } = useFormatters();
  const { document, loading, error: loadError, reload } = useSoundboard(origin, spaceId);
  const [query, setQuery] = useState(''); const [adding, setAdding] = useState(false);
  const [pending, setPending] = useState<string | null>(null); const [error, setError] = useState('');
  const [deleting, setDeleting] = useState<string | null>(null);
  const [recording, setRecording] = useState<string | null>(null);
  const shortcuts = useSoundboardPreferences(s => s.shortcuts);
  const volume = useSoundboardPreferences(s => s.volume);
  const setShortcut = useSoundboardPreferences(s => s.setShortcut);
  const spacePerms = useSpaceStore(s => s.spacePermissions.get(spaceId));
  const channelPerms = useSpaceStore(s => channelId ? s.channelPermissions.get(channelId) : undefined);
  const spaceMuted = useVoiceStore(s => s.spaceMutedUserIds);
  const spaceDeafened = useVoiceStore(s => s.spaceDeafenedUserIds);
  const deafened = useVoiceStore(s => s.isDeafened);
  useAuthStore(s => s.user?.id);
  const myId = getMyUserIdForOrigin(origin);
  const manager = hasPermissionBit(spacePerms, PermissionBits.MANAGE_SPACE);
  const canPlay = !!channelId && hasPermissionBit(channelPerms, PermissionBits.SPEAK)
    && !spaceMuted.has(`${spaceId}:${myId}`) && !spaceDeafened.has(`${spaceId}:${myId}`) && !deafened;
  const prefix = `${soundboardKey(origin, spaceId)}:`;
  if (!document) return <div className="py-6 space-y-3 text-txt-tertiary" role="status">
    {loadError ? <><p className="text-accent-rose">{describeError(loadError)}</p><button onClick={() => void reload()} className="text-accent-primary">{t('common:actions.retry')}</button></> : t('common:states.loading')}
  </div>;
  const { settings, sounds } = document;
  const canUpload = settings.enabled && (manager || (settings.allowMemberUploads && hasPermissionBit(spacePerms, PermissionBits.ATTACH_FILES)));
  const filtered = sounds.filter(sound => sound.name.toLowerCase().includes(query.toLowerCase()));
  const play = async (id: string) => {
    if (!channelId || pending) return;
    setPending(id); setError('');
    try { await getApiForOrigin(origin).soundboard.play(spaceId, id, channelId); }
    catch (cause) { setError(describeError(cause)); }
    finally { setPending(null); }
  };
  const remove = async (id: string) => {
    if (pending) return;
    setPending(id); setError('');
    try { await getApiForOrigin(origin).soundboard.remove(spaceId, id); setShortcut(prefix + id, null); setDeleting(null); await reload(); }
    catch (cause) { setError(describeError(cause)); }
    finally { setPending(null); }
  };
  return <div className="space-y-4">
    <p className="text-sm text-txt-tertiary">{channelId ? t('voice:soundboard.description') : t('voice:soundboard.manageDescription')}</p>
    {!settings.enabled && <p className="rounded-lg bg-accent-amber/10 p-3 text-sm text-accent-amber">{t('voice:soundboard.disabled')}</p>}
    {channelId && !canPlay && <p className="text-sm text-accent-amber">{t('voice:soundboard.cannotPlay')}</p>}
    <div className="flex items-center gap-3">
      <input type="search" value={query} onChange={e => setQuery(e.target.value)} placeholder={t('voice:soundboard.search')} aria-label={t('voice:soundboard.search')} className="input-search flex-1 min-w-0" />
      {canUpload && <button disabled={sounds.length >= settings.maxSounds || adding} onClick={() => setAdding(true)} className="bg-accent-primary/15 text-accent-primary px-3 py-2 rounded-lg text-sm disabled:opacity-40">{t('voice:soundboard.add')}</button>}
    </div>
    <div className="flex justify-between gap-3 text-xs text-txt-tertiary"><span>{formatNumber(sounds.length)} / {formatNumber(settings.maxSounds)}</span><span>{settings.maxDurationSeconds === null ? t('voice:soundboard.unlimited') : t('voice:soundboard.limit', { max: formatNumber(settings.maxDurationSeconds) })}</span></div>
    {adding && <SoundboardUpload origin={origin} spaceId={spaceId} maxDuration={settings.maxDurationSeconds} onCancel={() => setAdding(false)} onDone={() => { setAdding(false); void reload(); }} />}
    {error && <p role="alert" className="text-sm text-accent-rose">{error}</p>}
    <div className="grid grid-cols-2 desktop:grid-cols-3 gap-3" aria-busy={loading}>
      {filtered.map(sound => {
        const overLimit = settings.maxDurationSeconds !== null && sound.durationSeconds > settings.maxDurationSeconds;
        const binding = shortcuts[prefix + sound.id];
        return <div key={sound.id} className="rounded-xl bg-surface-channel p-3 min-w-0 space-y-2">
          <button disabled={!channelId || !canPlay || !settings.enabled || overLimit || !!pending} onClick={() => void play(sound.id)}
            aria-label={t('voice:soundboard.playNamed', { name: sound.name })} className={`w-full text-left rounded-lg hover:bg-accent-primary/10 focus-visible:ring-2 focus-visible:ring-accent-primary transition-colors ${channelId ? 'disabled:opacity-40' : ''}`}>
            <span className="block text-3xl mb-2 truncate" aria-hidden="true">{sound.emoji}</span><span className="block text-sm font-medium text-txt-primary truncate" title={sound.name}>{sound.name}</span>
            <span className="text-xs text-txt-tertiary">{t('voice:soundboard.selection', { duration: formatNumber(Math.round(sound.durationSeconds * 100) / 100) })}</span>
          </button>
          {overLimit && <p className="text-xs text-accent-amber">{t('voice:soundboard.overLimit')}</p>}
          {channelId && <div className="flex gap-1 text-xs">
            <input readOnly data-keybind-capture value={recording === sound.id ? t('voice:soundboard.pressKey') : binding?.label ?? ''}
              placeholder={t('voice:soundboard.shortcut')} aria-label={t('voice:soundboard.shortcutNamed', { name: sound.name })}
              onFocus={() => setRecording(sound.id)} onBlur={() => setRecording(null)}
              onKeyDown={event => {
                event.stopPropagation();
                if (event.key === 'Tab') { setRecording(null); return; }
                event.preventDefault();
                if (event.key === 'Escape') { setRecording(null); event.currentTarget.blur(); return; }
                if (event.key === 'Backspace' || event.key === 'Delete') { setShortcut(prefix + sound.id, null); return; }
                const shortcut = shortcutFromEvent(event.nativeEvent);
                if (!shortcut) return;
                if (conflictsWithVoiceShortcut(shortcut) || sounds.some(other => {
                  const binding = shortcuts[prefix + other.id];
                  return other.id !== sound.id && binding !== undefined && sameShortcut(binding, shortcut);
                })) {
                  setError(t('voice:soundboard.shortcutConflict')); return;
                }
                setError(''); setShortcut(prefix + sound.id, shortcut); setRecording(null); event.currentTarget.blur();
              }} className="input-standard min-w-0 w-full text-xs py-1.5" />
            {binding && <button onClick={() => setShortcut(prefix + sound.id, null)} aria-label={t('voice:soundboard.clearShortcut')} className="px-2 text-txt-tertiary">×</button>}
          </div>}
          <div className="flex justify-between gap-2 text-xs">
            {channelId && <button onClick={() => void receiveSoundboardPlay(origin, channelId, spaceId, sound)} className="text-accent-primary py-1">{t('voice:soundboard.preview')}</button>}
            {(manager || sound.uploaderId === myId) && <button disabled={!!pending} onClick={() => setDeleting(sound.id)} className="text-accent-rose py-1">{t('common:actions.delete')}</button>}
          </div>
          {deleting === sound.id && <div className="text-xs space-y-2"><p className="text-txt-secondary">{t('voice:soundboard.deleteConfirm')}</p><div className="flex flex-wrap gap-2"><button disabled={!!pending} onClick={() => void remove(sound.id)} className="text-accent-rose">{t('common:actions.delete')}</button><button onClick={() => setDeleting(null)} className="text-txt-tertiary">{t('common:actions.cancel')}</button></div></div>}
        </div>;
      })}
    </div>
    {!filtered.length && <p className="text-center py-8 text-sm text-txt-tertiary">{query ? t('voice:soundboard.noResults') : t('voice:soundboard.empty')}</p>}
    {channelId && <div className="border-t border-white/[0.06] pt-4 space-y-3">
      <div className="flex items-center gap-3"><label htmlFor="soundboard-volume" className="text-sm text-txt-secondary">{t('voice:soundboard.volume')}</label><input id="soundboard-volume" type="range" min={0} max={100} value={volume} onChange={e => useSoundboardPreferences.getState().setVolume(Number(e.target.value))} className="flex-1 min-w-0 accent-accent-primary" /><button onClick={stopSoundboardPlayback} className="text-sm text-txt-tertiary">{t('voice:soundboard.stop')}</button></div>
      <p className="text-xs text-txt-tertiary">{t('voice:soundboard.shortcutHint')}</p>
    </div>}
  </div>;
}
