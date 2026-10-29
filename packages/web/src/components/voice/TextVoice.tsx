import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useVoiceStore } from '../../stores/voiceStore';
import { canUseTextVoice, speakText, stopTextVoice } from '../../utils/textVoice';
import { getLocalTextVoiceProvider, supportsLocalTextVoice } from '../../platform/textVoice';
import { useFormatters } from '../../i18n/formatters';
import { Modal } from '../ui/Modal';
import { Toggle } from '../ui/Toggle';

const icon = <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true"><path d="M14 4H5a2 2 0 0 0-2 2v10a2 2 0 0 0 2 2h2v3l4-3h3M7 8h4m-4 4h3m8-5v10m3-7v4m-6-4v4" strokeLinecap="round" strokeLinejoin="round"/></svg>;

export function TextVoiceSettings() {
  const { t } = useTranslation('voice');
  const enabled = useVoiceStore((state) => state.textVoiceEnabled);
  if (!supportsLocalTextVoice() && !enabled) return null;
  return <div className="rounded-xl border border-accent-primary/20 bg-accent-primary/5 p-4">
    <div className="flex items-center justify-between gap-4">
      <div><h3 className="text-sm font-semibold text-txt-primary">{t('textVoice.title')}</h3><p className="mt-1 text-xs leading-relaxed text-txt-secondary">{t('textVoice.description')}</p></div>
      <Toggle enabled={enabled} onChange={(value) => { stopTextVoice(); useVoiceStore.getState().setTextVoiceEnabled(value); if (!value) void getLocalTextVoiceProvider().releaseTextVoice?.(); }} ariaLabel={t('textVoice.enable')}/>
    </div>
    {enabled && <p className="mt-3 text-xs text-accent-primary">{t('textVoice.micOff')}</p>}
  </div>;
}

