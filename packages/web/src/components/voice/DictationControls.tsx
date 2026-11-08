import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { speechRecognition, SPEECH_MODELS, useDictationStore } from '../../platform/speechRecognition';
import { useVoiceStore } from '../../stores/voiceStore';
import { useKeybindStore } from '../../stores/keybindStore';
import { cancelDictation, pressDictation, releaseDictation, stopDictationAndVoice } from '../../utils/dictation';
import { canUseTextVoice } from '../../utils/textVoice';
import { useFormatters } from '../../i18n/formatters';

const mic = <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true"><rect x="9" y="2" width="6" height="12" rx="3"/><path d="M5 10v2a7 7 0 0 0 14 0v-2M12 19v3m-4 0h8"/></svg>;
export function DictationControls() {
  const { t } = useTranslation('voice'); const f = useFormatters();
  const state = useDictationStore();
  const voice = useVoiceStore();
  const shortcut = useKeybindStore((s) => s.keybinds.find((kb) => kb.actionId === 'dictationPushToTalk')?.displayLabel);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const held = useRef(false); const dictating = useRef(false);
  const model = SPEECH_MODELS.find((item) => item.id === state.model)!;
  const installed = state.installed.includes(state.model);
  const working = !['idle', 'ready'].includes(state.phase);
  const locked = working || state.recording || voice.textVoiceBusy;
  const supported = !!window.isSecureContext && !!navigator.mediaDevices?.getUserMedia && typeof MediaRecorder !== 'undefined';
  const available = voice.textVoiceEnabled && installed && supported && !locked;
  useEffect(() => { void speechRecognition.refresh().catch(() => useDictationStore.setState({ error: 'storage-unavailable' })); }, []);
  useEffect(() => () => { if (held.current || dictating.current) cancelDictation(); }, []);
  useEffect(() => { setConfirmDelete(false); }, [state.model]);
  const start = () => { held.current = true; void pressDictation(true); };
  const release = () => { if (held.current) { held.current = false; releaseDictation(); } };
  const cancel = () => { if (held.current) { held.current = false; cancelDictation(); } };
  const errorKey = ({ 'model-not-installed': 'missing', 'download-failed': 'downloadError', 'microphone-failed': 'micError', 'no-speech': 'noSpeech', 'recording-limit': 'limit', 'storage-unavailable': 'storageError', 'gpu-unavailable': 'gpuError' } as Record<string, 'missing' | 'downloadError' | 'micError' | 'noSpeech' | 'limit' | 'storageError' | 'gpuError'>)[state.error] ?? 'failed';
  return <section className="space-y-3 rounded-xl border border-wash/10 bg-wash/[0.025] p-3" aria-label={t('dictation.title')}>
    <div className="flex items-center gap-2 text-sm font-semibold text-txt-primary">{mic}{t('dictation.title')}</div>
    <div className="flex items-end gap-2">
      <label className="min-w-0 flex-1 text-xs text-txt-secondary">{t('dictation.model')}<select className="ui-select mt-1 w-full" disabled={locked} value={state.model} onChange={(event) => state.setModel(event.target.value as typeof state.model)}>{SPEECH_MODELS.map((item) => <option key={item.id} value={item.id}>{item.label}</option>)}</select></label>
      <label className="text-xs text-txt-secondary">{t('textVoice.processing')}<select className="ui-select mt-1 w-full" disabled={locked} value={state.device} onChange={(event) => state.setDevice(event.target.value as typeof state.device)}>{(['auto', 'cpu', 'gpu'] as const).map((item) => <option key={item} value={item}>{item === 'auto' ? t('textVoice.automatic') : item.toUpperCase()}</option>)}</select></label>
    </div>
    <div className="flex flex-wrap items-center gap-2 text-xs text-txt-secondary">
      <span>{t('dictation.size', { size: f.formatNumber(Math.ceil(model.assets.reduce((sum, asset) => sum + asset.bytes, 0) / 1024 / 1024)) })}</span>
      {installed ? <><span className="text-accent-primary">{t('dictation.installed')}</span><button data-icon-motion="press" type="button" disabled={locked} onClick={() => setConfirmDelete(true)} className="ml-auto rounded-lg px-2 py-1 text-accent-rose disabled:opacity-40">{t('dictation.delete')}</button></> : <button data-icon-motion="press" type="button" disabled={locked} onClick={() => void speechRecognition.install().catch(() => {})} className="ml-auto rounded-lg bg-accent-primary/15 px-3 py-1.5 text-accent-primary disabled:opacity-40">{t('dictation.download')}</button>}
    </div>
    {confirmDelete && <div role="alert" className="space-y-2 rounded-lg bg-accent-rose/10 p-3 text-xs text-txt-secondary"><p>{t('dictation.deleteConfirm', { model: model.label })}</p><div className="flex gap-3"><button data-icon-motion="press" type="button" onClick={() => { setConfirmDelete(false); void speechRecognition.remove(state.model).catch(() => useDictationStore.setState({ error: 'storage-unavailable' })); }} className="text-accent-rose">{t('dictation.delete')}</button><button data-icon-motion="press" type="button" onClick={() => setConfirmDelete(false)}>{t('dictation.cancel')}</button></div></div>}
    <div className="flex flex-wrap gap-2">
      <button data-icon-motion="press" type="button" disabled={!available && !(state.recording && dictating.current)} onClick={() => {
        if (state.recording && dictating.current) { dictating.current = false; releaseDictation(); }
        else { dictating.current = true; void pressDictation(false); }
      }} className="flex items-center gap-2 rounded-lg bg-wash/5 px-3 py-2 text-xs text-txt-primary disabled:opacity-40">{mic}{state.recording && dictating.current ? t('dictation.finish') : t('dictation.dictate')}</button>
      <button data-icon-motion="press" type="button" disabled={(!available || !canUseTextVoice()) && !held.current} onPointerDown={(event) => { if (event.button !== 0) return; event.preventDefault(); event.currentTarget.setPointerCapture(event.pointerId); start(); }} onPointerUp={release} onPointerCancel={cancel} onLostPointerCapture={cancel} onKeyDown={(event) => { if ([' ', 'Enter'].includes(event.key) && !event.repeat) { event.preventDefault(); start(); } }} onKeyUp={(event) => { if ([' ', 'Enter'].includes(event.key)) { event.preventDefault(); release(); } }} onBlur={cancel} aria-pressed={state.recording && held.current} className={`touch-none select-none rounded-lg px-3 py-2 text-xs font-semibold disabled:opacity-40 ${state.recording && held.current ? 'bg-accent-rose/20 text-accent-rose' : 'bg-accent-primary/15 text-accent-primary'}`}>{state.recording && held.current ? t('dictation.release') : t('dictation.hold')}</button>
      {(state.recording || working || voice.textVoiceBusy) && <button data-icon-motion="press" type="button" onClick={() => { held.current = false; dictating.current = false; stopDictationAndVoice(); }} className="rounded-lg px-2 py-1 text-xs text-accent-rose">{t('dictation.cancel')}</button>}
    </div>
    <p role="status" aria-live="polite" className="text-xs text-txt-secondary">{state.recording ? t('dictation.recording') : state.phase === 'downloading' ? t('dictation.downloading', { progress: f.formatPercent(state.progress) }) : state.phase === 'loading' || state.phase === 'transcribing' ? t('dictation.transcribing') : !supported ? t('dictation.secureContext') : voice.textVoiceEnabled && !canUseTextVoice() ? t('dictation.callHint') : t('dictation.hint')}</p>
    {state.phase === 'downloading' && <progress max={100} value={state.progress} aria-label={t('dictation.download')} className="h-1.5 w-full accent-accent-primary"/>}
    {!working && !state.recording && state.backend && <p className="text-ui-caption text-txt-tertiary">{t('textVoice.backendActive', { backend: state.backend === 'webgpu' ? 'GPU' : 'CPU' })}</p>}
    {state.error && <p role="alert" className="text-xs text-accent-rose">{t(`dictation.${errorKey}`)}</p>}
    <p className="text-ui-caption leading-relaxed text-txt-tertiary">{t('dictation.shortcut', { shortcut: shortcut ?? t('dictation.unassigned') })}</p>
    <label className="flex cursor-pointer items-center gap-2 text-xs text-txt-secondary"><input type="checkbox" checked={voice.textVoiceMonitor} onChange={(event) => voice.setTextVoiceMonitor(event.target.checked)} className="accent-accent-primary"/>{t('dictation.monitor')}</label>
  </section>;
}
