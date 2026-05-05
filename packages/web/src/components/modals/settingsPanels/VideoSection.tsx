import { useEffect, useMemo, useRef, useState } from 'react';
import { Track } from 'livekit-client';
import { useVoiceStore } from '../../../stores/voiceStore';
import { getActiveRoom } from '../../../hooks/useLiveKit';
import { isElectron, getElectronAPI } from '../../../platform/platform';

/**
 * Permission state machine for the Video section.
 *
 * - `unknown`     : initial mount, before `permissions.query` resolves.
 * - `granted`     : permission granted; dropdown is populated; tile is dormant
 *                   until user clicks (or attaches to an in-call LK track).
 * - `prompt`      : permission not yet decided; dropdown hidden; CTA card shown.
 * - `denied`      : permission denied; banner shown with "Try again".
 * - `hard-blocked`: a "Try again" attempt failed with NotAllowedError → escalate
 *                   the banner to platform-specific recovery instructions.
 *
 * `permissions.query({ name: 'camera' })` is the ONLY mount-time camera API
 * call. It does not light the LED on any platform. `getUserMedia` is fired
 * exclusively from explicit user gestures (dormant-tile click, prompt CTA,
 * "Try again" button).
 */
type PermissionStatus = 'unknown' | 'granted' | 'prompt' | 'denied' | 'hard-blocked';

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
  const isCameraOn = useVoiceStore((s) => s.isCameraOn);

  const [permState, setPermState] = useState<PermissionStatus>('unknown');
  const [devices, setDevices] = useState<MediaDeviceInfo[]>([]);
  const [listOpen, setListOpen] = useState(false);
  // Whether the user has explicitly opened the pre-call preview. Goes false on
  // Stop-preview, tab hidden, unmount, or when in-call mode takes over. Drives
  // (a) whether `getUserMedia` is currently running and (b) whether the
  // currently-using subline is visible.
  const [previewActive, setPreviewActive] = useState(false);
  const [previewError, setPreviewError] = useState<string | null>(null);
  // Tracks the deviceId the browser actually picked for the active preview track.
  // Drives the "Currently using: …" subline shown only when previewActive (or
  // in-call attach) AND cameraDeviceId === null.
  const [activeDeviceId, setActiveDeviceId] = useState<string | null>(null);
  // Tracks mount state so async handlers don't write to state after unmount.
  const mountedRef = useRef(true);
  // Anchor for the dropdown's click-outside-to-close behaviour.
  const dropdownRef = useRef<HTMLDivElement>(null);
  // Preview tile refs.
  const previewVideoRef = useRef<HTMLVideoElement>(null);
  const previewStreamRef = useRef<MediaStream | null>(null);
  // Tracks whether the active in-flight preview-start request is still wanted
  // (cancellable by Stop preview, unmount, visibility change, or re-click).
  const startGenRef = useRef(0);

  // Stop the user-owned pre-call getUserMedia stream and release the camera
  // light. macOS holds the LED on for ~2s after release (hardware debounce).
  const stopPreCall = () => {
    if (previewStreamRef.current) {
      previewStreamRef.current.getTracks().forEach((t) => t.stop());
      previewStreamRef.current = null;
    }
    const videoEl = previewVideoRef.current;
    if (videoEl && videoEl.srcObject instanceof MediaStream) {
      videoEl.srcObject = null;
    }
  };

  // Detach an in-call LK track. NEVER call mst.stop() — the publication is
  // still being consumed by other call participants.
  const detachInCall = () => {
    const videoEl = previewVideoRef.current;
    if (videoEl) videoEl.srcObject = null;
  };

  // Close the dropdown when the user clicks outside it. Listens for both
  // mousedown and touchstart so the popover dismisses with a single tap on
  // touch devices (iOS Safari does not synthesize mousedown reliably from
  // touch).
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

  // Tab-visibility cleanup: release the camera light when the tab is hidden.
  // Per spec, we DO NOT auto-resume on visibility return — the tile goes
  // dormant and the user clicks again. Auto-resume would defeat the privacy
  // model by silently re-lighting the LED on tab focus.
  useEffect(() => {
    const onVisibility = () => {
      if (document.visibilityState === 'hidden' && previewActive) {
        startGenRef.current += 1; // cancel any in-flight start
        stopPreCall();
        setPreviewActive(false);
        setActiveDeviceId(null);
      }
    };
    document.addEventListener('visibilitychange', onVisibility);
    return () => document.removeEventListener('visibilitychange', onVisibility);
  }, [previewActive]);

  // Mount-time permission probe via the Permissions API. This is the ONLY
  // automatic camera-related call on mount. It is passive and does not light
  // the LED. `'camera'` is not in the `PermissionName` union in lib.dom.d.ts
  // but is supported in Chromium 64+ (every Electron version this project
  // ships), Firefox 79+, Safari 16+. The `as PermissionName` cast is the
  // standard escape hatch.
  useEffect(() => {
    mountedRef.current = true;

    let cancelled = false;
    let status: PermissionStatus_API | null = null;
    let onChange: (() => void) | null = null;

    const apply = (state: PermissionState) => {
      if (cancelled || !mountedRef.current) return;
      if (state === 'granted') setPermState('granted');
      else if (state === 'prompt') setPermState('prompt');
      else setPermState('denied');
    };

    const run = async () => {
      // Permissions API may be missing entirely (older Safari, locked-down
      // environments). If so, we conservatively render the prompt-state CTA so
      // the user can still grant permission via an explicit click — rather
      // than firing getUserMedia behind their back.
      if (!navigator.permissions || typeof navigator.permissions.query !== 'function') {
        if (!cancelled && mountedRef.current) setPermState('prompt');
        return;
      }
      try {
        // eslint-disable-next-line @typescript-eslint/consistent-type-assertions
        const s = await navigator.permissions.query({ name: 'camera' as PermissionName });
        status = s as PermissionStatus_API;
        apply(s.state);
        // Re-render if the user grants/revokes via OS or browser settings while
        // the section is open.
        onChange = () => apply(s.state);
        s.addEventListener('change', onChange);
      } catch {
        // Some browsers/platforms throw on `name: 'camera'` (older Firefox).
        // Fall back to the prompt CTA — never fire getUserMedia automatically.
        if (!cancelled && mountedRef.current) setPermState('prompt');
      }
    };

    run();

    return () => {
      cancelled = true;
      mountedRef.current = false;
      if (status && onChange) {
        try {
          status.removeEventListener('change', onChange);
        } catch {
          // ignore — best-effort cleanup
        }
      }
    };
  }, []);

  // Enumerate cameras when permission is granted; refresh on devicechange.
  // enumerateDevices() is passive and never lights the LED.
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

  // In-call attach: when an LK camera publication exists with a live track,
  // attach it to the preview <video>. No getUserMedia, no extra LED activity —
  // the LED is already on for the call publication. Reactive on `isCameraOn`
  // and `cameraDeviceId` so hot-swap mid-call updates the preview source.
  //
  // When `isCameraOn` flips false mid-session, the tile returns to DORMANT
  // (no auto-restart of getUserMedia) per the privacy model.
  useEffect(() => {
    if (permState !== 'granted') return;
    if (!isCameraOn) {
      // Camera turned off — detach any in-call attachment. Tile becomes dormant
      // unless the user has an active opt-in pre-call preview running.
      detachInCall();
      if (!previewActive) setActiveDeviceId(null);
      return;
    }

    const room = getActiveRoom();
    if (!room) return;
    const camPub = Array.from(room.localParticipant.trackPublications.values()).find(
      (pub) => pub.source === Track.Source.Camera,
    );
    const mst = camPub?.track?.mediaStreamTrack;
    if (!mst || mst.readyState !== 'live') return;

    // If a pre-call preview is running, stop it cleanly — the in-call track
    // takes over the tile. The LK track's LED is already on for the call.
    if (previewActive) {
      startGenRef.current += 1;
      stopPreCall();
      setPreviewActive(false);
    }

    const videoEl = previewVideoRef.current;
    if (!videoEl) return;
    // Wrap the LK MediaStreamTrack in a fresh MediaStream for srcObject.
    // This mirrors LiveKit's `track.attach()` internally; the wrapper does
    // not duplicate or take ownership of the track.
    videoEl.srcObject = new MediaStream([mst]);
    videoEl.play().catch(() => {});
    setActiveDeviceId(mst.getSettings().deviceId ?? null);
    setPreviewError(null);

    return () => {
      detachInCall();
    };
    // We intentionally exclude `previewActive` from deps — its only role here
    // is to short-circuit the "stop pre-call before attach" branch, which is
    // already idempotent. Including it would re-run the attach on every
    // user-driven start/stop click, causing visible flicker on the tile.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [permState, isCameraOn, cameraDeviceId]);

  // When the user changes the dropdown WHILE the pre-call preview is running,
  // re-open getUserMedia for the new device. (Same effect was previously
  // bundled into the dual-mode auto-start; isolating it here makes the dormant
  // state truly dormant.)
  useEffect(() => {
    if (permState !== 'granted') return;
    if (!previewActive) return;
    if (isCameraOn) return; // in-call mode handles its own swap via syncCamera

    const gen = ++startGenRef.current;
    stopPreCall();

    const start = async () => {
      try {
        const stream = await navigator.mediaDevices.getUserMedia({
          video: cameraDeviceId ? { deviceId: { exact: cameraDeviceId } } : true,
        });
        if (gen !== startGenRef.current || !mountedRef.current) {
          stream.getTracks().forEach((t) => t.stop());
          return;
        }
        previewStreamRef.current = stream;
        const videoEl = previewVideoRef.current;
        if (videoEl) {
          videoEl.srcObject = stream;
          videoEl.play().catch(() => {});
        }
        const id = stream.getVideoTracks()[0]?.getSettings().deviceId ?? null;
        setActiveDeviceId(id);
        setPreviewError(null);
      } catch (err) {
        if (gen !== startGenRef.current || !mountedRef.current) return;
        const name = errorName(err);
        if (name === 'NotReadableError') setPreviewError('Camera is in use by another application.');
        else if (name === 'OverconstrainedError') setPreviewError('Selected camera is unavailable.');
        else if (name === 'NotAllowedError') {
          setPermState('denied');
          setPreviewActive(false);
        } else setPreviewError('Could not start camera preview.');
      }
    };

    start();
    // Cleanup runs on next deviceId change or unmount.
    return () => {
      // Bumping gen invalidates the in-flight start; actual track stop happens
      // when the user clicks Stop preview or via the unmount cleanup below.
    };
  }, [cameraDeviceId, previewActive, isCameraOn, permState]);

  // Component-unmount cleanup: stop any live preview stream so the LED goes off
  // when the modal closes / settings tab changes / route changes.
  useEffect(() => {
    return () => {
      startGenRef.current += 1;
      stopPreCall();
    };
  }, []);

  const displayLabels = useMemo(() => buildDisplayLabels(devices), [devices]);

  // Explicit user gesture: open getUserMedia for the selected device.
  // Called from (a) click on dormant tile, (b) "Enable camera preview" CTA,
  // (c) retry from an error state.
  const startPreviewFromUser = async () => {
    setPreviewError(null);
    const gen = ++startGenRef.current;
    stopPreCall();
    setPreviewActive(true);

    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: cameraDeviceId ? { deviceId: { exact: cameraDeviceId } } : true,
      });
      if (gen !== startGenRef.current || !mountedRef.current) {
        stream.getTracks().forEach((t) => t.stop());
        return;
      }
      previewStreamRef.current = stream;
      const videoEl = previewVideoRef.current;
      if (videoEl) {
        videoEl.srcObject = stream;
        videoEl.play().catch(() => {});
      }
      const id = stream.getVideoTracks()[0]?.getSettings().deviceId ?? null;
      setActiveDeviceId(id);
      // If we were in `prompt` state, this getUserMedia call also granted
      // permission. Transition to `granted`; the enumerate effect picks up.
      if (mountedRef.current) {
        setPermState((prev) => (prev === 'prompt' || prev === 'denied' ? 'granted' : prev));
      }
    } catch (err) {
      if (gen !== startGenRef.current || !mountedRef.current) return;
      const name = errorName(err);
      if (name === 'NotAllowedError') {
        // First-prompt deny from `prompt` state, or "Try again" denial from `denied`.
        setPermState((prev) => (prev === 'denied' ? 'hard-blocked' : 'denied'));
        setPreviewActive(false);
      } else if (name === 'NotReadableError') {
        setPreviewError('Camera is in use by another application.');
      } else if (name === 'OverconstrainedError') {
        setPreviewError('Selected camera is unavailable.');
      } else if (name === 'NotFoundError') {
        setPreviewError('No camera detected.');
      } else {
        setPreviewError('Could not start camera preview.');
      }
    }
  };

  const stopPreviewFromUser = () => {
    startGenRef.current += 1;
    stopPreCall();
    setPreviewActive(false);
    setActiveDeviceId(null);
    setPreviewError(null);
  };

  // ── Render ────────────────────────────────────────────────────────────

  if (permState === 'unknown') {
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

  if (permState === 'denied' || permState === 'hard-blocked') {
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
            onClick={startPreviewFromUser}
            className="text-xs px-3 py-1.5 rounded-md bg-surface-base hover:bg-interactive-hover text-txt-secondary transition-colors"
          >
            Try again
          </button>
        </div>
      </div>
    );
  }

  if (permState === 'prompt') {
    return (
      <div>
        <div className="text-[11px] font-semibold text-txt-tertiary uppercase tracking-wider mb-1.5">
          Video
        </div>
        <div className="rounded-lg bg-white/[0.03] border border-white/[0.04] p-3.5 space-y-3">
          <div className="aspect-video w-full rounded-lg bg-surface-base overflow-hidden relative flex flex-col items-center justify-center text-center px-6">
            <svg width="32" height="32" viewBox="0 0 24 24" fill="currentColor" className="text-txt-tertiary mb-2">
              <path d="M17 10.5V7a1 1 0 00-1-1H4a1 1 0 00-1 1v10a1 1 0 001 1h12a1 1 0 001-1v-3.5l4 4v-11l-4 4z" />
            </svg>
            <div className="text-sm text-txt-secondary mb-1">
              Camera permission needed to choose a camera and preview.
            </div>
          </div>
          <button
            onClick={startPreviewFromUser}
            className="w-full text-[13px] px-3 py-2 rounded-md bg-accent-primary hover:bg-accent-primary-hover active:bg-accent-primary-active text-white font-medium transition-colors"
          >
            Enable camera preview
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

  // The preview tile is "dormant" when no in-call track is attached AND no
  // user-initiated preview is running. In dormant state we render a play-icon
  // overlay and a click handler that calls startPreviewFromUser.
  const inCallAttached = isCameraOn && activeDeviceId !== null && !previewActive;
  const isDormant = !previewActive && !inCallAttached;

  return (
    <div>
      <div className="text-[11px] font-semibold text-txt-tertiary uppercase tracking-wider mb-1.5">
        Video
      </div>
      <div className="rounded-lg bg-white/[0.03] border border-white/[0.04] p-3.5">
        <div className="aspect-video w-full rounded-lg bg-surface-base overflow-hidden relative mb-3 group">
          <video
            ref={previewVideoRef}
            muted
            playsInline
            autoPlay
            className={`w-full h-full object-cover ${isDormant ? 'invisible' : ''}`}
            style={{ transform: 'scaleX(-1)' }}
          />
          {isDormant && (
            <button
              type="button"
              onClick={startPreviewFromUser}
              aria-label="Test camera"
              className="absolute inset-0 flex flex-col items-center justify-center text-txt-tertiary hover:text-txt-secondary hover:bg-white/[0.02] transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-primary"
            >
              <svg width="40" height="40" viewBox="0 0 24 24" fill="currentColor" className="mb-2">
                <path d="M8 5v14l11-7z" />
              </svg>
              <span className="text-xs">Click to test camera</span>
            </button>
          )}
          {previewActive && !previewError && (
            <button
              type="button"
              onClick={stopPreviewFromUser}
              // Mobile: always visible (no hover state) and 44 px tap target
              // per iOS HIG. Desktop: original hover-reveal compact pill.
              className="absolute top-2 right-2 rounded-md bg-black/60 hover:bg-black/75 text-white/90 transition-colors focus-visible:opacity-100
                         min-h-[44px] min-w-[44px] px-3 py-2 text-xs flex items-center justify-center
                         md:min-h-0 md:min-w-0 md:text-[11px] md:px-2 md:py-1 md:opacity-0 md:group-hover:opacity-100"
            >
              Stop preview
            </button>
          )}
          {previewError && (
            <div className="absolute inset-0 flex flex-col items-center justify-center bg-surface-base/90 text-xs text-txt-tertiary text-center px-4 gap-2">
              <div>{previewError}</div>
              <button
                type="button"
                onClick={startPreviewFromUser}
                className="text-[11px] px-2 py-1 rounded-md bg-surface-base hover:bg-interactive-hover text-txt-secondary transition-colors"
              >
                Try again
              </button>
            </div>
          )}
        </div>
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
        {cameraDeviceId === null &&
          activeDeviceId &&
          (previewActive || isCameraOn) &&
          (() => {
            const m = devices.find((d) => d.deviceId === activeDeviceId);
            const label = m
              ? displayLabels.get(activeDeviceId) ?? (m.label || 'detected camera')
              : 'detected camera';
            return <div className="text-xs text-txt-tertiary mt-1">Currently using: {label}</div>;
          })()}
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

// Local alias for the runtime PermissionStatus event-target. The lib.dom name
// `PermissionStatus` clashes with our internal state-machine type name above,
// so we alias it here at the bottom for the listener-cleanup branch.
type PermissionStatus_API = globalThis.PermissionStatus;