export function TextVoiceComposer() {
  const { t } = useTranslation('voice');
  const enabled = useVoiceStore((state) => state.textVoiceEnabled);
  const voice = useVoiceStore((state) => state.textVoice);
  const speed = useVoiceStore((state) => state.textVoiceSpeed);
  const draft = useVoiceStore((state) => state.textVoiceDraft);
  const busy = useVoiceStore((state) => state.textVoiceBusy);
  const allowed = useVoiceStore(() => canUseTextVoice());
  const device = useVoiceStore((state) => state.textVoiceDevice);
  const [status, setStatus] = useState<LocalTextVoiceStatus>({ phase: 'idle' });
  const available = status.phase === 'ready' && status.device === device;
  const preparing = status.phase === 'downloading' || status.phase === 'loading';
  const f = useFormatters();
  const [error, setError] = useState('');
  const input = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    let alive = true;
    getLocalTextVoiceProvider().getTextVoiceStatus?.().then((value) => { if (alive) setStatus(value); });
    const unsubscribe = getLocalTextVoiceProvider().onTextVoiceStatus?.((value) => { if (alive) setStatus(value); });
    return () => { alive = false; unsubscribe?.(); };
  }, []);
  const prepare = async () => {
    setError('');
    try { const value = await getLocalTextVoiceProvider().prepareTextVoice!(device); setStatus(value); }
    catch { setError(t('textVoice.localError')); }
  };
  const send = async (preview = false) => {
    if (busy || !draft.trim() || !available || (!preview && !allowed)) return;
    const value = draft;
    setError('');
    try {
      await speakText(value, preview);
      if (!preview && useVoiceStore.getState().textVoiceDraft === value) useVoiceStore.getState().setTextVoiceDraft('');
    } catch (err) {
      if (!(err instanceof DOMException && err.name === 'AbortError')) setError(t('textVoice.localError'));
    }
    input.current?.focus();
  };
  return <div className="space-y-4">
    <TextVoiceSettings />
    <div className="flex items-end gap-3">
      <label className="flex-1 text-xs text-txt-secondary">{t('textVoice.processing')}<select value={device} disabled={busy || preparing} onChange={(e) => useVoiceStore.getState().setTextVoiceDevice(e.target.value as 'auto' | 'cpu' | 'gpu')} className="input-standard mt-1 w-full">{[{ id: 'auto', label: t('textVoice.automatic') }, { id: 'cpu', label: 'CPU' }, { id: 'gpu', label: 'GPU (NVIDIA / AMD)' }].map((item) => <option key={item.id} value={item.id}>{item.label}</option>)}</select></label>
      <button type="button" disabled={preparing || busy || !supportsLocalTextVoice()} onClick={() => void prepare()} className="rounded-lg bg-white/5 px-3 py-2 text-xs text-txt-secondary disabled:opacity-40">{t('textVoice.prepare')}</button>
    </div>
    <p className="text-[11px] leading-relaxed text-txt-tertiary">{t('textVoice.downloadHint')}</p>
    <div className="grid grid-cols-2 gap-3">
      <label className="text-xs text-txt-secondary">{t('textVoice.voice')}<select value={voice} onChange={(e) => useVoiceStore.getState().setTextVoice(e.target.value)} className="input-standard mt-1 w-full">{[{ id: 'pf_dora', name: 'Dora' }, { id: 'pm_alex', name: 'Alex' }, { id: 'pm_santa', name: 'Santa' }].map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label>
      <label className="text-xs text-txt-secondary">{t('textVoice.speed')}<select value={speed} onChange={(e) => useVoiceStore.getState().setTextVoiceSpeed(Number(e.target.value))} className="input-standard mt-1 w-full">{[0.8, 1, 1.15, 1.3].map((value) => <option key={value} value={value}>{value}×</option>)}</select></label>
    </div>
    <textarea ref={input} autoFocus value={draft} maxLength={400} rows={4} onChange={(e) => useVoiceStore.getState().setTextVoiceDraft(e.target.value)} onKeyDown={(e) => {
      if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); e.stopPropagation(); void send(); }
    }} aria-label={t('textVoice.placeholder')} placeholder={t('textVoice.placeholder')} className="input-standard w-full resize-y min-h-28 text-sm leading-relaxed" />
    <div className="flex flex-wrap gap-2">{(['hello', 'wait', 'repeat'] as const).map((key) => <button type="button" key={key} onClick={() => { useVoiceStore.getState().setTextVoiceDraft(({ hello: 'Olá, pessoal!', wait: 'Um momento, por favor.', repeat: 'Pode repetir, por favor?' } as Record<string, string>)[key]!); input.current?.focus(); }} className="rounded-full border border-white/10 px-3 py-1.5 text-xs text-txt-secondary transition-colors hover:bg-white/5 hover:text-txt-primary">{t(`textVoice.quick.${key}`)}</button>)}</div>
    <div className="flex justify-between gap-3 text-xs text-txt-tertiary"><span>{t('textVoice.enterHint')}</span><span className="shrink-0 tabular-nums">{draft.length}/400</span></div>
    <p role="status" className="text-xs text-txt-secondary">{!supportsLocalTextVoice() ? t('textVoice.unsupported') : status.phase === 'downloading' ? t('textVoice.downloadProgress', { progress: f.formatPercent(status.progress ?? 0) }) : preparing ? t('textVoice.checking') : !available ? t(status.error === 'gpu-unavailable' ? 'textVoice.gpuUnavailable' : 'textVoice.unavailable') : busy ? t('textVoice.speaking') : enabled && !allowed ? t('textVoice.muted') : t('textVoice.backendActive', { backend: status.backend === 'webgpu' ? `GPU · ${status.adapter?.vendor ?? ''}` : 'CPU' })}</p>
    {error && <p role="alert" className="text-sm text-accent-rose">{error}</p>}
    <div className="flex flex-wrap items-center gap-2">
      <button type="button" disabled={!allowed || !available || busy || !draft.trim()} onClick={() => void send()} className="rounded-xl bg-accent-primary px-5 py-2.5 text-sm font-semibold text-white transition-opacity disabled:opacity-40">{t('textVoice.speak')}</button>
      <button type="button" disabled={!available || busy || !draft.trim()} onClick={() => void send(true)} className="rounded-xl bg-white/5 px-4 py-2.5 text-sm text-txt-secondary disabled:opacity-40">{t('textVoice.preview')}</button>
      {busy && <button type="button" onClick={stopTextVoice} className="rounded-xl bg-accent-rose/10 px-4 py-2.5 text-sm text-accent-rose">{t('textVoice.stop')}</button>}
    </div>
    <p className="text-[11px] leading-relaxed text-txt-tertiary">{t('textVoice.privacy')}</p>
  </div>;
}

export function TextVoiceButton({ className = 'w-10 h-10' }: { className?: string }) {
  const { t } = useTranslation('voice');
  const enabled = useVoiceStore((state) => state.textVoiceEnabled);
  const [open, setOpen] = useState(false);
  const [targetDocument, setTargetDocument] = useState<Document | undefined>();
  if (!supportsLocalTextVoice() && !enabled) return null;
  return <><button type="button" onClick={(event) => { setTargetDocument(event.currentTarget.ownerDocument); setOpen(true); }} title={t('textVoice.title')} aria-label={t('textVoice.title')} className={`${className} flex shrink-0 items-center justify-center rounded-full transition-colors ${enabled ? 'bg-accent-primary/20 text-accent-primary' : 'text-txt-secondary hover:bg-white/10 hover:text-txt-primary'}`}>{icon}</button><Modal isOpen={open} onClose={() => setOpen(false)} targetDocument={targetDocument} title={t('textVoice.title')} maxWidth="max-w-xl" mobileStyle="sheet">{open && <TextVoiceComposer />}</Modal></>;
}
