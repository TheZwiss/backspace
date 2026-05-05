import { useEffect, useRef, useState } from 'react';
import { useVoiceStore } from '../../../stores/voiceStore';
import { AudioManager } from '../../../audio/AudioManager';
import { useAudioDevices } from '../../../hooks/useAudioDevices';
import { SectionShell, DropdownItem } from './_shared/SettingsPickerPrimitives';

/**
 * Feature-detect per-element output routing support. iOS Safari has zero
 * support for `HTMLMediaElement.setSinkId` (and likewise no AudioContext
 * variant); when both are absent, the OS routes audio (Bluetooth menu, etc.)
 * and an in-app picker would be non-functional.
 *
 * Cached at module level since support cannot change within a page lifetime.
 */
let cachedPlatformSupportsSinkSelection: boolean | null = null;
function platformSupportsSinkSelection(): boolean {
  if (cachedPlatformSupportsSinkSelection !== null) return cachedPlatformSupportsSinkSelection;
  if (typeof window === 'undefined' || typeof HTMLMediaElement === 'undefined') {
    cachedPlatformSupportsSinkSelection = false;
    return false;
  }
  const supported = 'setSinkId' in HTMLMediaElement.prototype;
  cachedPlatformSupportsSinkSelection = supported;
  return supported;
}

export function AudioOutputSection() {
  // Hard gate: if the browser cannot route audio per-element at all (iOS
  // Safari has zero support for HTMLMediaElement.setSinkId), hide the entire
  // section. Users adjust output via OS controls (Bluetooth menu, etc.).
  // This check is module-level cached; for a given page lifetime the function
  // always returns the same value, so hook order downstream is stable.
  if (!platformSupportsSinkSelection()) return null;
  return <AudioOutputSectionInner />;
}

