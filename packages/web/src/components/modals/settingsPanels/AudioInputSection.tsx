import { useEffect, useRef, useState } from 'react';
import { useVoiceStore } from '../../../stores/voiceStore';
import { AudioManager } from '../../../audio/AudioManager';
import { useAudioDevices } from '../../../hooks/useAudioDevices';
import { SectionShell, DropdownItem } from './_shared/SettingsPickerPrimitives';

export function AudioInputSection() {
  const inputDeviceId = useVoiceStore((s) => s.inputDeviceId);
  const setInputDevice = useVoiceStore((s) => s.setInputDevice);
  const inputVolume = useVoiceStore((s) => s.inputVolume);
  const setInputVolume = useVoiceStore((s) => s.setInputVolume);
  const { permState, inputs, inputLabels, requestPermission } = useAudioDevices();

  const [listOpen, setListOpen] = useState(false);
  const [micLevel, setMicLevel] = useState(0);
  const [activeUpstreamId, setActiveUpstreamId] = useState<string | null>(null);
  // Bumped whenever AudioManager's AudioContext transitions to 'running'.
  // Used as a dep on effects that need to re-run once the context exists —
  // the user may open Settings before joining voice (no AudioContext yet),
  // then join voice and expect the meter / resolved-default hint to come
  // alive without reopening the panel.
  const [audioCtxGen, setAudioCtxGen] = useState(0);
  const dropdownRef = useRef<HTMLDivElement>(null);
  const animFrameRef = useRef<number>(0);

  // Click-outside-to-close.
  useEffect(() => {
    if (!listOpen) return;
    const onMouseDown = (e: MouseEvent) => {
      if (dropdownRef.current && !dropdownRef.current.contains(e.target as Node)) {
        setListOpen(false);
      }
    };
    document.addEventListener('mousedown', onMouseDown);
    return () => document.removeEventListener('mousedown', onMouseDown);
  }, [listOpen]);

  // Listen for AudioContext resume events so dependent effects re-trigger
  // when the context first becomes available (e.g. user joins voice after
  // opening Settings). onResumed fires on every 'running' state transition;
  // we only need an opaque generation bump to re-run downstream effects.
  useEffect(() => {
    if (permState !== 'granted') return;
    const am = AudioManager.getInstance();
    const unsubscribe = am.onResumed(() => setAudioCtxGen((g) => g + 1));
    return () => { unsubscribe(); };
  }, [permState]);

  // Live mic-level meter. Reuses AudioManager's analyser node, which is part
  // of the canonical pipeline — no extra getUserMedia required once the user
  // is in voice. Re-runs on `audioCtxGen` bumps so the meter activates after
  // the AudioContext appears mid-session.
  useEffect(() => {
    if (permState !== 'granted') return;
    let stopped = false;
    const am = AudioManager.getInstance();
    const ctx = am.getContext();
    if (!ctx) return; // nothing to measure until the user joins voice or hits Test
    const analyser = am.getAnalyserNode();
    analyser.fftSize = 256;
    const data = new Uint8Array(analyser.frequencyBinCount);
    const tick = () => {
      if (stopped) return;
      analyser.getByteFrequencyData(data);
      const avg = data.reduce((a, b) => a + b, 0) / data.length;
      setMicLevel(Math.min(avg / 128, 1));
      animFrameRef.current = requestAnimationFrame(tick);
    };
    tick();
    return () => {
      stopped = true;
      if (animFrameRef.current) cancelAnimationFrame(animFrameRef.current);
    };
  }, [permState, audioCtxGen]);

  // Track the resolved upstream deviceId for the "Currently using: X" hint.
  // Re-runs on `audioCtxGen` because the resolved-default ID is only known
  // after AudioManager has actually opened a stream.
  useEffect(() => {
    if (permState !== 'granted') return;
    const am = AudioManager.getInstance();
    const id = am.getCurrentInputDeviceId();
    setActiveUpstreamId(id === 'default' ? null : id);
  }, [permState, inputDeviceId, audioCtxGen]);

  if (permState === 'unknown') {
    return (
      <SectionShell title="Input Device">
        <div className="text-sm text-txt-tertiary">Checking microphone access…</div>
      </SectionShell>
    );
  }

  if (permState === 'denied') {
    return (
      <SectionShell title="Input Device">
        <div className="space-y-2">
          <div className="text-sm text-txt-primary">⚠ Microphone access denied</div>
          <div className="text-xs text-txt-tertiary">
            Grant microphone permission to choose an input device.
          </div>
          <button
            onClick={() => { requestPermission().catch(() => {}); }}
            className="text-xs px-3 py-1.5 rounded-md bg-surface-base hover:bg-interactive-hover text-txt-secondary transition-colors"
          >
            Try again
          </button>
        </div>
      </SectionShell>
    );
  }

  if (permState === 'prompt') {
    return (
      <SectionShell title="Input Device">
        <div className="space-y-3">
          <div className="text-xs text-txt-tertiary">
            Microphone permission needed to list and choose an input device.
          </div>
          <button
            onClick={() => { requestPermission().catch(() => {}); }}
            className="text-[13px] px-3 py-2 rounded-md bg-accent-primary hover:bg-accent-primary-hover text-white font-medium transition-colors"
          >
            Enable microphone access
          </button>
        </div>
      </SectionShell>
    );
  }

  // permState === 'granted'
  const selectedLabel = inputDeviceId === 'default'
    ? 'System Default'
    : inputLabels.get(inputDeviceId) ?? 'System Default';
  const resolvedHint = inputDeviceId === 'default' && activeUpstreamId
    ? inputLabels.get(activeUpstreamId)
    : null;

  const handleSelect = (id: string) => {
    setInputDevice(id);
    AudioManager.getInstance().setInputDevice(id).catch(() => {});
    setListOpen(false);
  };

  const micBars = 20;
  const activeBars = Math.round(micLevel * micBars * (inputVolume / 100));

  return (
    <SectionShell title="Input Device">
      <div className="space-y-3">
        <div ref={dropdownRef}>
          <button
            type="button"
            onClick={() => setListOpen((v) => !v)}
            className="w-full px-3 py-2 flex items-center justify-between rounded-md bg-surface-base hover:bg-interactive-hover transition-colors"
          >
            <span className="text-[13px] text-txt-primary truncate text-left">{selectedLabel}</span>
            <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"
              className={`text-txt-tertiary flex-shrink-0 ml-2 transition-transform ${listOpen ? 'rotate-90' : ''}`}>
              <path d="M10 6L8.59 7.41 13.17 12l-4.58 4.59L10 18l6-6z" />
            </svg>
          </button>
          {listOpen && (
            <div className="mt-1 rounded-md bg-surface-base border border-border-hard py-1 max-h-64 overflow-y-auto">
              <DropdownItem label="System Default" active={inputDeviceId === 'default'} onClick={() => handleSelect('default')} />
              {inputs.filter(d => d.deviceId !== 'default').map((d) => (
                <DropdownItem
                  key={d.deviceId}
                  label={inputLabels.get(d.deviceId) ?? d.deviceId}
                  active={inputDeviceId === d.deviceId}
                  onClick={() => handleSelect(d.deviceId)}
                />
              ))}
            </div>
          )}
        </div>
        {resolvedHint && (
          <div className="text-xs text-txt-tertiary -mt-1">Currently using: {resolvedHint}</div>
        )}
        {inputs.length === 0 && (
          <div className="text-xs text-txt-tertiary">No microphones detected.</div>
        )}

        <div>
          <div className="flex items-center justify-between mb-1.5">
            <div className="text-[13px] font-medium text-txt-primary">Input Volume</div>
            <div className="text-xs text-txt-tertiary tabular-nums">{inputVolume}%</div>
          </div>
          <input
            type="range"
            min={0}
            max={200}
            value={inputVolume}
            onChange={(e) => setInputVolume(Number(e.target.value))}
            className="w-full h-1.5 rounded-full appearance-none cursor-pointer bg-surface-base [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:w-3 [&::-webkit-slider-thumb]:h-3 [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:bg-white [&::-webkit-slider-thumb]:shadow-md"
            style={{
              background: `linear-gradient(to right, rgb(var(--accent-primary)) 0%, rgb(var(--accent-primary)) ${inputVolume / 2}%, rgb(var(--interactive-muted)) ${inputVolume / 2}%, rgb(var(--interactive-muted)) 100%)`,
            }}
          />
          <div className="flex items-center gap-[3px] mt-2">
            {Array.from({ length: micBars }).map((_, i) => (
              <div
                key={i}
                className={`flex-1 h-[6px] rounded-[1px] transition-colors duration-75 ${
                  i < activeBars ? 'bg-status-online' : 'bg-interactive-muted'
                }`}
              />
            ))}
          </div>
          <div className="text-xs text-txt-tertiary mt-1.5">
            The level meter activates once you join a voice channel.
          </div>
        </div>
      </div>
    </SectionShell>
  );
}
