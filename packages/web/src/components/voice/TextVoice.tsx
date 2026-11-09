import { Tooltip } from '../ui/Tooltip';
import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useVoiceStore } from '../../stores/voiceStore';
import { useKeybindStore } from '../../stores/keybindStore';
import { canUseTextVoice, speakText, stopTextVoice } from '../../utils/textVoice';
import { getLocalTextVoiceProvider, supportsLocalTextVoice } from '../../platform/textVoice';
import { useFormatters } from '../../i18n/formatters';
import { Modal } from '../ui/Modal';
import { SPEECH_MODELS, speechRecognition, useDictationStore } from '../../platform/speechRecognition';
import { DictationMicButton, canRecordDictation, useDictationModels } from './DictationControls';
import { cancelDictation, stopDictationAndVoice } from '../../utils/dictation';
import { setProcessingDevice, setupTextVoice, totalDownloadMb, type ProcessingDevice } from '../../utils/textVoiceSetup';
import { Toggle } from '../ui/Toggle';

const icon = <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true"><path d="M14 4H5a2 2 0 0 0-2 2v10a2 2 0 0 0 2 2h2v3l4-3h3M7 8h4m-4 4h3m8-5v10m3-7v4m-6-4v4" strokeLinecap="round" strokeLinejoin="round"/></svg>;

const VOICES = [{ id: 'pf_dora', name: 'Dora' }, { id: 'pm_alex', name: 'Alex' }, { id: 'pm_santa', name: 'Santa' }] as const;
const SPEEDS = [0.8, 1, 1.15, 1.3] as const;
const DEVICES: readonly ProcessingDevice[] = ['auto', 'cpu', 'gpu'];
/** The voice speaks Brazilian Portuguese whatever the interface language, so these are data, not catalog strings. */
const QUICK_PHRASES = { hello: 'Olá, pessoal!', wait: 'Um momento, por favor.', repeat: 'Pode repetir, por favor?' } as const;
const QUICK_KEYS = ['hello', 'wait', 'repeat'] as const;
const DICTATION_ERRORS: Record<string, 'missing' | 'downloadError' | 'micError' | 'noSpeech' | 'limit' | 'storageError' | 'gpuError'> = {
  'model-not-installed': 'missing',
  'download-failed': 'downloadError',
  'microphone-failed': 'micError',
  'no-speech': 'noSpeech',
  'recording-limit': 'limit',
  'storage-unavailable': 'storageError',
  'gpu-unavailable': 'gpuError',
};

/** Turns the mode on or off, stopping anything in flight and freeing the loaded voice when turning it off. */
function setTextVoiceMode(value: boolean): void {
  cancelDictation();
  stopTextVoice();
  useVoiceStore.getState().setTextVoiceEnabled(value);
  if (!value) void getLocalTextVoiceProvider().releaseTextVoice?.();
}

/** The on/off card shown in Settings → Voice. */
export function TextVoiceSettings() {
  const { t } = useTranslation('voice');
  const enabled = useVoiceStore((state) => state.textVoiceEnabled);
  if (!supportsLocalTextVoice() && !enabled) return null;
  return <div className="rounded-xl border border-accent-primary/20 bg-accent-primary/5 p-4">
    <div className="flex items-center justify-between gap-4">
      <div>
        <h3 className="text-sm font-semibold text-txt-primary">{t('textVoice.title')}</h3>
        <p className="mt-1 text-xs leading-relaxed text-txt-secondary">{t('textVoice.description')}</p>
      </div>
      <Toggle enabled={enabled} onChange={setTextVoiceMode} ariaLabel={t('textVoice.enable')} />
    </div>
    {enabled && <p className="mt-3 text-xs text-accent-primary">{t('textVoice.micOff')}</p>}
  </div>;
}

function Segmented<T extends string | number>({ label, value, options, onChange, disabled }: {
  label: string;
  value: T;
  options: readonly { id: T; label: string }[];
  onChange: (value: T) => void;
  disabled?: boolean;
}) {
  return <div role="radiogroup" aria-label={label} className="space-y-1.5">
    <div className="text-xs text-txt-secondary">{label}</div>
    <div className="flex flex-wrap gap-1.5">
      {options.map((option) => <button
        data-icon-motion="press"
        key={String(option.id)}
        type="button"
        role="radio"
        aria-checked={option.id === value}
        disabled={disabled}
        onClick={() => onChange(option.id)}
        className={`rounded-lg px-3 py-1.5 text-xs transition-colors disabled:opacity-40 ${option.id === value ? 'bg-accent-primary/20 font-semibold text-accent-primary' : 'bg-wash/5 text-txt-secondary hover:bg-wash/10'}`}
      >{option.label}</button>)}
    </div>
  </div>;
}

