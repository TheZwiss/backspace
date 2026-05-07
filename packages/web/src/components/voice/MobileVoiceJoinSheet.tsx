import { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { createPortal } from 'react-dom';
import { useVoiceStore } from '../../stores/voiceStore';
import { useSpaceStore } from '../../stores/spaceStore';
import { VoiceUserRow } from './VoiceUserRow';

/**
 * Permission state for the in-sheet camera preview. Mirrors the smaller
 * version of the state machine in `VideoSection.tsx` — but pre-join we treat
 * `denied` and `hard-blocked` the same (single retry path; user can still join
 * voice without preview).
 */
type CameraPermState = 'unknown' | 'granted' | 'prompt' | 'denied';

function errorName(err: unknown): string {
  return err instanceof Error ? err.name : '';
}

interface MobileVoiceJoinSheetProps {
  channelId: string;
  channelName: string;
  spaceId: string;
  onClose: () => void;
  onJoin: (channelId: string, preMuted: boolean) => void;
}

export function MobileVoiceJoinSheet({
  channelId,
  channelName,
  spaceId,
  onClose,
  onJoin,
}: MobileVoiceJoinSheetProps) {
  const [preMuted, setPreMuted] = useState(false);
  const [visible, setVisible] = useState(false);

  const voiceUsers = useVoiceStore((s) => s.voiceUsers);
  const voiceUserStates = useVoiceStore((s) => s.voiceUserStates);
  const currentVoiceChannelId = useVoiceStore((s) => s.currentVoiceChannelId);
  const spaceMutedUserIds = useVoiceStore((s) => s.spaceMutedUserIds);
  const spaceDeafenedUserIds = useVoiceStore((s) => s.spaceDeafenedUserIds);
  const permissionMutedUserIds = useVoiceStore((s) => s.permissionMutedUserIds);
  const speakingUserIds = useVoiceStore((s) => s.speakingUserIds);
  const cameraDeviceId = useVoiceStore((s) => s.cameraDeviceId);
  const setCameraDeviceId = useVoiceStore((s) => s.setCameraDeviceId);

  const members = useSpaceStore((s) => s.members);
  const channels = useSpaceStore((s) => s.channels);

  // ── Camera preview state (pre-join) ─────────────────────────────────────
  // Mirrors `VideoSection.tsx`'s explicit-gesture pattern. We never fire
  // getUserMedia on mount — only on user-tap of the "Enable preview" CTA or
  // dropdown re-select while preview is already active. The preview is hard-
  // bound to the sheet lifecycle: closing the sheet (any path: backdrop tap,
  // close button, Join, channel-switch) stops the stream and releases the LED.
  const [permState, setPermState] = useState<CameraPermState>('unknown');
  const [previewActive, setPreviewActive] = useState(false);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [cameraDevices, setCameraDevices] = useState<MediaDeviceInfo[]>([]);
  const [pickerOpen, setPickerOpen] = useState(false);
  const previewVideoRef = useRef<HTMLVideoElement>(null);
  const previewStreamRef = useRef<MediaStream | null>(null);
  const startGenRef = useRef(0);
  const mountedRef = useRef(true);
  const pickerAnchorRef = useRef<HTMLDivElement>(null);
  // Portaled-popup ref. The popup is rendered into document.body to escape the
  // sheet's `aspect-video overflow-hidden` parent (which clipped the top of the
  // list when the device list was long). Click-outside checks both the anchor
  // and this portaled popup so taps on list items don't dismiss it.
  const pickerPopupRef = useRef<HTMLDivElement>(null);
  const [pickerPopupRect, setPickerPopupRect] = useState<{ left: number; bottom: number } | null>(null);

  // Stop the active preview stream (releases the camera LED). macOS holds the
  // LED on for ~2s after release (hardware debounce).
  const stopPreview = useCallback(() => {
    if (previewStreamRef.current) {
      previewStreamRef.current.getTracks().forEach((t) => t.stop());
      previewStreamRef.current = null;
    }
    const videoEl = previewVideoRef.current;
    if (videoEl && videoEl.srcObject instanceof MediaStream) {
      videoEl.srcObject = null;
    }
  }, []);

  // Trigger slide-up animation on mount
  useEffect(() => {
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        setVisible(true);
      });
    });
  }, []);

  // Mount-time camera permission probe. `permissions.query` does not light the
  // LED; getUserMedia is gated behind explicit user gestures only. If the
  // Permissions API is missing or rejects 'camera', we fall back to `prompt`
  // so the user can still trigger the preview manually.
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
        const s = await navigator.permissions.query({ name: 'camera' as PermissionName });
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
        try {
          status.removeEventListener('change', onChange);
        } catch {
          // best-effort cleanup
        }
      }
    };
  }, []);

  // Enumerate cameras when permission is granted; refresh on devicechange.
  // Passive — does not light the LED.
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
        setCameraDevices(cams);
      } catch {
        if (!cancelled) setCameraDevices([]);
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

  // Hard cleanup: when the sheet unmounts (any close path), stop the stream
  // and release the camera. This is the single source of truth for "camera
  // off when sheet closes" — every close handler funnels through unmount via
  // the parent removing the component.
  useEffect(() => {
    return () => {
      startGenRef.current += 1;
      stopPreview();
    };
  }, [stopPreview]);

  // Tab-visibility cleanup: release LED when tab is hidden. Spec choice (same
  // as VideoSection): no auto-resume — user must re-tap to re-arm.
  useEffect(() => {
    const onVisibility = () => {
      if (document.visibilityState === 'hidden' && previewActive) {
        startGenRef.current += 1;
        stopPreview();
        setPreviewActive(false);
      }
    };
    document.addEventListener('visibilitychange', onVisibility);
    return () => document.removeEventListener('visibilitychange', onVisibility);
  }, [previewActive, stopPreview]);

  // Camera-device picker click-outside (mousedown + touchstart).
  // Both the anchor (in-tile button) AND the portaled popup are excluded — the
  // popup is rendered into document.body to escape the sheet's overflow-hidden
  // parent, so it isn't a DOM descendant of the anchor.
  useEffect(() => {
    if (!pickerOpen) return;
    const onPointerDown = (e: MouseEvent | TouchEvent) => {
      const target = e.target as Node;
      const inAnchor = pickerAnchorRef.current?.contains(target) ?? false;
      const inPopup = pickerPopupRef.current?.contains(target) ?? false;
      if (!inAnchor && !inPopup) setPickerOpen(false);
    };
    document.addEventListener('mousedown', onPointerDown);
    document.addEventListener('touchstart', onPointerDown, { passive: true });
    return () => {
      document.removeEventListener('mousedown', onPointerDown);
      document.removeEventListener('touchstart', onPointerDown);
    };
  }, [pickerOpen]);

  // When the picker opens, capture the anchor's screen position so we can
  // portal the popup to document.body just above it. Using `bottom` keeps the
  // popup pinned to the top of the anchor's frame (so it expands upward and
  // is naturally constrained by `max-height + overflow-y-auto`).
  useEffect(() => {
    if (!pickerOpen) {
      setPickerPopupRect(null);
      return;
    }
    const anchorBtn = pickerAnchorRef.current?.querySelector('button');
    if (!anchorBtn) return;
    const update = () => {
      const r = anchorBtn.getBoundingClientRect();
      setPickerPopupRect({
        left: r.left,
        // distance from viewport bottom to anchor top, plus a small gap
        bottom: window.innerHeight - r.top + 4,
      });
    };
    update();
    window.addEventListener('resize', update);
    window.addEventListener('scroll', update, true);
    return () => {
      window.removeEventListener('resize', update);
      window.removeEventListener('scroll', update, true);
    };
  }, [pickerOpen]);

  // When the user changes camera selection while preview is running, swap.
  useEffect(() => {
    if (permState !== 'granted') return;
    if (!previewActive) return;

    const gen = ++startGenRef.current;
    stopPreview();

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
          // iOS Safari: srcObject + autoPlay + muted + playsInline. The video
          // element below sets `autoPlay playsInline muted`, so this play() is
          // redundant on most browsers — but it makes Chrome desktop happy and
          // doesn't hurt iOS. (Captured in handoff Known Traps.)
          videoEl.srcObject = stream;
          videoEl.play().catch(() => {});
        }
        setPreviewError(null);
      } catch (err) {
        if (gen !== startGenRef.current || !mountedRef.current) return;
        const name = errorName(err);
        if (name === 'NotAllowedError') {
          setPermState('denied');
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

    start();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cameraDeviceId, previewActive, permState]);

  const userIds = useMemo(() => voiceUsers.get(channelId) || [], [voiceUsers, channelId]);

  const userCount = userIds.length;
  const userCountLabel = userCount === 1 ? '1 Person in Voice' : `${userCount} People in Voice`;

  // Determine if switching channels
  const isSwitching = currentVoiceChannelId !== null && currentVoiceChannelId !== channelId;
  const currentChannelName = useMemo(() => {
    if (!currentVoiceChannelId) return '';
    const ch = channels.find((c) => c.id === currentVoiceChannelId);
    return ch?.name || '';
  }, [currentVoiceChannelId, channels]);

  const handleJoin = useCallback(() => {
    onJoin(channelId, preMuted);
  }, [channelId, preMuted, onJoin]);

  const handleBackdropClick = useCallback(() => {
    onClose();
  }, [onClose]);

  // Explicit user gesture: open getUserMedia for the selected camera.
  const startPreviewFromUser = useCallback(async () => {
    setPreviewError(null);
    const gen = ++startGenRef.current;
    stopPreview();
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
      if (mountedRef.current) {
        setPermState((prev) => (prev === 'prompt' || prev === 'denied' ? 'granted' : prev));
      }
    } catch (err) {
      if (gen !== startGenRef.current || !mountedRef.current) return;
      const name = errorName(err);
      if (name === 'NotAllowedError') {
        setPermState('denied');
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
  }, [cameraDeviceId, stopPreview]);

  const stopPreviewFromUser = useCallback(() => {
    startGenRef.current += 1;
    stopPreview();
    setPreviewActive(false);
    setPreviewError(null);
  }, [stopPreview]);

  // Derived: do we have multiple cameras to expose a picker for?
  const showCameraPicker = permState === 'granted' && cameraDevices.length > 1;
  const selectedCameraLabel = useMemo(() => {
    if (cameraDeviceId === null) return 'Auto';
    const d = cameraDevices.find((c) => c.deviceId === cameraDeviceId);
    return d?.label || 'Selected camera';
  }, [cameraDeviceId, cameraDevices]);

  return createPortal(
    <>
      {/* Backdrop */}
      <div
        className="fixed inset-0 bg-black/50 z-50"
        onClick={handleBackdropClick}
      />

      {/* Sheet container */}
      <div
        className={`glass-bubble fixed bottom-0 left-0 right-0 z-50 rounded-t-2xl transition-transform duration-300 ease-out ${
          visible ? 'translate-y-0' : 'translate-y-full'
        }`}
        style={{ paddingBottom: 'env(safe-area-inset-bottom)' }}
      >
        {/* Drag handle */}
        <div className="w-10 h-1 rounded-full bg-white/20 mx-auto mt-3 mb-4" />

        {/* Header */}
        <div className="flex items-center justify-between px-5 mb-2">
          <h2 className="text-base font-bold text-txt-primary truncate">{channelName}</h2>
        </div>

        {/* User count */}
        {userCount > 0 && (
          <p className="text-sm text-txt-tertiary px-5 mb-3">{userCountLabel}</p>
        )}

        {/* Channel switch warning */}
        {isSwitching && (
          <div className="mx-5 mb-3 px-3 py-2 rounded-lg bg-accent-amber/10 text-accent-amber text-xs">
            You'll leave <span className="font-semibold">{currentChannelName}</span> and join{' '}
            <span className="font-semibold">{channelName}</span>
          </div>
        )}

        {/* Camera preview tile (pre-join) */}
        <div className="px-5 mb-3">
          <div className="rounded-xl bg-surface-base overflow-hidden relative aspect-video">
            <video
              ref={previewVideoRef}
              muted
              playsInline
              autoPlay
              className={`w-full h-full object-cover ${previewActive && !previewError ? '' : 'invisible'}`}
              style={{ transform: 'scaleX(-1)' }}
            />

            {/* Dormant / prompt state — tap to enable */}
            {!previewActive && !previewError && permState !== 'denied' && (
              <button
                type="button"
                onClick={startPreviewFromUser}
                className="absolute inset-0 flex flex-col items-center justify-center text-txt-tertiary active:bg-white/[0.03] transition-colors"
                aria-label="Enable camera preview"
              >
                <svg width="32" height="32" viewBox="0 0 24 24" fill="currentColor" className="mb-1.5">
                  <path d="M17 10.5V7a1 1 0 00-1-1H4a1 1 0 00-1 1v10a1 1 0 001 1h12a1 1 0 001-1v-3.5l4 4v-11l-4 4z" />
                </svg>
                <span className="text-xs">
                  {permState === 'unknown' ? 'Checking camera…' : 'Tap to preview camera'}
                </span>
              </button>
            )}

            {/* Denied state */}
            {!previewActive && !previewError && permState === 'denied' && (
              <div className="absolute inset-0 flex flex-col items-center justify-center text-txt-tertiary px-6 text-center gap-2">
                <span className="text-xs">Camera permission denied.</span>
                <button
                  type="button"
                  onClick={startPreviewFromUser}
                  className="text-[11px] px-3 py-1.5 rounded-md bg-surface-elevated text-txt-secondary"
                >
                  Try again
                </button>
              </div>
            )}

            {/* Error state */}
            {previewError && (
              <div className="absolute inset-0 flex flex-col items-center justify-center text-txt-tertiary px-6 text-center gap-2 bg-surface-base/90">
                <span className="text-xs">{previewError}</span>
                <button
                  type="button"
                  onClick={startPreviewFromUser}
                  className="text-[11px] px-3 py-1.5 rounded-md bg-surface-elevated text-txt-secondary"
                >
                  Try again
                </button>
              </div>
            )}

            {/* Stop preview pill — visible while running */}
            {previewActive && !previewError && (
              <button
                type="button"
                onClick={stopPreviewFromUser}
                className="absolute top-2 right-2 rounded-md bg-black/60 text-white/90 text-[11px] px-2.5 py-1.5"
              >
                Stop preview
              </button>
            )}

            {/* Camera picker — only when permission granted AND multiple cameras.
                The trigger sits inside the `aspect-video overflow-hidden` tile;
                the popup portals to document.body so it can extend above the
                tile when the device list is long. */}
            {showCameraPicker && (
              <div ref={pickerAnchorRef} className="absolute bottom-2 left-2">
                <button
                  type="button"
                  onClick={() => setPickerOpen((v) => !v)}
                  className="rounded-md bg-black/60 text-white/90 text-[11px] px-2.5 py-1.5 flex items-center gap-1 max-w-[160px]"
                >
                  <span className="truncate">{selectedCameraLabel}</span>
                  <svg width="10" height="10" viewBox="0 0 24 24" fill="currentColor" className={`flex-shrink-0 transition-transform ${pickerOpen ? 'rotate-180' : ''}`}>
                    <path d="M7 10l5 5 5-5z" />
                  </svg>
                </button>
              </div>
            )}
          </div>
        </div>

        {/* User list */}
        {userCount > 0 && (
          <div className="max-h-40 overflow-y-auto px-5 mb-4">
            <div className="space-y-1">
              {userIds.map((userId) => {
                const member = members.find((m) => m.userId === userId);
                const displayName =
                  member?.user.displayName ?? member?.user.username ?? userId;
                const avatar = member?.user.avatar ?? null;
                const avatarColor = member?.user.avatarColor;
                const wsStatus = voiceUserStates.get(userId);
                const isMuted = wsStatus?.isMuted ?? false;
                const isDeafened = wsStatus?.isDeafened ?? false;
                const isCameraOn = wsStatus?.isCameraOn ?? false;
                const isScreenSharing = wsStatus?.isScreenSharing ?? false;
                const isSpaceMuted = spaceMutedUserIds.has(`${spaceId}:${userId}`);
                const isSpaceDeafened = spaceDeafenedUserIds.has(`${spaceId}:${userId}`);
                const isPermMuted = permissionMutedUserIds.has(`${spaceId}:${userId}`);

                return (
                  <div key={userId} className="py-1.5 rounded-lg">
                    <VoiceUserRow
                      userId={member?.user.homeUserId ?? userId}
                      displayName={displayName}
                      avatar={avatar}
                      avatarColor={avatarColor ?? undefined}
                      isMuted={isMuted}
                      isDeafened={isDeafened}
                      isCameraOn={isCameraOn}
                      isScreenSharing={isScreenSharing}
                      isServerMuted={isSpaceMuted}
                      isServerDeafened={isSpaceDeafened}
                      isPermissionMuted={isPermMuted}
                      isSpeaking={speakingUserIds.has(userId)}
                    />
                  </div>
                );
              })}
            </div>
          </div>
        )}

        {/* Empty state */}
        {userCount === 0 && (
          <div className="px-5 mb-4 py-3 text-center">
            <p className="text-sm text-txt-tertiary">No one is in this channel yet.</p>
            <p className="text-xs text-txt-tertiary/60 mt-1">Be the first to join!</p>
          </div>
        )}

        {/* Bottom action bar */}
        <div className="flex items-center justify-between px-6 py-4">
          {/* Mic toggle */}
          <button
            onClick={() => setPreMuted(!preMuted)}
            className="w-12 h-12 bg-surface-elevated rounded-full flex items-center justify-center text-txt-secondary active:scale-95 transition-transform"
            aria-label={preMuted ? 'Unmute microphone' : 'Mute microphone'}
          >
            {preMuted ? (
              /* Mic off icon */
              <svg width="22" height="22" viewBox="0 0 24 24" fill="currentColor" className="text-txt-danger">
                <path d="M12 14c1.66 0 3-1.34 3-3V5c0-1.66-1.34-3-3-3S9 3.34 9 5v6c0 1.66 1.34 3 3 3z" />
                <path d="M17 11c0 2.76-2.24 5-5 5s-5-2.24-5-5H5c0 3.53 2.61 6.43 6 6.92V21h2v-3.08c3.39-.49 6-3.39 6-6.92h-2z" />
                <line x1="3" y1="3" x2="21" y2="21" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" />
              </svg>
            ) : (
              /* Mic on icon */
              <svg width="22" height="22" viewBox="0 0 24 24" fill="currentColor" className="text-txt-primary">
                <path d="M12 14c1.66 0 3-1.34 3-3V5c0-1.66-1.34-3-3-3S9 3.34 9 5v6c0 1.66 1.34 3 3 3z" />
                <path d="M17 11c0 2.76-2.24 5-5 5s-5-2.24-5-5H5c0 3.53 2.61 6.43 6 6.92V21h2v-3.08c3.39-.49 6-3.39 6-6.92h-2z" />
              </svg>
            )}
          </button>

          {/* Join Voice button */}
          <button
            onClick={handleJoin}
            className="bg-accent-mint text-black font-semibold rounded-full px-8 py-3 active:scale-95 transition-transform"
          >
            {isSwitching ? 'Switch Channel' : 'Join Voice'}
          </button>

          {/* Close button */}
          <button
            onClick={onClose}
            className="w-12 h-12 bg-surface-elevated rounded-full flex items-center justify-center text-txt-secondary active:scale-95 transition-transform"
            aria-label="Close"
          >
            <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round">
              <path d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>
      </div>

      {/* Camera picker popup — portaled to document.body so it escapes the
          sheet's `aspect-video overflow-hidden` tile. Anchored to the trigger
          button via getBoundingClientRect (captured in the open effect above).
          `max-h` + `overflow-y-auto` + iOS scroll momentum keeps the list
          reachable even with many cameras; using `bottom` (not `top`) makes
          the popup expand upward from the anchor. */}
      {showCameraPicker && pickerOpen && pickerPopupRect && (
        <div
          ref={pickerPopupRef}
          className="fixed z-[60] rounded-md bg-surface-elevated border border-border-hard py-1 shadow-lg overflow-y-auto"
          style={{
            left: pickerPopupRect.left,
            bottom: pickerPopupRect.bottom,
            minWidth: 160,
            maxWidth: 240,
            // Cap to leave room above the safe area / sheet header. Combined with
            // overflow-y-auto this guarantees every entry stays reachable
            // regardless of device count.
            maxHeight: 'min(50vh, 320px)',
            // iOS Safari scroll momentum
            WebkitOverflowScrolling: 'touch',
          }}
        >
          <button
            type="button"
            onClick={() => {
              setCameraDeviceId(null);
              setPickerOpen(false);
            }}
            className={`w-full text-left px-3 py-2 text-[12px] truncate ${
              cameraDeviceId === null ? 'text-txt-primary' : 'text-txt-secondary'
            } active:bg-interactive-hover`}
          >
            Auto (system default)
          </button>
          {cameraDevices.map((d, i) => (
            <button
              key={d.deviceId}
              type="button"
              onClick={() => {
                setCameraDeviceId(d.deviceId);
                setPickerOpen(false);
              }}
              className={`w-full text-left px-3 py-2 text-[12px] truncate ${
                cameraDeviceId === d.deviceId ? 'text-txt-primary' : 'text-txt-secondary'
              } active:bg-interactive-hover`}
            >
              {d.label || `Camera ${i + 1}`}
            </button>
          ))}
        </div>
      )}
    </>,
    document.body,
  );
}
