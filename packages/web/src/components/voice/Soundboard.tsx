import { Tooltip } from '../ui/Tooltip';
import { useCallback, useEffect, useState, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { createPortal } from 'react-dom';
import { useFloatingPosition } from '../../hooks/useFloatingPosition';
import { usePortalContainer } from '../../hooks/usePortalContainer';
import type { SoundboardPack, SoundboardSound } from '@backspace/shared';
import { useVoiceStore } from '../../stores/voiceStore';
import { useSpaceStore, getApiForOrigin, getMyUserIdForOrigin } from '../../stores/spaceStore';
import { voiceSessionOrigin } from '../../utils/dmCall';
import { decodeSoundboardFile, encodeSoundboardBuffer, playLocalSoundboard } from '../../utils/soundboard';
import { MAX_CLIP_SECONDS, defaultSelection } from '../../utils/audioTrim';
import { SoundTrimmer, type SoundCut } from './SoundTrimmer';
import { describeError } from '../../i18n/errors';
import { useFormatters } from '../../i18n/formatters';
import { Modal } from '../ui/Modal';
import { useUIStore } from '../../stores/uiStore';
import { useSoundboardUsageStore } from '../../stores/soundboardUsageStore';
import { SpaceIconImage } from '../layout/SpaceSidebar';
import { resolveAssetUrl } from '../../utils/assetUrls';
import { useStaticAvatar } from '../../utils/staticAvatar';

const icon = <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true"><rect x="3" y="3" width="18" height="18" rx="5"/><path d="M7 9v6m5-9v12m5-9v6" strokeLinecap="round"/></svg>;

function SoundboardManager({ spaceId, origin, manageOnly = false }: { spaceId?: string; origin: string; manageOnly?: boolean }) {
  const { t } = useTranslation(['voice', 'common']);
  const { formatDuration, formatPercent, formatNumber } = useFormatters();
  const volume = useVoiceStore((state) => state.soundboardVolume);
  const deafened = useVoiceStore((state) => state.isDeafened);
  const connected = useVoiceStore((state) => state.isLiveKitConnected);
  const [packs, setPacks] = useState<SoundboardPack[]>([]);
  const [selected, setSelected] = useState(spaceId ?? '');
  const [name, setName] = useState('');
  // The chosen file once decoded, and the part of it that will be uploaded.
  const [clip, setClip] = useState<{ name: string; buffer: AudioBuffer; cut: SoundCut } | null>(null);
  const [trimming, setTrimming] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);
  const [gain, setGain] = useState(80);
  const [query, setQuery] = useState('');
  const [pending, setPending] = useState(false);
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
  const pack = packs.find((entry) => entry.spaceId === (spaceId ?? selected));
  const myId = getMyUserIdForOrigin(origin);
  const canCreate = !!pack?.canCreate;
  const canDelete = (sound: SoundboardSound) => pack?.canManage || (pack?.canCreate && sound.creatorId === myId);
  const action = async (job: () => Promise<void>, exclusive = true) => {
    if (exclusive && pending) return;
    if (exclusive) setPending(true);
    setError('');
    try { await job(); } catch (err) { setError(err instanceof Error && err.message === 'soundboard-invalid' ? t('voice:soundboard.invalidAudio') : describeError(err)); }
    finally { if (exclusive) setPending(false); }
  };
  return <div className="space-y-4">
    <p className="text-sm text-txt-secondary">{t('voice:soundboard.description')}</p>
    {!spaceId && <label className="block text-xs text-txt-secondary">{t('voice:soundboard.pack')}<select value={selected} onChange={(e) => { setSelected(e.target.value); setError(''); }} className="ui-select mt-1 w-full">{packs.map((entry) => <option key={entry.spaceId} value={entry.spaceId}>{entry.name}</option>)}</select></label>}
    <div className="flex items-center justify-between gap-3 text-xs text-txt-tertiary"><span>{pack ? t('voice:soundboard.count', { count: pack.sounds.length }) : t('voice:soundboard.empty')}</span><button data-icon-motion="press" type="button" onClick={() => void load()} disabled={loading} className="text-accent-primary hover:underline">{t('voice:soundboard.refresh')}</button></div>
    <label className="flex items-center gap-3 text-xs text-txt-secondary"><span className="shrink-0">{t('voice:soundboard.volume')}</span><input type="range" min="0" max="100" value={volume} aria-label={t('voice:soundboard.volume')} onChange={(e) => useVoiceStore.getState().setSoundboardVolume(Number(e.target.value))} className="ui-range"/><span className="tabular-nums w-10 text-right">{formatPercent(volume)}</span></label>
    {error && <p role="alert" className="text-sm text-accent-rose">{error}</p>}
    {!!pack?.sounds.length && <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder={t('voice:soundboard.search')} aria-label={t('voice:soundboard.search')} className="input-standard w-full"/>}
    <div className="grid grid-cols-2 desktop:grid-cols-3 gap-2 max-h-80 overflow-y-auto scrollbar-thin">
      {pack?.sounds.filter((sound) => sound.name.toLowerCase().includes(query.toLowerCase())).map((sound) => <div key={sound.id} className="rounded-xl border border-wash/[0.06] bg-wash/[0.03] p-3">
        <button data-icon-motion="toggle" type="button" disabled={!connected || deafened || manageOnly} onClick={() => void action(async () => { await client.soundboard.play(sound.id); }, false)} className="w-full flex flex-col items-center gap-2 text-txt-primary hover:text-accent-primary disabled:opacity-40 transition-colors" title={t('voice:soundboard.play')}>
          <span className="flex h-10 w-10 items-center justify-center rounded-xl bg-accent-primary/10 text-accent-primary">{icon}</span><span className="text-xs font-semibold break-words line-clamp-2">{sound.name}</span>
        </button>
        <div className="mt-2 flex items-center justify-between gap-2 text-ui-caption text-txt-tertiary"><span>{formatDuration(Math.ceil(sound.durationMs / 1000))}</span><Tooltip content={t('voice:soundboard.preview')} position="top"><button data-icon-motion="toggle"  type="button" className="hover:text-accent-primary"  onClick={() => void action(async () => { await playLocalSoundboard(await client.soundboard.audio(sound.id), sound.assetId, sound.volume); }, false)}>{t('voice:soundboard.preview')}</button></Tooltip></div>
        {canDelete(sound) && <button data-icon-motion="press" type="button" disabled={pending} className="mt-2 text-ui-caption text-accent-rose hover:underline" onClick={() => { if (window.confirm(t('voice:soundboard.confirmDelete', { name: sound.name }))) void action(async () => { await client.soundboard.remove(sound.id); await load(); }); }}>{t('common:actions.delete')}</button>}
      </div>)}
    </div>
    {canCreate && pack && <form className="space-y-3 rounded-xl border border-wash/[0.06] bg-wash/[0.02] p-4" onSubmit={(e) => { e.preventDefault(); if (!clip || !pack || pack.sounds.length >= 40) return; void action(async () => { const audio = await encodeSoundboardBuffer(clip.buffer, clip.cut); await client.soundboard.upload(pack.spaceId, { name: name.trim(), audio, volume: gain / 100 }); setName(''); setClip(null); if (fileInput.current) fileInput.current.value = ''; await load(); }); }}>
      <h3 className="text-sm font-semibold text-txt-primary">{t('voice:soundboard.add')}</h3>
      <p className="text-xs text-txt-tertiary">{t('voice:soundboard.uploadHint')}</p>
      <input value={name} onChange={(e) => setName(e.target.value)} required minLength={2} maxLength={32} placeholder={t('voice:soundboard.name')} aria-label={t('voice:soundboard.name')} className="input-standard w-full"/>
      <input ref={fileInput} type="file" accept="audio/*" aria-label={t('voice:soundboard.audioFile')} onChange={(e) => { const chosen = e.target.files?.[0]; setClip(null); if (!chosen) return; void action(async () => { const buffer = await decodeSoundboardFile(chosen); setClip({ name: chosen.name, buffer, cut: { ...defaultSelection(buffer.duration), fade: true } }); if (buffer.duration > MAX_CLIP_SECONDS) setTrimming(true); }); }} className="block w-full text-xs text-txt-secondary"/>
      {clip && <div className="flex items-center justify-between gap-3 rounded-lg bg-wash/[0.04] px-3 py-2 text-xs text-txt-secondary" data-sound-cut><span className="min-w-0 truncate">{t('voice:soundboard.cutSummary', { file: clip.name, start: formatNumber(Math.round(clip.cut.start * 100) / 100), end: formatNumber(Math.round(clip.cut.end * 100) / 100) })}</span><button data-icon-motion="press" type="button" onClick={() => setTrimming(true)} className="shrink-0 font-medium text-accent-primary hover:underline">{t('voice:soundboard.editCut')}</button></div>}
      <label className="flex items-center gap-3 text-xs text-txt-secondary">{t('voice:soundboard.clipVolume')}<input type="range" min="0" max="100" value={gain} onChange={(e) => setGain(Number(e.target.value))} className="ui-range"/></label>
      <button data-icon-motion="press" disabled={pending || !clip || name.trim().length < 2 || pack.sounds.length >= 40} className="ui-button ui-button-primary disabled:opacity-40">{t('voice:soundboard.add')}</button>
    </form>}
    {clip && <SoundTrimmer key={clip.name + clip.buffer.length} isOpen={trimming} buffer={clip.buffer} fileName={clip.name} initial={clip.cut} onCancel={() => setTrimming(false)} onConfirm={(cut) => { setClip((current) => current ? { ...current, cut } : current); setTrimming(false); }} />}
    {pack && !canCreate && <p className="text-xs text-txt-tertiary">{t('voice:soundboard.permissionHint')}</p>}
  </div>;
}

