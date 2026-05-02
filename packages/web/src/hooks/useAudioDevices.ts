import { useEffect, useMemo, useRef, useState, useCallback } from 'react';

/**
 * Permission state machine for audio device enumeration.
 *
 * - `unknown`: initial mount, before `permissions.query` resolves.
 * - `granted`: permission granted; both input + output lists populated.
 * - `prompt`:  permission not yet decided; lists empty until requestPermission().
 * - `denied`:  permission denied; lists empty.
 *
 * `permissions.query({ name: 'microphone' })` is the ONLY mount-time API call.
 * It is passive — does NOT light the mic indicator on any platform. We never
 * auto-fire `getUserMedia` to "unlock labels"; that requires an explicit user
 * gesture via `requestPermission()`.
 *
 * Note on output devices: there is no separate "speaker" permission. Browsers
 * gate output-device labels behind the same microphone permission. So a single
 * permission state covers both lists.
 */
export type AudioDevicesPermState = 'unknown' | 'granted' | 'prompt' | 'denied';

export interface UseAudioDevicesResult {
  permState: AudioDevicesPermState;
  inputs: MediaDeviceInfo[];
  outputs: MediaDeviceInfo[];
  inputLabels: Map<string, string>;
  outputLabels: Map<string, string>;
  /** Re-enumerate immediately. Safe to call any time after permission is granted. */
  refresh: () => void;
  /**
   * Explicit user gesture: fires `getUserMedia({audio:true})` to grant permission
   * and unlock device labels. Stops the stream immediately. Only call from a
   * click/keydown handler — calling this from an effect would defeat the privacy
   * model and flash the mic indicator.
   */
  requestPermission: () => Promise<void>;
}

function buildLabels(devices: MediaDeviceInfo[], kindLabel: string): Map<string, string> {
  const counts = new Map<string, number>();
  for (const d of devices) {
    if (d.label) counts.set(d.label, (counts.get(d.label) ?? 0) + 1);
  }
  const seen = new Map<string, number>();
  const labels = new Map<string, string>();
  devices.forEach((d, i) => {
    if (!d.label) {
      labels.set(d.deviceId, `${kindLabel} ${i + 1}`);
      return;
    }
    const total = counts.get(d.label) ?? 1;
    if (total <= 1) {
      labels.set(d.deviceId, d.label);
      return;
    }
    const used = (seen.get(d.label) ?? 0) + 1;
    seen.set(d.label, used);
    labels.set(d.deviceId, `${d.label} (${used})`);
  });
  return labels;
}

export function useAudioDevices(): UseAudioDevicesResult {
  const [permState, setPermState] = useState<AudioDevicesPermState>('unknown');
  const [inputs, setInputs] = useState<MediaDeviceInfo[]>([]);
  const [outputs, setOutputs] = useState<MediaDeviceInfo[]>([]);
  const mountedRef = useRef(true);
  const enumerateGenRef = useRef(0);

  const enumerate = useCallback(async () => {
    const gen = ++enumerateGenRef.current;
    try {
      const all = await navigator.mediaDevices.enumerateDevices();
      if (gen !== enumerateGenRef.current || !mountedRef.current) return;
      const seenIn = new Set<string>();
      const seenOut = new Set<string>();
      const ins: MediaDeviceInfo[] = [];
      const outs: MediaDeviceInfo[] = [];
      for (const d of all) {
        if (d.kind === 'audioinput' && !seenIn.has(d.deviceId)) {
          seenIn.add(d.deviceId);
          ins.push(d);
        } else if (d.kind === 'audiooutput' && !seenOut.has(d.deviceId)) {
          seenOut.add(d.deviceId);
          outs.push(d);
        }
      }
      setInputs(ins);
      setOutputs(outs);
    } catch {
      if (gen === enumerateGenRef.current && mountedRef.current) {
        setInputs([]);
        setOutputs([]);
      }
    }
  }, []);

  // Mount-time permission probe. Mirrors VideoSection.tsx:158-210.
  useEffect(() => {
    mountedRef.current = true;
    let cancelled = false;
    let status: PermissionStatus | null = null;
    let onChange: (() => void) | null = null;

    const apply = (state: PermissionState) => {
      if (cancelled || !mountedRef.current) return;
      if (state === 'granted') setPermState('granted');
      else if (state === 'prompt') setPermState('prompt');
      else setPermState('denied');
    };

    const run = async () => {
      if (!navigator.permissions || typeof navigator.permissions.query !== 'function') {
        if (!cancelled && mountedRef.current) setPermState('prompt');
        return;
      }
      try {
        // eslint-disable-next-line @typescript-eslint/consistent-type-assertions
        const s = await navigator.permissions.query({ name: 'microphone' as PermissionName });
        status = s;
        apply(s.state);
        onChange = () => apply(s.state);
        s.addEventListener('change', onChange);
      } catch {
        if (!cancelled && mountedRef.current) setPermState('prompt');
      }
    };

    run();

    return () => {
      cancelled = true;
      mountedRef.current = false;
      if (status && onChange) {
        try { status.removeEventListener('change', onChange); } catch { /* best-effort */ }
      }
    };
  }, []);

  // Enumerate when permission grants; refresh on devicechange.
  useEffect(() => {
    if (permState !== 'granted') return;
    enumerate();
    const onChange = () => { enumerate(); };
    navigator.mediaDevices.addEventListener('devicechange', onChange);
    return () => {
      navigator.mediaDevices.removeEventListener('devicechange', onChange);
    };
  }, [permState, enumerate]);

  const inputLabels = useMemo(() => buildLabels(inputs, 'Microphone'), [inputs]);
  const outputLabels = useMemo(() => buildLabels(outputs, 'Speakers'), [outputs]);

  const requestPermission = useCallback(async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      stream.getTracks().forEach(t => t.stop());
      if (mountedRef.current) {
        setPermState('granted');
        await enumerate();
      }
    } catch (err: unknown) {
      if (err instanceof Error && err.name === 'NotAllowedError' && mountedRef.current) {
        setPermState('denied');
      }
      throw err;
    }
  }, [enumerate]);

  return { permState, inputs, outputs, inputLabels, outputLabels, refresh: enumerate, requestPermission };
}