export function TextVoiceComposer() {
  const { t } = useTranslation('voice');
  const f = useFormatters();
  const enabled = useVoiceStore((state) => state.textVoiceEnabled);
  const voice = useVoiceStore((state) => state.textVoice);
  const speed = useVoiceStore((state) => state.textVoiceSpeed);
  const draft = useVoiceStore((state) => state.textVoiceDraft);
  const voiceBusy = useVoiceStore((state) => state.textVoiceBusy);
  const monitor = useVoiceStore((state) => state.textVoiceMonitor);
  const device = useVoiceStore((state) => state.textVoiceDevice);
  const allowed = useVoiceStore(() => canUseTextVoice());
  const dictation = useDictationStore();
  const shortcut = useKeybindStore((s) => s.keybinds.find((kb) => kb.actionId === 'dictationPushToTalk')?.displayLabel);
  const modelsKnown = useDictationModels();
  const [status, setStatus] = useState<LocalTextVoiceStatus>({ phase: 'idle' });
  const [error, setError] = useState('');
  const [settingUp, setSettingUp] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const input = useRef<HTMLTextAreaElement>(null);
  const autoPrepared = useRef(false);

  const supported = supportsLocalTextVoice();
  const setupDone = modelsKnown && dictation.installed.includes(dictation.model);
  const downloading = status.phase === 'downloading' || dictation.phase === 'downloading';
  const dictationBusy = dictation.recording || ['loading', 'transcribing'].includes(dictation.phase);
  const busy = voiceBusy || dictationBusy;
  const working = settingUp || downloading || status.phase === 'loading';

  useEffect(() => {
    let alive = true;
    void getLocalTextVoiceProvider().getTextVoiceStatus?.().then((value) => { if (alive) setStatus(value); });
    const unsubscribe = getLocalTextVoiceProvider().onTextVoiceStatus?.((value) => { if (alive) setStatus(value); });
    return () => { alive = false; unsubscribe?.(); };
  }, []);

  /** Loads the synthesized voice; a no-op when it is already loaded for the chosen processing. */
  const ensureVoice = async (): Promise<void> => {
    const current = await getLocalTextVoiceProvider().getTextVoiceStatus?.();
    if (current?.phase === 'ready' && current.device === device) return;
    setStatus(await getLocalTextVoiceProvider().prepareTextVoice!(device));
  };

  // Someone who already did the first-use setup should not have to press anything:
  // the voice is unloaded after a minute idle, so load it again as the screen opens.
  useEffect(() => {
    if (!supported || !setupDone || autoPrepared.current || status.phase !== 'idle') return;
    autoPrepared.current = true;
    void ensureVoice().catch(() => setError(t('textVoice.localError')));
    // eslint-disable-next-line react-hooks/exhaustive-deps -- runs once per open, when the models are known
  }, [supported, setupDone, status.phase]);

  const runSetup = async () => {
    setError('');
    setSettingUp(true);
    try {
      await setupTextVoice();
      setStatus((await getLocalTextVoiceProvider().getTextVoiceStatus?.()) ?? { phase: 'idle' });
    } catch {
      setError(t('textVoice.setupError'));
    } finally {
      setSettingUp(false);
    }
  };

  const speak = async (preview: boolean) => {
    if (busy || working || !draft.trim() || (!preview && !allowed)) return;
    const value = draft;
    setError('');
    try {
      await ensureVoice();
      await speakText(value, preview);
      if (!preview && useVoiceStore.getState().textVoiceDraft === value) useVoiceStore.getState().setTextVoiceDraft('');
    } catch (err) {
      if (!(err instanceof DOMException && err.name === 'AbortError')) setError(t('textVoice.localError'));
    }
    input.current?.focus();
  };

  const changeProcessing = (value: ProcessingDevice) => {
    setProcessingDevice(value);
    autoPrepared.current = false;
    void getLocalTextVoiceProvider().releaseTextVoice?.();
  };

  const model = SPEECH_MODELS.find((item) => item.id === dictation.model);
  const dictationError = dictation.error ? t(`dictation.${DICTATION_ERRORS[dictation.error] ?? 'failed'}`) : '';
  const message = error || dictationError;
  const progress = dictation.phase === 'downloading' ? dictation.progress : status.progress ?? 0;

  // One line that says what is happening now, in the order a person would care about it.
  const statusText = dictation.recording ? t('textVoice.listening')
    : dictation.phase === 'transcribing' ? t('dictation.transcribing')
    : voiceBusy ? t('textVoice.speaking')
    : working ? t('textVoice.preparing')
    : !allowed ? t('textVoice.muted')
    : t('textVoice.ready');

  if (!supported) {
    return <p role="status" className="text-sm leading-relaxed text-txt-secondary">{t('textVoice.unsupported')}</p>;
  }

  // Off: nothing else on screen, so there is a single thing to do.
  if (!enabled) {
    return <div className="flex items-center justify-between gap-4 rounded-xl border border-accent-primary/20 bg-accent-primary/5 p-4">
      <div>
        <div className="text-sm font-semibold text-txt-primary">{t('textVoice.enable')}</div>
        <p className="mt-1 text-xs leading-relaxed text-txt-secondary">{t('textVoice.description')}</p>
      </div>
      <Toggle enabled={enabled} onChange={setTextVoiceMode} ariaLabel={t('textVoice.enable')} />
    </div>;
  }

  // Until the voices are on this device there is nothing to write into: only the setup step is shown.
  if (!modelsKnown) return null;
  if (!setupDone) {
    return <div className="space-y-3">
      <div className="space-y-3 rounded-xl border border-accent-primary/20 bg-accent-primary/5 p-4">
        <div>
          <div className="text-sm font-semibold text-txt-primary">{t('textVoice.setupTitle')}</div>
          <p className="mt-1 text-xs leading-relaxed text-txt-secondary">{t('textVoice.setupBody', { size: f.formatNumber(totalDownloadMb(device)) })}</p>
        </div>
        {working
          ? <div className="space-y-1.5">
              <progress max={100} value={downloading ? progress : undefined} aria-label={t('textVoice.setupAction')} className="h-1.5 w-full accent-accent-primary" />
              <p role="status" aria-live="polite" className="text-xs text-txt-secondary">{downloading ? t('textVoice.downloadProgress', { progress: f.formatPercent(progress) }) : t('textVoice.preparing')}</p>
            </div>
          : <button data-icon-motion="press" type="button" onClick={() => void runSetup()} className="ui-button ui-button-primary">{t('textVoice.setupAction')}</button>}
      </div>
      {message && <p role="alert" className="text-sm text-accent-rose">{message}</p>}
      <button data-icon-motion="press" type="button" onClick={() => setTextVoiceMode(false)} className="block text-xs text-txt-secondary transition-colors hover:text-txt-primary">{t('textVoice.turnOff')}</button>
    </div>;
  }

  return <div className="space-y-4">
    <textarea
      ref={input}
      autoFocus
      value={draft}
      maxLength={2000}
      rows={4}
      onChange={(e) => useVoiceStore.getState().setTextVoiceDraft(e.target.value)}
      onKeyDown={(e) => {
        if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); e.stopPropagation(); void speak(false); }
      }}
      aria-label={t('textVoice.placeholder')}
      placeholder={t('textVoice.placeholder')}
      className="input-standard w-full resize-y min-h-28 text-sm leading-relaxed"
    />
    <div className="-mt-2 text-right text-xs tabular-nums text-txt-tertiary">{draft.length}/2000</div>

    <div className="flex flex-wrap gap-2">
      {QUICK_KEYS.map((key) => <button
        data-icon-motion="press"
        type="button"
        key={key}
        onClick={() => { useVoiceStore.getState().setTextVoiceDraft(QUICK_PHRASES[key]); input.current?.focus(); }}
        className="rounded-full border border-wash/10 px-3 py-1.5 text-xs text-txt-secondary transition-colors hover:bg-wash/5 hover:text-txt-primary"
      >{t(`textVoice.quick.${key}`)}</button>)}
    </div>

    <div className="flex flex-wrap items-center gap-2">
      <button
        data-icon-motion="send"
        type="button"
        disabled={!setupDone || !allowed || busy || working || !draft.trim()}
        onClick={() => void speak(false)}
        className="ui-button ui-button-primary transition-opacity disabled:opacity-40"
      >{t('textVoice.speak')}</button>
      <button
        data-icon-motion="send"
        type="button"
        disabled={!setupDone || busy || working || !draft.trim()}
        onClick={() => void speak(true)}
        className="rounded-xl bg-wash/5 px-4 py-2.5 text-sm text-txt-secondary transition-colors hover:bg-wash/10 disabled:opacity-40"
      >{t('textVoice.preview')}</button>
      <DictationMicButton disabled={!setupDone || !canRecordDictation() || voiceBusy || working} />
      {busy && !dictation.recording && <button
        data-icon-motion="press"
        type="button"
        onClick={stopDictationAndVoice}
        className="rounded-xl bg-accent-rose/10 px-4 py-2.5 text-sm text-accent-rose"
      >{t('textVoice.stop')}</button>}
    </div>

    <p role="status" aria-live="polite" className="text-xs text-txt-secondary">{statusText}</p>
    {message && <p role="alert" className="text-sm text-accent-rose">{message}</p>}

    <div className="border-t border-wash/10 pt-3">
      <button
        data-icon-motion="press"
        type="button"
        aria-expanded={settingsOpen}
        onClick={() => setSettingsOpen((open) => !open)}
        className="text-xs font-medium text-txt-secondary transition-colors hover:text-txt-primary"
      >{settingsOpen ? '▾' : '▸'} {t('textVoice.settings')}</button>

      {settingsOpen && <div className="mt-3 space-y-4">
        <Segmented
          label={t('textVoice.voice')}
          value={voice}
          options={VOICES.map((item) => ({ id: item.id as string, label: item.name }))}
          onChange={(value) => useVoiceStore.getState().setTextVoice(value)}
        />
        <Segmented
          label={t('textVoice.speed')}
          value={speed}
          options={SPEEDS.map((value) => ({ id: value as number, label: `${value}×` }))}
          onChange={(value) => useVoiceStore.getState().setTextVoiceSpeed(value)}
        />
        <label className="flex cursor-pointer items-center gap-2 text-xs text-txt-secondary">
          <input type="checkbox" checked={monitor} onChange={(event) => useVoiceStore.getState().setTextVoiceMonitor(event.target.checked)} className="accent-accent-primary" />
          {t('dictation.monitor')}
        </label>
        <div className="space-y-1.5">
          <Segmented
            label={t('textVoice.processing')}
            value={device}
            disabled={busy || working}
            options={DEVICES.map((id) => ({ id, label: t(`textVoice.processingOptions.${id}`) }))}
            onChange={changeProcessing}
          />
          <p className="text-ui-caption leading-relaxed text-txt-tertiary">{t('textVoice.processingHelp')}</p>
        </div>
        <p className="text-ui-caption leading-relaxed text-txt-tertiary">{t('dictation.shortcut', { shortcut: shortcut ?? t('dictation.unassigned') })}</p>
        <p className="text-ui-caption leading-relaxed text-txt-tertiary">{t('textVoice.privacy')}</p>
        {setupDone && model && <div className="space-y-2">
          {confirmDelete
            ? <div role="alert" className="space-y-2 rounded-lg bg-accent-rose/10 p-3 text-xs text-txt-secondary">
                <p>{t('dictation.deleteConfirm', { model: model.label })}</p>
                <div className="flex gap-3">
                  <button data-icon-motion="press" type="button" className="text-accent-rose" onClick={() => { setConfirmDelete(false); void speechRecognition.remove(dictation.model).catch(() => useDictationStore.setState({ error: 'storage-unavailable' })); }}>{t('dictation.delete')}</button>
                  <button data-icon-motion="press" type="button" onClick={() => setConfirmDelete(false)}>{t('dictation.cancel')}</button>
                </div>
              </div>
            : <button data-icon-motion="press" type="button" disabled={busy || working} onClick={() => setConfirmDelete(true)} className="text-xs text-accent-rose disabled:opacity-40">{t('textVoice.removeModels')}</button>}
        </div>}
        <button data-icon-motion="press" type="button" onClick={() => setTextVoiceMode(false)} className="block text-xs text-txt-secondary transition-colors hover:text-txt-primary">{t('textVoice.turnOff')}</button>
      </div>}
    </div>
  </div>;
}