function SoundboardHeaderIcon({ iconUrl, name }: { iconUrl?: string | null; name: string }) {
  const src = iconUrl && !iconUrl.startsWith('http') && !iconUrl.startsWith('/') ? `/api/uploads/${iconUrl}` : iconUrl;
  const still = useStaticAvatar(src || null, false);
  return <span className="flex h-[18px] w-[18px] shrink-0 items-center justify-center overflow-hidden rounded bg-surface-channel text-ui-micro">{still ? <img src={still} alt="" className="h-full w-full object-contain" /> : name.slice(0, 2).toUpperCase()}</span>;
}

export function SoundboardLibrary({ spaceId, origin, manageOnly = false }: { spaceId?: string; origin: string; manageOnly?: boolean }) {
  if (manageOnly) return <SoundboardManager spaceId={spaceId} origin={origin} manageOnly />;
  return <SoundboardPlayer origin={origin} />;
}

function SoundboardPlayer({ origin }: { origin: string }) {
  const { t } = useTranslation('voice');
  const { formatPercent } = useFormatters();
  const client = getApiForOrigin(origin);
  const myId = getMyUserIdForOrigin(origin);
  const volume = useVoiceStore((s) => s.soundboardVolume);
  const connected = useVoiceStore((s) => s.isLiveKitConnected);
  const deafened = useVoiceStore((s) => s.isDeafened);
  const channel = useVoiceStore((s) => s.currentVoiceChannelId);
  const currentSpace = useSpaceStore((s) => channel ? s.channelToSpaceMap.get(channel) : undefined);
  const spaces = useSpaceStore((s) => s.spaces);
  const counts = useSoundboardUsageStore((s) => s.counts[JSON.stringify([origin, myId])] ?? EMPTY_COUNTS);
  const [packs, setPacks] = useState<SoundboardPack[]>([]);
  const [query, setQuery] = useState('');
  const [volumeOpen, setVolumeOpen] = useState(false);
  const [hovered, setHovered] = useState('');
  const [error, setError] = useState('');
  const sections = useRef<Record<string, HTMLElement | null>>({});
  const scrollArea = useRef<HTMLDivElement>(null);
  const volumeContainer = useRef<HTMLDivElement>(null);
  const [activeSpace, setActiveSpace] = useState<string | undefined>();
  useEffect(() => { if (!volumeOpen) return; const doc = volumeContainer.current?.ownerDocument; if (!doc) return;
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape') setVolumeOpen(false); };
    const onPointer = (event: MouseEvent) => { if (!volumeContainer.current?.contains(event.target as Node)) setVolumeOpen(false); };
    doc.addEventListener('keydown', onKey); doc.addEventListener('mousedown', onPointer);
    return () => { doc.removeEventListener('keydown', onKey); doc.removeEventListener('mousedown', onPointer); };
  }, [volumeOpen]);
  useEffect(() => { let active = true; client.soundboard.list().then((list) => { if (active) setPacks(list); }).catch((err) => { if (active) setError(describeError(err)); }); return () => { active = false; }; }, [client]);
  const sorted = [...packs].sort((a, b) => Number(b.spaceId === currentSpace) - Number(a.spaceId === currentSpace));
  const matches = (sound: SoundboardSound) => sound.name.toLocaleLowerCase().includes(query.toLocaleLowerCase());
  const visiblePacks = sorted.filter((pack) => pack.sounds.some(matches));
  const frequent = sorted.flatMap((p) => p.sounds).filter((sound) => counts[sound.id] && matches(sound)).sort((a, b) => (counts[b.id] ?? 0) - (counts[a.id] ?? 0)).slice(0, 3);
  const run = async (job: () => Promise<void>) => { setError(''); try { await job(); } catch (err) { setError(describeError(err)); } };
  const soundCard = (sound: SoundboardSound) => <div key={sound.id} className="min-w-0 rounded-lg bg-wash/[0.05] p-2">
    <button data-icon-motion="toggle" type="button" disabled={!connected || deafened} onClick={() => void run(async () => { await client.soundboard.play(sound.id); if (myId) useSoundboardUsageStore.getState().recordPlay(origin, myId, sound.id); })} className="flex w-full items-center gap-2 text-left text-xs font-semibold text-txt-primary hover:text-accent-primary disabled:opacity-40" title={t('soundboard.play')}><span className="shrink-0 text-accent-primary">{icon}</span><span className="truncate">{sound.name}</span></button>
    <button data-icon-motion="toggle" type="button" onClick={() => void run(async () => { await playLocalSoundboard(await client.soundboard.audio(sound.id), sound.assetId, sound.volume); })} className="mt-1 text-ui-micro text-txt-tertiary hover:text-accent-primary">{t('soundboard.preview')}</button>
  </div>;
  return <div className="space-y-3">
    <div className="flex items-center gap-2"><input value={query} onChange={(e) => setQuery(e.target.value)} placeholder={t('soundboard.search')} aria-label={t('soundboard.search')} className="input-standard min-w-0 flex-1"/><div ref={volumeContainer} className="relative"><button data-icon-motion="toggle" type="button" aria-label={t('soundboard.volume')} aria-expanded={volumeOpen} onClick={() => setVolumeOpen(!volumeOpen)} className="p-2 text-txt-secondary hover:text-txt-primary"><svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true"><path d="M11 5 6 9H3v6h3l5 4V5Zm4 4a5 5 0 0 1 0 6m3-9a9 9 0 0 1 0 12"/></svg></button>
    {volumeOpen && <label className="absolute right-0 top-full z-20 flex w-56 items-center gap-2 rounded-lg bg-surface-channel p-3 text-xs text-txt-secondary shadow-xl"><input type="range" min="0" max="100" value={volume} aria-label={t('soundboard.volume')} onChange={(e) => useVoiceStore.getState().setSoundboardVolume(Number(e.target.value))} className="ui-range"/><span>{formatPercent(volume)}</span></label>}</div></div>
    {error && <p role="alert" className="text-sm text-accent-rose">{error}</p>}
    <div className="flex gap-3"><nav aria-label={t('soundboard.pack')} className="flex max-h-96 shrink-0 flex-col gap-2 overflow-y-auto">{visiblePacks.map((pack) => { const space = spaces.find((s) => s.id === pack.spaceId && (s._instanceOrigin ?? '') === origin); const active = (activeSpace && visiblePacks.some((p) => p.spaceId === activeSpace) ? activeSpace : visiblePacks[0]?.spaceId) === pack.spaceId; return <Tooltip content={pack.name} position="top"><button data-icon-motion="press" key={pack.spaceId} type="button"  aria-label={pack.name} aria-current={active ? 'true' : undefined} onMouseEnter={() => setHovered(pack.spaceId)} onMouseLeave={() => setHovered('')} onClick={() => { const container = scrollArea.current; const section = sections.current[pack.spaceId]; if (container && section) { container.scrollTo({ top: container.scrollTop + section.getBoundingClientRect().top - container.getBoundingClientRect().top, behavior: 'smooth' }); setActiveSpace(pack.spaceId); } }} className={`h-10 w-10 shrink-0 overflow-hidden bg-surface-channel text-xs font-semibold text-txt-primary transition-all ${active ? 'rounded-xl bg-wash/10' : 'rounded-xl'}`}>{space?.icon ? <SpaceIconImage icon={resolveAssetUrl(space.icon, origin) ?? space.icon} alt="" animate={hovered === pack.spaceId} className="h-full w-full object-contain" /> : pack.name.slice(0, 2).toUpperCase()}</button></Tooltip>; })}</nav><div ref={scrollArea} onScroll={() => { const container = scrollArea.current; if (!container) return; const top = container.getBoundingClientRect().top; const visible = visiblePacks.filter((pack) => (sections.current[pack.spaceId]?.getBoundingClientRect().top ?? Infinity) <= top + 25); setActiveSpace(visible.at(-1)?.spaceId ?? visiblePacks[0]?.spaceId); }} className="min-w-0 flex-1 max-h-96 overflow-y-auto scrollbar-thin space-y-4">
      <section><h3 className="mb-2 text-sm font-semibold text-txt-secondary">{t('soundboard.frequent')}</h3>{frequent.length ? <div className="grid grid-cols-3 gap-2">{frequent.map(soundCard)}</div> : <p className="text-xs text-txt-tertiary">{t('soundboard.frequentEmpty')}</p>}</section>
      {visiblePacks.map((pack) => { const space = spaces.find((s) => s.id === pack.spaceId && (s._instanceOrigin ?? '') === origin); return <section key={pack.spaceId} ref={(element) => { sections.current[pack.spaceId] = element; }}><h3 className="mb-2 flex items-center gap-2 text-sm font-semibold text-txt-secondary"><SoundboardHeaderIcon iconUrl={space?.icon ? resolveAssetUrl(space.icon, origin) : null} name={pack.name} />{pack.name}</h3><div className="grid grid-cols-3 gap-2">{pack.sounds.filter(matches).map(soundCard)}</div></section>; })}
      {!visiblePacks.length && <p className="text-sm text-txt-tertiary">{query ? t('soundboard.noResults') : t('soundboard.empty')}</p>}
    </div></div>
  </div>;
}
const EMPTY_COUNTS: Record<string, number> = {};

