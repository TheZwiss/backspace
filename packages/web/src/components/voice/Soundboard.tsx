import { useCallback, useEffect, useState, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import type { SoundboardPack, SoundboardSound } from '@backspace/shared';
import { useVoiceStore } from '../../stores/voiceStore';
import { useSpaceStore, getApiForOrigin, getMyUserIdForOrigin } from '../../stores/spaceStore';
import { voiceSessionOrigin } from '../../utils/dmCall';
import { encodeSoundboardFile, playLocalSoundboard } from '../../utils/soundboard';
import { describeError } from '../../i18n/errors';
import { useFormatters } from '../../i18n/formatters';
import { Modal } from '../ui/Modal';
import { useUIStore } from '../../stores/uiStore';

const icon = <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true"><rect x="3" y="3" width="18" height="18" rx="5"/><path d="M7 9v6m5-9v12m5-9v6" strokeLinecap="round"/></svg>;

export function SoundboardLibrary({ spaceId, origin, manageOnly = false }: { spaceId?: string; origin: string; manageOnly?: boolean }) {
  const { t } = useTranslation(['voice', 'common']);
  const { formatDuration, formatPercent } = useFormatters();
  const volume = useVoiceStore((state) => state.soundboardVolume);
  const muted = useVoiceStore((state) => state.isMuted || state.isDeafened);
  const connected = useVoiceStore((state) => state.isLiveKitConnected);
  const [packs, setPacks] = useState<SoundboardPack[]>([]);
  const [selected, setSelected] = useState(spaceId ?? '');
  const [name, setName] = useState('');
  const [file, setFile] = useState<File | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const [gain, setGain] = useState(80);
  const [query, setQuery] = useState('');
  const [pending, setPending] = useState(false);
  const [cooldown, setCooldown] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const client = getApiForOrigin(origin);
  const load = useCallback(async () => {
    setLoading(true);
    try { const list = await client.soundboard.list(); setPacks(list); setSelected((old) => old || spaceId || list.find((pack) => pack.sounds.length)?.spaceId || list[0]?.spaceId || ''); }
    catch (err) { setError(describeError(err)); }
    finally { setLoading(false); }
  }, [client, spaceId]);
  useEffect(() => { void load(); }, [load]);
  useEffect(() => { if (!cooldown) return; const timer = setTimeout(() => setCooldown(false), 2000); return () => clearTimeout(timer); }, [cooldown]);
  const pack = packs.find((entry) => entry.spaceId === (spaceId ?? selected));
  const myId = getMyUserIdForOrigin(origin);
  const canCreate = !!pack?.canCreate;
  const canDelete = (sound: SoundboardSound) => pack?.canManage || (pack?.canCreate && sound.creatorId === myId);
  const action = async (job: () => Promise<void>) => {
    if (pending) return;
    setPending(true); setError('');
    try { await job(); } catch (err) { setError(err instanceof Error && err.message === 'soundboard-invalid' ? t('voice:soundboard.invalidAudio') : describeError(err)); }
    finally { setPending(false); }
  };
  return <div className="space-y-4">
    <p className="text-sm text-txt-secondary">{t('voice:soundboard.description')}</p>
    {!spaceId && <label className="block text-xs text-txt-secondary">{t('voice:soundboard.pack')}<select value={selected} onChange={(e) => { setSelected(e.target.value); setError(''); }} className="input-standard mt-1 w-full">{packs.map((entry) => <option key={entry.spaceId} value={entry.spaceId}>{entry.name}</option>)}</select></label>}
    <div className="flex items-center justify-between gap-3 text-xs text-txt-tertiary"><span>{pack ? t('voice:soundboard.count', { count: pack.sounds.length }) : t('voice:soundboard.empty')}</span><button type="button" onClick={() => void load()} disabled={loading} className="text-accent-primary hover:underline">{t('voice:soundboard.refresh')}</button></div>
    <label className="flex items-center gap-3 text-xs text-txt-secondary"><span className="shrink-0">{t('voice:soundboard.volume')}</span><input type="range" min="0" max="100" value={volume} aria-label={t('voice:soundboard.volume')} onChange={(e) => useVoiceStore.getState().setSoundboardVolume(Number(e.target.value))} className="min-w-0 flex-1 accent-accent-primary"/><span className="tabular-nums w-10 text-right">{formatPercent(volume)}</span></label>
    {error && <p role="alert" className="text-sm text-accent-rose">{error}</p>}
    {!!pack?.sounds.length && <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder={t('voice:soundboard.search')} aria-label={t('voice:soundboard.search')} className="input-standard w-full"/>}
    <div className="grid grid-cols-2 sm:grid-cols-3 gap-2 max-h-80 overflow-y-auto scrollbar-thin">
      {pack?.sounds.filter((sound) => sound.name.toLowerCase().includes(query.toLowerCase())).map((sound) => <div key={sound.id} className="rounded-xl border border-white/[0.06] bg-white/[0.03] p-3">
        <button type="button" disabled={pending || cooldown || !connected || muted || manageOnly} onClick={() => void action(async () => { await client.soundboard.play(sound.id); setCooldown(true); })} className="w-full flex flex-col items-center gap-2 text-txt-primary hover:text-accent-primary disabled:opacity-40 transition-colors" title={t('voice:soundboard.play')}>
          <span className="flex h-10 w-10 items-center justify-center rounded-xl bg-accent-primary/10 text-accent-primary">{icon}</span><span className="text-xs font-semibold break-words line-clamp-2">{sound.name}</span>
        </button>
        <div className="mt-2 flex items-center justify-between gap-2 text-[11px] text-txt-tertiary"><span>{formatDuration(Math.ceil(sound.durationMs / 1000))}</span><button type="button" disabled={pending} className="hover:text-accent-primary" title={t('voice:soundboard.preview')} onClick={() => void action(async () => { await playLocalSoundboard(await client.soundboard.audio(sound.id), sound.assetId, sound.volume); })}>{t('voice:soundboard.preview')}</button></div>
        {canDelete(sound) && <button type="button" disabled={pending} className="mt-2 text-[11px] text-accent-rose hover:underline" onClick={() => { if (window.confirm(t('voice:soundboard.confirmDelete', { name: sound.name }))) void action(async () => { await client.soundboard.remove(sound.id); await load(); }); }}>{t('common:actions.delete')}</button>}
      </div>)}
    </div>
    {canCreate && pack && <form className="space-y-3 rounded-xl border border-white/[0.06] bg-white/[0.02] p-4" onSubmit={(e) => { e.preventDefault(); if (!file || !pack || pack.sounds.length >= 40) return; void action(async () => { const audio = await encodeSoundboardFile(file); await client.soundboard.upload(pack.spaceId, { name: name.trim(), audio, volume: gain / 100 }); setName(''); setFile(null); if (fileInput.current) fileInput.current.value = ''; await load(); }); }}>
      <h3 className="text-sm font-semibold text-txt-primary">{t('voice:soundboard.add')}</h3>
      <p className="text-xs text-txt-tertiary">{t('voice:soundboard.uploadHint')}</p>
      <input value={name} onChange={(e) => setName(e.target.value)} required minLength={2} maxLength={32} placeholder={t('voice:soundboard.name')} aria-label={t('voice:soundboard.name')} className="input-standard w-full"/>
      <input ref={fileInput} type="file" accept="audio/*" aria-label={t('voice:soundboard.audioFile')} onChange={(e) => setFile(e.target.files?.[0] ?? null)} className="block w-full text-xs text-txt-secondary"/>
      <label className="flex items-center gap-3 text-xs text-txt-secondary">{t('voice:soundboard.clipVolume')}<input type="range" min="0" max="100" value={gain} onChange={(e) => setGain(Number(e.target.value))} className="min-w-0 flex-1 accent-accent-primary"/></label>
      <button disabled={pending || !file || name.trim().length < 2 || pack.sounds.length >= 40} className="rounded-lg bg-accent-primary px-4 py-2 text-xs font-semibold text-white disabled:opacity-40">{t('voice:soundboard.add')}</button>
    </form>}
    {pack && !canCreate && <p className="text-xs text-txt-tertiary">{t('voice:soundboard.permissionHint')}</p>}
  </div>;
}

export function SoundboardButton({ className = 'w-10 h-10' }: { className?: string }) {
  const { t } = useTranslation('voice');
  const [open, setOpen] = useState(false);
  const [targetDocument, setTargetDocument] = useState<Document | undefined>();
  const origin = useVoiceStore((state) => state.livekitHostOrigin ?? voiceSessionOrigin(state));
  return <><button type="button" onClick={(event) => { setTargetDocument(event.currentTarget.ownerDocument); setOpen(true); }} title={t('soundboard.title')} aria-label={t('soundboard.title')} className={`${className} rounded-full flex shrink-0 items-center justify-center text-txt-secondary hover:text-txt-primary hover:bg-white/10 transition-colors`}>{icon}</button><Modal targetDocument={targetDocument} isOpen={open} onClose={() => setOpen(false)} title={t('soundboard.title')} maxWidth="max-w-xl" mobileStyle="sheet">{open && <SoundboardLibrary origin={origin}/>}</Modal></>;
}

export function SoundboardPanel({ spaceId }: { spaceId: string }) {
  const origin = useSpaceStore((state) => state.spaces.find((space) => space.id === spaceId)?._instanceOrigin ?? '');
  return <SoundboardLibrary spaceId={spaceId} origin={origin} manageOnly />;
}


export function SoundboardManagerModal() {
  const { t } = useTranslation('voice');
  const activeModal = useUIStore((state) => state.activeModal);
  const spaceId = useUIStore((state) => state.modalData.spaceId) as string | undefined;
  const close = useUIStore((state) => state.closeModal);
  const space = useSpaceStore((state) => state.spaces.find((entry) => entry.id === spaceId));
  return <Modal isOpen={activeModal === 'soundboard' && !!space} onClose={close} title={t('soundboard.title')} maxWidth="max-w-xl" mobileStyle="sheet">
    {activeModal === 'soundboard' && space && <SoundboardLibrary spaceId={space.id} origin={space._instanceOrigin ?? ''} manageOnly />}
  </Modal>;
}