export function TextVoiceButton({ className = 'w-10 h-10', variant = 'call' }: { className?: string; variant?: 'call' | 'toolbar' }) {
  const { t } = useTranslation('voice');
  const enabled = useVoiceStore((state) => state.textVoiceEnabled);
  const recording = useDictationStore((state) => state.recording);
  const [open, setOpen] = useState(false);
  const [targetDocument, setTargetDocument] = useState<Document | undefined>();
  if (!supportsLocalTextVoice() && !enabled) return null;
  return <><Tooltip content={t(recording ? 'dictation.recording' : 'textVoice.title')} position="top"><button data-icon-motion="press" type="button" onClick={(event) => { setTargetDocument(event.currentTarget.ownerDocument); setOpen(true); }}  aria-label={t(recording ? 'dictation.recording' : 'textVoice.title')} aria-pressed={recording} className={`${className} flex items-center justify-center transition-colors ${variant === 'toolbar' ? 'rounded-[4px]' : 'shrink-0 rounded-full'} ${recording ? 'bg-accent-rose/20 text-accent-rose' : enabled ? 'bg-accent-primary/20 text-accent-primary' : variant === 'toolbar' ? 'text-txt-tertiary hover:bg-surface-channel hover:text-txt-secondary' : 'text-txt-secondary hover:bg-wash/10 hover:text-txt-primary'}`}>{icon}</button></Tooltip><Modal isOpen={open} onClose={() => setOpen(false)} targetDocument={targetDocument} title={t('textVoice.title')} maxWidth="max-w-xl" mobileStyle="sheet">{open && <TextVoiceComposer />}</Modal></>;
}