function SoundboardPopover({ anchorRef, targetDocument, origin, onClose }: { anchorRef: React.RefObject<HTMLButtonElement | null>; targetDocument: Document; origin: string; onClose: () => void }) {
  const { t } = useTranslation('voice');
  const popoverRef = useRef<HTMLDivElement>(null);
  const container = usePortalContainer(targetDocument);
  const { style } = useFloatingPosition(anchorRef, popoverRef, { placement: 'top', align: 'start', offset: 8 });
  useEffect(() => {
    const onClick = (event: MouseEvent) => { const target = event.target as Node; if (!anchorRef.current?.contains(target) && !popoverRef.current?.contains(target)) onClose(); };
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); onClose(); } };
    targetDocument.addEventListener('mousedown', onClick);
    targetDocument.addEventListener('keydown', onKey);
    return () => { targetDocument.removeEventListener('mousedown', onClick); targetDocument.removeEventListener('keydown', onKey); };
  }, [anchorRef, targetDocument, onClose]);
  return createPortal(<div ref={popoverRef} role="region" aria-label={t('soundboard.title')} style={{ ...style, left: typeof style.left === 'number' && style.left >= 0 ? Math.min(style.left + 8, (targetDocument.defaultView?.innerWidth ?? 0) - (popoverRef.current?.getBoundingClientRect().width ?? 0) - 8) : style.left }} className="glass-bubble w-[min(560px,calc(100*var(--app-vw)-16px))] max-h-[calc(100*var(--app-vh)-16px)] overflow-y-auto rounded-xl p-4 shadow-xl"><SoundboardLibrary origin={origin} /></div>, container);
}

