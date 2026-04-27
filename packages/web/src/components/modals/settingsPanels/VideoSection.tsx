import { useEffect, useMemo, useRef, useState } from 'react';
import { useVoiceStore } from '../../../stores/voiceStore';
import { isElectron, getElectronAPI } from '../../../platform/platform';

type PermissionState = 'unknown' | 'probing' | 'granted' | 'initial-denied' | 'hard-blocked';

function errorName(err: unknown): string {
  return err instanceof Error ? err.name : '';
}

function getHardBlockedCopy(): string {
  if (!isElectron()) {
    return "Camera blocked at browser level. Click the camera icon in your browser's address bar, reset the permission, then click Try again.";
  }
  const platform = getElectronAPI()?.platform;
  if (platform === 'darwin') {
    return 'Grant camera access in System Settings → Privacy & Security → Camera, then restart the app.';
  }
  if (platform === 'win32') {
    return 'Grant camera access in Settings → Privacy & Security → Camera, then restart the app.';
  }
  // linux or unknown
  return 'Camera permission was denied. Reset it in your browser/Chromium prompt and try again.';
}

/**
 * Build a deviceId → display-label map applying the spec's rules:
 * - Empty `label` falls back to `"Camera N"` using enumeration index.
 * - Duplicate non-empty labels get `" (1)"`, `" (2)"` suffixes by enumeration order.
 *   Single occurrences stay unsuffixed.
 */
