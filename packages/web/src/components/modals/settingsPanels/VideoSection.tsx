import { useEffect, useRef, useState } from 'react';
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

export function VideoSection() {
  const [permState, setPermState] = useState<PermissionState>('unknown');
  // Tracks mount state so async probe handlers don't write to state after unmount.
  const mountedRef = useRef(true);

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

  // permState === 'granted' — main UI added in T9–T12.
  return (
    <div>
      <div className="text-[11px] font-semibold text-txt-tertiary uppercase tracking-wider mb-1.5">
        Video
      </div>
      <div className="rounded-lg bg-white/[0.03] border border-white/[0.04] p-3.5 text-sm text-txt-tertiary italic">
        (UI under construction — Task 9 adds dropdown, T10–T11 add preview, T12 adds lifecycle.)
      </div>
    </div>
  );
}