export function SoundboardButton({ className = 'w-10 h-10', variant = 'call' }: { className?: string; variant?: 'call' | 'toolbar' }) {
  const { t } = useTranslation('voice');
  const [open, setOpen] = useState(false);
  const [targetDocument, setTargetDocument] = useState<Document | undefined>();
  const anchorRef = useRef<HTMLButtonElement>(null);
  const origin = useVoiceStore((state) => state.livekitHostOrigin ?? voiceSessionOrigin(state));
  const close = useCallback(() => setOpen(false), []);
  return <><Tooltip content={t('soundboard.title')} position="top"><button data-icon-motion="press" ref={anchorRef} type="button" onClick={(event) => { setTargetDocument(event.currentTarget.ownerDocument); setOpen((value) => !value); }}  aria-label={t('soundboard.title')} aria-expanded={open} className={variant === 'toolbar' ? `${className} rounded-[4px] flex items-center justify-center text-txt-tertiary hover:bg-surface-channel hover:text-txt-secondary transition-colors` : `${className} rounded-full flex shrink-0 items-center justify-center text-txt-secondary hover:text-txt-primary hover:bg-wash/10 transition-colors`}>{icon}</button></Tooltip>{open && targetDocument && <SoundboardPopover anchorRef={anchorRef} targetDocument={targetDocument} origin={origin} onClose={close} />}</>;
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