function buildDisplayLabels(devices: MediaDeviceInfo[]): Map<string, string> {
  const counts = new Map<string, number>();
  for (const d of devices) {
    if (d.label) counts.set(d.label, (counts.get(d.label) ?? 0) + 1);
  }
  const seen = new Map<string, number>();
  const labels = new Map<string, string>();
  devices.forEach((d, i) => {
    if (!d.label) {
      labels.set(d.deviceId, `Camera ${i + 1}`);
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

export function VideoSection() {
  const cameraDeviceId = useVoiceStore((s) => s.cameraDeviceId);
  const setCameraDeviceId = useVoiceStore((s) => s.setCameraDeviceId);

  const [permState, setPermState] = useState<PermissionState>('unknown');
  const [devices, setDevices] = useState<MediaDeviceInfo[]>([]);
  const [listOpen, setListOpen] = useState(false);
  // Tracks mount state so async probe handlers don't write to state after unmount.
  const mountedRef = useRef(true);
  // Anchor for the dropdown's click-outside-to-close behaviour.
  const dropdownRef = useRef<HTMLDivElement>(null);

  // Close the dropdown when the user clicks outside it.
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

  // Run the probe once on mount.
  useEffect(() => {
    mountedRef.current = true;
    const probe = async () => {
      setPermState('probing');
      try {
        const stream = await navigator.mediaDevices.getUserMedia({ video: true });
        // Stop immediately — we only needed to unlock labels and verify access.
        stream.getTracks().forEach((t) => t.stop());
        if (mountedRef.current) setPermState('granted');
      } catch (err) {
        if (!mountedRef.current) return;
        if (errorName(err) === 'NotAllowedError') setPermState('initial-denied');
        else setPermState('granted'); // NotFoundError / NotReadableError — still allow dropdown render
      }
    };
    probe();
    return () => {
      mountedRef.current = false;
    };
  }, []);

  // Enumerate cameras when permission is granted; refresh on devicechange.
  useEffect(() => {
    if (permState !== 'granted') return;

    let cancelled = false;
    const enumerate = async () => {
      try {
        const all = await navigator.mediaDevices.enumerateDevices();
        if (cancelled) return;
        const seen = new Set<string>();
        const cams: MediaDeviceInfo[] = [];
        for (const d of all) {
          if (d.kind !== 'videoinput') continue;
          if (seen.has(d.deviceId)) continue;
          seen.add(d.deviceId);
          cams.push(d);
        }
        setDevices(cams);
      } catch {
        if (!cancelled) setDevices([]);
      }
    };

    enumerate();
    const onChange = () => {
      enumerate();
    };
    navigator.mediaDevices.addEventListener('devicechange', onChange);
    return () => {
      cancelled = true;
      navigator.mediaDevices.removeEventListener('devicechange', onChange);
    };
  }, [permState]);

  const displayLabels = useMemo(() => buildDisplayLabels(devices), [devices]);

  const handleTryAgain = async () => {
    setPermState('probing');
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ video: true });
      stream.getTracks().forEach((t) => t.stop());
      if (mountedRef.current) setPermState('granted');
    } catch (err) {
      if (!mountedRef.current) return;
      // Second denial → escalate to hard-blocked.
      if (errorName(err) === 'NotAllowedError') setPermState('hard-blocked');
      else setPermState('initial-denied');
    }
  };

  if (permState === 'unknown' || permState === 'probing') {
    return (
      <div>
        <div className="text-[11px] font-semibold text-txt-tertiary uppercase tracking-wider mb-1.5">
          Video
        </div>
        <div className="rounded-lg bg-white/[0.03] border border-white/[0.04] p-3.5 text-sm text-txt-tertiary">
          Checking camera access…
        </div>
      </div>
    );
  }

  if (permState === 'initial-denied' || permState === 'hard-blocked') {
    return (
      <div>
        <div className="text-[11px] font-semibold text-txt-tertiary uppercase tracking-wider mb-1.5">
          Video
        </div>
        <div className="rounded-lg bg-white/[0.03] border border-white/[0.04] p-3.5 space-y-2">
          <div className="text-sm text-txt-primary">⚠ Camera access denied</div>
          <div className="text-xs text-txt-tertiary">
            {permState === 'hard-blocked'
              ? getHardBlockedCopy()
              : 'Grant camera permission to choose a camera.'}
          </div>
          <button
            onClick={handleTryAgain}
            className="text-xs px-3 py-1.5 rounded-md bg-surface-base hover:bg-interactive-hover text-txt-secondary transition-colors"
          >
            Try again
          </button>
        </div>
      </div>
    );
  }

  // permState === 'granted'
  const selectedLabel =
    cameraDeviceId === null
      ? 'Auto (system default)'
      : displayLabels.get(cameraDeviceId) ?? 'Auto (system default)';

  const handleSelect = (id: string | null) => {
    setCameraDeviceId(id);
    setListOpen(false);
  };

  return (
    <div>
      <div className="text-[11px] font-semibold text-txt-tertiary uppercase tracking-wider mb-1.5">
        Video
      </div>
      <div className="rounded-lg bg-white/[0.03] border border-white/[0.04] p-3.5">
        <div className="text-[13px] font-medium text-txt-primary mb-1.5">Camera</div>
        <div ref={dropdownRef}>
          <button
            type="button"
            onClick={() => setListOpen((v) => !v)}
            className="w-full px-3 py-2 flex items-center justify-between rounded-md bg-surface-base hover:bg-interactive-hover transition-colors"
          >
            <span className="text-[13px] text-txt-primary truncate text-left">{selectedLabel}</span>
            <svg
              width="16"
              height="16"
              viewBox="0 0 24 24"
              fill="currentColor"
              className={`text-txt-tertiary flex-shrink-0 ml-2 transition-transform ${listOpen ? 'rotate-90' : ''}`}
            >
              <path d="M10 6L8.59 7.41 13.17 12l-4.58 4.59L10 18l6-6z" />
            </svg>
          </button>
          {listOpen && (
            <div className="mt-1 rounded-md bg-surface-base border border-border-hard py-1">
              <DropdownItem
                label="Auto (system default)"
                active={cameraDeviceId === null}
                onClick={() => handleSelect(null)}
              />
              {devices.map((d) => (
                <DropdownItem
                  key={d.deviceId}
                  label={displayLabels.get(d.deviceId) ?? d.deviceId}
                  active={cameraDeviceId === d.deviceId}
                  onClick={() => handleSelect(d.deviceId)}
                />
              ))}
            </div>
          )}
        </div>
        {devices.length === 0 && (
          <div className="text-xs text-txt-tertiary mt-1">No cameras detected.</div>
        )}
      </div>
    </div>
  );
}

interface DropdownItemProps {
  label: string;
  active: boolean;
  onClick: () => void;
}

function DropdownItem({ label, active, onClick }: DropdownItemProps) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`w-full px-3 py-2 text-left text-[13px] hover:bg-interactive-hover transition-colors flex items-center gap-2 ${
        active ? 'text-txt-primary' : 'text-txt-secondary'
      }`}
    >
      {active && (
        <svg
          width="16"
          height="16"
          viewBox="0 0 24 24"
          fill="currentColor"
          className="text-accent-primary flex-shrink-0"
        >
          <path d="M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z" />
        </svg>
      )}
      <span className={`truncate ${active ? '' : 'pl-6'}`}>{label}</span>
    </button>
  );
}