function AudioOutputSectionInner() {
  const outputDeviceId = useVoiceStore((s) => s.outputDeviceId);
  const setOutputDevice = useVoiceStore((s) => s.setOutputDevice);
  const outputVolume = useVoiceStore((s) => s.outputVolume);
  const setOutputVolume = useVoiceStore((s) => s.setOutputVolume);
  const { permState, outputs, outputLabels, requestPermission } = useAudioDevices();

  const [listOpen, setListOpen] = useState(false);
  // Default to "supported" — only flip false if a real context exists and
  // lacks setSinkId (Safari < 17). Pre-context users can still pick a device;
  // AudioManager.setOutputDevice defers the actual setSinkId until the
  // context exists (applyOutputDevice early-returns when ctx is null, and
  // initContext re-applies the persisted ID on creation).
  const [supportsSinkId, setSupportsSinkId] = useState(true);
  // Bumped whenever AudioManager's AudioContext transitions to 'running'.
  // Used as a dep on the supportsSinkId effect so the check re-evaluates
  // when the user joins voice after opening Settings — without this, a
  // user who opens Settings before joining voice would see an incorrect
  // "browser doesn't support setSinkId" fallback that never recovers.
  const [audioCtxGen, setAudioCtxGen] = useState(0);
  const dropdownRef = useRef<HTMLDivElement>(null);

  // Click-outside-to-close. Listens for both mousedown and touchstart so the
  // popover dismisses with a single tap on touch devices (iOS Safari does not
  // synthesize mousedown reliably from touch).
  useEffect(() => {
    if (!listOpen) return;
    const onPointerDown = (e: MouseEvent | TouchEvent) => {
      if (dropdownRef.current && !dropdownRef.current.contains(e.target as Node)) {
        setListOpen(false);
      }
    };
    document.addEventListener('mousedown', onPointerDown);
    document.addEventListener('touchstart', onPointerDown, { passive: true });
    return () => {
      document.removeEventListener('mousedown', onPointerDown);
      document.removeEventListener('touchstart', onPointerDown);
    };
  }, [listOpen]);

  // Listen for AudioContext resume events so the supportsSinkId check
  // re-evaluates once the context first becomes available.
  useEffect(() => {
    if (permState !== 'granted') return;
    const am = AudioManager.getInstance();
    const unsubscribe = am.onResumed(() => setAudioCtxGen((g) => g + 1));
    return () => { unsubscribe(); };
  }, [permState]);

  // Detect setSinkId support — Safari < 17 does not support it on AudioContext.
  // Default state is "supported"; we only flip to false once we have a real
  // context to inspect AND it lacks the API. This avoids hiding the picker
  // from users who open Settings before joining voice (no context yet).
  useEffect(() => {
    const ctx = AudioManager.getInstance().getContext();
    if (ctx && !('setSinkId' in ctx)) {
      setSupportsSinkId(false);
    } else {
      setSupportsSinkId(true);
    }
  }, [permState, audioCtxGen]);

  if (permState === 'unknown') {
    return (
      <SectionShell title="Output Device">
        <div className="text-sm text-txt-tertiary">Checking audio access…</div>
      </SectionShell>
    );
  }

  // Output-device labels are gated behind microphone permission. If permission
  // is not granted we can still let the user adjust output volume + test the
  // current default, but the picker is hidden.
  const showPicker = permState === 'granted' && supportsSinkId;
  const selectedLabel = outputDeviceId === 'default'
    ? 'System Default'
    : outputLabels.get(outputDeviceId) ?? 'System Default';

  const handleSelect = (id: string) => {
    setOutputDevice(id);
    AudioManager.getInstance().setOutputDevice(id).catch(() => {});
    setListOpen(false);
  };

  const handleTestTone = async () => {
    try { await AudioManager.getInstance().playTestTone(); } catch { /* best-effort */ }
  };

  return (
    <SectionShell title="Output Device">
      <div className="space-y-3">
        {showPicker ? (
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
                <DropdownItem label="System Default" active={outputDeviceId === 'default'} onClick={() => handleSelect('default')} />
                {outputs.filter(d => d.deviceId !== 'default').map((d) => (
                  <DropdownItem
                    key={d.deviceId}
                    label={outputLabels.get(d.deviceId) ?? d.deviceId}
                    active={outputDeviceId === d.deviceId}
                    onClick={() => handleSelect(d.deviceId)}
                  />
                ))}
              </div>
            )}
          </div>
        ) : permState === 'granted' && !supportsSinkId ? (
          <div className="text-xs text-txt-tertiary">
            This browser doesn't support choosing an output device. Audio plays to the system default.
          </div>
        ) : (
          <div className="space-y-2">
            <div className="text-xs text-txt-tertiary">
              Grant microphone permission to list output devices (browsers gate output names behind microphone access).
            </div>
            <button
              onClick={() => { requestPermission().catch(() => {}); }}
              className="text-[13px] px-3 py-2 rounded-md bg-accent-primary hover:bg-accent-primary-hover text-white font-medium transition-colors"
            >
              Enable audio access
            </button>
          </div>
        )}

        <div>
          <div className="flex items-center justify-between mb-1.5">
            <div className="text-[13px] font-medium text-txt-primary">Output Volume</div>
            <div className="text-xs text-txt-tertiary tabular-nums">{outputVolume}%</div>
          </div>
          <input
            type="range"
            min={0}
            max={200}
            value={outputVolume}
            onChange={(e) => setOutputVolume(Number(e.target.value))}
            className="w-full h-1.5 rounded-full appearance-none cursor-pointer bg-surface-base [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:w-3 [&::-webkit-slider-thumb]:h-3 [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:bg-white [&::-webkit-slider-thumb]:shadow-md"
            style={{
              background: `linear-gradient(to right, rgb(var(--accent-primary)) 0%, rgb(var(--accent-primary)) ${outputVolume / 2}%, rgb(var(--interactive-muted)) ${outputVolume / 2}%, rgb(var(--interactive-muted)) 100%)`,
            }}
          />
        </div>

        <button
          onClick={handleTestTone}
          className="w-full text-[13px] px-3 py-2 rounded-md bg-surface-base hover:bg-interactive-hover text-txt-primary transition-colors flex items-center justify-center gap-2"
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
            <path d="M3 9v6h4l5 5V4L7 9H3zm13.5 3c0-1.77-1.02-3.29-2.5-4.03v8.05c1.48-.73 2.5-2.25 2.5-4.02z" />
          </svg>
          Play test sound
        </button>
      </div>
    </SectionShell>
  );
}
