import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { speechRecognition, useDictationStore } from '../../platform/speechRecognition';
import { useVoiceStore } from '../../stores/voiceStore';
import { cancelDictation, pressDictation, releaseDictation } from '../../utils/dictation';

const micIcon = (
  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true">
    <rect x="9" y="2" width="6" height="12" rx="3" />
    <path d="M5 10v2a7 7 0 0 0 14 0v-2M12 19v3m-4 0h8" />
  </svg>
);

/** True when the browser can record from the microphone (secure context + MediaRecorder). */
export function canRecordDictation(): boolean {
  return !!window.isSecureContext && !!navigator.mediaDevices?.getUserMedia && typeof MediaRecorder !== 'undefined';
}

/**
 * Reads which dictation models are already downloaded while the composer is
 * open. Returns true once the answer is known, so the screen does not flash a
 * "download" step for someone who has already done it.
 */
export function useDictationModels(): boolean {
  const [loaded, setLoaded] = useState(false);
  useEffect(() => {
    let alive = true;
    speechRecognition.refresh()
      .catch(() => useDictationStore.setState({ error: 'storage-unavailable' }))
      .finally(() => { if (alive) setLoaded(true); });
    return () => { alive = false; };
  }, []);
  return loaded;
}

/**
 * One button: click to start listening, click again to turn the speech into
 * text in the box. The recording never reaches the call; the push-to-talk
 * shortcut (hold to speak and send) remains a keybind and is described in the
 * composer's settings.
 */
export function DictationMicButton({ disabled }: { disabled: boolean }) {
  const { t } = useTranslation('voice');
  const recording = useDictationStore((state) => state.recording);
  const enabled = useVoiceStore((state) => state.textVoiceEnabled);
  const started = useRef(false);

  useEffect(() => () => {
    if (started.current) cancelDictation();
  }, []);

  const toggle = () => {
    if (recording) {
      started.current = false;
      releaseDictation();
      return;
    }
    started.current = true;
    void pressDictation(false);
  };

  return (
    <button
      data-icon-motion="press"
      type="button"
      disabled={(disabled || !enabled) && !recording}
      onClick={toggle}
      aria-pressed={recording}
      className={`flex items-center gap-2 rounded-xl px-4 py-2.5 text-sm font-medium transition-colors disabled:opacity-40 ${recording ? 'bg-accent-rose/20 text-accent-rose' : 'bg-wash/5 text-txt-primary hover:bg-wash/10'}`}
    >
      {micIcon}
      {recording ? t('textVoice.micStop') : t('textVoice.micStart')}
    </button>
  );
}
