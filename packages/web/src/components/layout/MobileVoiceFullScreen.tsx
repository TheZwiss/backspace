import React, { useEffect, useMemo, useRef, useState, useCallback } from 'react';
import { createPortal } from 'react-dom';
import { useUIStore } from '../../stores/uiStore';
import { useVoiceStore } from '../../stores/voiceStore';
import { useSpaceStore } from '../../stores/spaceStore';
import { useAuthStore } from '../../stores/authStore';
import { wsSend } from '../../hooks/useWebSocket';
import { getChannelOrigin } from '../../stores/spaceStore';
import {
  handleCameraAction,
  handleScreenShareAction,
} from '../../utils/voiceActions';
import { VoiceGrid } from '../voice/VoiceGrid';
import { deriveGridTiles } from '../../hooks/useLiveKit';
import { requestMicPermission } from '../../utils/voice';

/**
 * Full-screen mobile voice/video call view.
 *
 * Renders the same `VoiceGrid` as desktop so cameras and screen-share tracks
 * subscribe + attach via the canonical `Track.attach()` pipeline. The grid
 * supports tap-to-focus (single tile takes the bulk of the viewport, others
 * collapse into a bottom strip) — feature parity with desktop's focused mode.
 *
 * Auto-focus on screen-share: when the user is not already focused on a
 * specific tile, the first available screen-share tile is auto-focused so
 * mobile users don't need to discover the tap-to-focus affordance to watch a
 * stream. Auto-focus is mobile-only behaviour; desktop preserves its
 * "render-everything-then-let-the-user-pick" pattern.
 */
export function MobileVoiceFullScreen() {
  const popMobileScreen = useUIStore((s) => s.popMobileScreen);
  const pushMobileScreen = useUIStore((s) => s.pushMobileScreen);

  const currentVoiceChannelId = useVoiceStore((s) => s.currentVoiceChannelId);
  const isMuted = useVoiceStore((s) => s.isMuted);
  const isDeafened = useVoiceStore((s) => s.isDeafened);
  const isCameraOn = useVoiceStore((s) => s.isCameraOn);
  const isScreenSharing = useVoiceStore((s) => s.isScreenSharing);
  const toggleMute = useVoiceStore((s) => s.toggleMic);
  const toggleDeafen = useVoiceStore((s) => s.toggleDeafen);
  const leaveVoice = useVoiceStore((s) => s.leaveVoice);
  const participants = useVoiceStore((s) => s.participants);
  const focusedParticipantId = useVoiceStore((s) => s.focusedParticipantId);
  const setFocusedParticipant = useVoiceStore((s) => s.setFocusedParticipant);

  const channels = useSpaceStore((s) => s.channels);
  const dmChannels = useSpaceStore((s) => s.dmChannels);
  const spaces = useSpaceStore((s) => s.spaces);
  const channelToSpaceMap = useSpaceStore((s) => s.channelToSpaceMap);

  const authUser = useAuthStore((s) => s.user);

  const cameraDeviceId = useVoiceStore((s) => s.cameraDeviceId);
  const setCameraDeviceId = useVoiceStore((s) => s.setCameraDeviceId);
  const micPermissionDenied = useVoiceStore((s) => s.micPermissionDenied);

  // ── In-call camera switcher ───────────────────────────────────────────────
  // On mobile, users typically have a front+back camera and need to flip
  // mid-call. Desktop exposes per-device selection in user settings, but
  // navigating away from the call screen mid-call breaks the flow.
  //
  // Mechanism: `setCameraDeviceId(deviceId)` writes to voiceStore; the
  // canonical `useLiveKit syncCamera` effect picks that up and calls
  // `room.switchActiveDevice('videoinput', target)` for an in-place hot-swap
  // (no republish). This is the same flow desktop's settings panel uses —
  // see docs/systems/voice.md "Hot-swap mid-call".
  const [cameraDevices, setCameraDevices] = useState<MediaDeviceInfo[]>([]);
  const [cameraPickerOpen, setCameraPickerOpen] = useState(false);
  const cameraPickerAnchorRef = useRef<HTMLDivElement>(null);
  const cameraPickerPopupRef = useRef<HTMLDivElement>(null);
  const [cameraPickerRect, setCameraPickerRect] = useState<{ left: number; bottom: number } | null>(null);

  // Enumerate available video inputs. Pure passive — `enumerateDevices`
  // does NOT light the camera LED. Labels are populated only after an
  // active camera grant; before that they fall back to "Camera N".
  // We re-enumerate on every `devicechange` (e.g. AirPods connect, USB
  // camera plugged in).
  useEffect(() => {
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
    const onChange = () => enumerate();
    navigator.mediaDevices.addEventListener('devicechange', onChange);
    return () => {
      cancelled = true;
      navigator.mediaDevices.removeEventListener('devicechange', onChange);
    };
  }, []);

  // Click-outside to close the picker. Listens to mousedown AND touchstart
  // because iOS Safari does not synthesize mousedown reliably from a single
  // tap (same pattern as MobileVoiceJoinSheet's picker).
  useEffect(() => {
    if (!cameraPickerOpen) return;
    const onPointerDown = (e: MouseEvent | TouchEvent) => {
      const target = e.target as Node;
      const inAnchor = cameraPickerAnchorRef.current?.contains(target) ?? false;
      const inPopup = cameraPickerPopupRef.current?.contains(target) ?? false;
      if (!inAnchor && !inPopup) setCameraPickerOpen(false);
    };
    document.addEventListener('mousedown', onPointerDown);
    document.addEventListener('touchstart', onPointerDown, { passive: true });
    return () => {
      document.removeEventListener('mousedown', onPointerDown);
      document.removeEventListener('touchstart', onPointerDown);
    };
  }, [cameraPickerOpen]);

  // Pin the popup to the anchor's screen rect on open, reposition on
  // resize/scroll. Using `bottom` makes the popup expand upward from the
  // chevron — natural for a control bar at the screen bottom.
  useEffect(() => {
    if (!cameraPickerOpen) {
      setCameraPickerRect(null);
      return;
    }
    const anchorBtn = cameraPickerAnchorRef.current?.querySelector('button');
    if (!anchorBtn) return;
    const update = () => {
      const r = anchorBtn.getBoundingClientRect();
      setCameraPickerRect({
        left: r.left,
        bottom: window.innerHeight - r.top + 6,
      });
    };
    update();
    window.addEventListener('resize', update);
    window.addEventListener('scroll', update, true);
    return () => {
      window.removeEventListener('resize', update);
      window.removeEventListener('scroll', update, true);
    };
  }, [cameraPickerOpen]);

  // Close the picker if the camera turns off (the trigger is hidden anyway,
  // but stale popup state would briefly flash if the camera toggles off
  // between renders).
  useEffect(() => {
    if (!isCameraOn && cameraPickerOpen) setCameraPickerOpen(false);
  }, [isCameraOn, cameraPickerOpen]);

  const handlePickCamera = useCallback(
    (deviceId: string | null) => {
      setCameraDeviceId(deviceId);
      setCameraPickerOpen(false);
    },
    [setCameraDeviceId],
  );

  const showCameraSwitcher = isCameraOn && cameraDevices.length > 1;

  // Track whether the user has explicitly chosen focus (manual tap) vs.
  // auto-focus we set on screen-share publish. Once the user manually
  // focuses or unfocuses anything during this screen's lifetime, we stop
  // auto-focusing.
  const userTouchedFocusRef = useRef(false);
  const lastAutoFocusedKeyRef = useRef<string | null>(null);

  // Pre-compute tiles for screen-share auto-focus detection. Cheap (same
  // derivation VoiceGrid runs).
  const tiles = useMemo(() => deriveGridTiles(participants), [participants]);

  // Auto-focus screen-share on mobile.
  // - Trigger only when the user has not manually changed focus during this
  //   screen lifetime AND the current focus is either null or a stale tile
  //   that no longer exists.
  // - Picks the first live screen-share tile.
  useEffect(() => {
    if (userTouchedFocusRef.current) return;

    const liveStreamTiles = tiles.filter(
      (t) => t.kind === 'stream' && t.screenTrack?.readyState === 'live',
    );
    if (liveStreamTiles.length === 0) return;

    const firstStreamKey = liveStreamTiles[0]?.key;
    if (!firstStreamKey) return;

    // Already focused on this stream — nothing to do.
    if (focusedParticipantId === firstStreamKey) {
      lastAutoFocusedKeyRef.current = firstStreamKey;
      return;
    }

    // Don't override an existing manual focus on a still-valid tile. The
    // VoiceGrid effect already clears focus when the focused tile vanishes,
    // so reaching here with a non-null focusedParticipantId means the user
    // is intentionally focused on something else (cleared by us only if it
    // matches the previous auto-focus).
    if (
      focusedParticipantId &&
      focusedParticipantId !== lastAutoFocusedKeyRef.current
    ) {
      return;
    }

    setFocusedParticipant(firstStreamKey);
    lastAutoFocusedKeyRef.current = firstStreamKey;
  }, [tiles, focusedParticipantId, setFocusedParticipant]);

  // Wrap setFocusedParticipant so we can flag user-initiated focus changes.
  // Replace the store action *transparently* via a subscription is fragile;
  // instead we wrap by intercepting through a custom click layer below. The
  // VoiceGrid uses the store's setFocusedParticipant directly for clicks —
  // we can't override that without forking VoiceGrid. Workaround: mark the
  // flag whenever focusedParticipantId changes to a value other than what
  // we auto-focused.
  useEffect(() => {
    if (focusedParticipantId === null) {
      // User dismissed focus (or VoiceGrid cleared it on stale). Either way,
      // the user has now interacted; do not re-auto-focus the same stream.
      if (lastAutoFocusedKeyRef.current !== null) {
        userTouchedFocusRef.current = true;
      }
    } else if (focusedParticipantId !== lastAutoFocusedKeyRef.current) {
      // User picked a different tile — manual interaction.
      userTouchedFocusRef.current = true;
    }
  }, [focusedParticipantId]);

  // Reset focus state when leaving the screen / call.
  useEffect(() => {
    return () => {
      // On unmount, clear focus so re-entering is a clean slate.
      useVoiceStore.getState().setFocusedParticipant(null);
    };
  }, []);

  if (!currentVoiceChannelId) {
    popMobileScreen();
    return null;
  }

  const isDmCall = currentVoiceChannelId.startsWith('dm-');
  let channelName = 'Voice Call';
  let spaceName = '';

  if (isDmCall) {
    const dmId = currentVoiceChannelId.replace('dm-', '');
    const dm = dmChannels.find((d) => d.id === dmId);
    if (dm) {
      const others = dm.members.filter((m) => m.id !== authUser?.id);
      channelName = others.map((m) => m.displayName ?? m.username).join(', ');
    }
  } else {
    const ch = channels.find((c) => c.id === currentVoiceChannelId);
    if (ch) {
      channelName = ch.name;
      const spaceId = channelToSpaceMap.get(ch.id);
      const space = spaceId ? spaces.find((s) => s.id === spaceId) : null;
      if (space) spaceName = space.name;
    }
  }

  const handleDisconnect = () => {
    const { activeDmCall, disconnectFn, federatedCallId, callOrigin } =
      useVoiceStore.getState();
    if (activeDmCall) {
      const origin = callOrigin || getChannelOrigin(activeDmCall.dmChannelId);
      wsSend(
        {
          type: 'dm_call_end',
          dmChannelId: activeDmCall.dmChannelId,
          federatedCallId,
        },
        origin,
      );
      useVoiceStore.getState().setActiveDmCall(null);
    } else if (currentVoiceChannelId) {
      wsSend({ type: 'voice_leave' }, getChannelOrigin(currentVoiceChannelId));
      leaveVoice();
    }
    if (disconnectFn) disconnectFn();
    popMobileScreen();
  };

  return (
    <div className="flex flex-col h-full bg-surface-base">
      {/* Header */}
      <header className="h-12 flex items-center gap-2 px-3 border-b border-border-soft shrink-0">
        <button
          onClick={popMobileScreen}
          className="w-8 h-8 flex items-center justify-center text-txt-secondary hover:text-txt-primary"
          aria-label="Collapse call"
        >
          <svg
            className="w-5 h-5"
            fill="none"
            viewBox="0 0 24 24"
            stroke="currentColor"
            strokeWidth={2}
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              d="M19.5 8.25l-7.5 7.5-7.5-7.5"
            />
          </svg>
        </button>
        <div className="flex-1 min-w-0">
          <h1 className="text-sm font-semibold text-txt-primary truncate">
            {channelName}
          </h1>
          {spaceName && (
            <p className="text-[11px] text-txt-tertiary truncate">{spaceName}</p>
          )}
        </div>
        <span className="text-xs text-txt-tertiary">
          {participants.length} connected
        </span>
        {!isDmCall && (
          <button
            onClick={() => pushMobileScreen('members')}
            className="w-8 h-8 flex items-center justify-center text-txt-secondary hover:text-txt-primary"
            aria-label="View members"
          >
            <svg
              className="w-5 h-5"
              fill="none"
              viewBox="0 0 24 24"
              stroke="currentColor"
              strokeWidth={1.5}
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                d="M15 19.128a9.38 9.38 0 002.625.372 9.337 9.337 0 004.121-.952 4.125 4.125 0 00-7.533-2.493M15 19.128v-.003c0-1.113-.285-2.16-.786-3.07M15 19.128v.106A12.318 12.318 0 018.624 21c-2.331 0-4.512-.645-6.374-1.766l-.001-.109a6.375 6.375 0 0111.964-3.07M12 6.375a3.375 3.375 0 11-6.75 0 3.375 3.375 0 016.75 0zm8.25 2.25a2.625 2.625 0 11-5.25 0 2.625 2.625 0 015.25 0z"
              />
            </svg>
          </button>
        )}
      </header>

      {/* Mic-permission denial banner. Surfaces only when the user joined
          voice without granting microphone access (most common on iOS PWA
          where the permission prompt missed its user-gesture window, and
          the user denied or dismissed). The retry button is the second
          user-gesture entry-point — it calls `getUserMedia` synchronously
          inside the click handler so iOS surfaces the prompt cleanly. On
          success the flag clears and `useLiveKit syncMic` re-fires to
          publish the freshly acquired mic track. */}
      {micPermissionDenied && (
        <div className="mx-2 mt-2 px-3 py-2.5 rounded-lg bg-accent-amber/10 border border-accent-amber/30 flex items-center gap-3 shrink-0">
          <svg
            className="w-5 h-5 text-accent-amber shrink-0"
            fill="none"
            viewBox="0 0 24 24"
            stroke="currentColor"
            strokeWidth={1.75}
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              d="M12 18.75a6 6 0 006-6v-1.5m-6 7.5a6 6 0 01-6-6v-1.5m6 7.5v3.75m-3.75 0h7.5M3 3l18 18"
            />
          </svg>
          <div className="flex-1 min-w-0">
            <p className="text-[12px] font-medium text-accent-amber">
              Microphone access denied
            </p>
            <p className="text-[11px] text-txt-tertiary leading-tight mt-0.5">
              You're listening only — others can't hear you.
            </p>
          </div>
          <button
            type="button"
            onClick={() => {
              void requestMicPermission();
            }}
            className="text-[11px] font-medium px-3 py-1.5 rounded-md bg-accent-amber/20 text-accent-amber hover:bg-accent-amber/30 transition-colors shrink-0"
          >
            Allow microphone
          </button>
        </div>
      )}

      {/* Participant grid — VoiceGrid handles attach/detach, tap-to-focus,
          screen-share tiles, mute overlays, context menus. Identical
          rendering pipeline to desktop. */}
      <div className="flex-1 flex flex-col min-h-0 overflow-hidden">
        <VoiceGrid participants={participants} />
      </div>

      {/* Control bar */}
      <div
        className="glass-bubble mx-2 mb-2 rounded-2xl flex items-center justify-center gap-4 px-4 py-3 shrink-0"
        style={{ marginBottom: 'calc(0.5rem + env(safe-area-inset-bottom))' }}
      >
        {/* Mute */}
        <button
          onClick={toggleMute}
          className={`w-12 h-12 rounded-full flex items-center justify-center transition-colors ${
            isMuted
              ? 'bg-accent-rose/20 text-accent-rose'
              : 'bg-surface-elevated text-txt-primary hover:bg-interactive-hover'
          }`}
          aria-label={isMuted ? 'Unmute' : 'Mute'}
        >
          <svg
            className="w-5 h-5"
            fill="none"
            viewBox="0 0 24 24"
            stroke="currentColor"
            strokeWidth={1.5}
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              d="M12 18.75a6 6 0 006-6v-1.5m-6 7.5a6 6 0 01-6-6v-1.5m6 7.5v3.75m-3.75 0h7.5M12 15.75a3 3 0 01-3-3V4.5a3 3 0 116 0v8.25a3 3 0 01-3 3z"
            />
            {isMuted && (
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                d="M3 3l18 18"
              />
            )}
          </svg>
        </button>

        {/* Deafen */}
        <button
          onClick={toggleDeafen}
          className={`w-12 h-12 rounded-full flex items-center justify-center transition-colors ${
            isDeafened
              ? 'bg-accent-rose/20 text-accent-rose'
              : 'bg-surface-elevated text-txt-primary hover:bg-interactive-hover'
          }`}
          aria-label={isDeafened ? 'Undeafen' : 'Deafen'}
        >
          <svg
            className="w-5 h-5"
            fill="none"
            viewBox="0 0 24 24"
            stroke="currentColor"
            strokeWidth={1.5}
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              d="M19.114 5.636a9 9 0 010 12.728M16.463 8.288a5.25 5.25 0 010 7.424M6.75 8.25l4.72-4.72a.75.75 0 011.28.53v15.88a.75.75 0 01-1.28.53l-4.72-4.72H4.51c-.88 0-1.704-.507-1.938-1.354A9.01 9.01 0 012.25 12c0-.83.112-1.633.322-2.396C2.806 8.756 3.63 8.25 4.51 8.25H6.75z"
            />
            {isDeafened && (
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                d="M3 3l18 18"
              />
            )}
          </svg>
        </button>

        {/* Camera (with in-call switcher chevron when multiple cameras exist
            and the camera is currently on). The chevron sits in a small
            attached pill above the bottom-right corner of the camera button —
            visible only when relevant so single-camera devices are unaffected. */}
        <div className="relative" ref={cameraPickerAnchorRef}>
          <button
            onClick={handleCameraAction}
            className={`w-12 h-12 rounded-full flex items-center justify-center transition-colors ${
              isCameraOn
                ? 'bg-accent-mint/20 text-accent-mint'
                : 'bg-surface-elevated text-txt-primary hover:bg-interactive-hover'
            }`}
            aria-label={isCameraOn ? 'Turn camera off' : 'Turn camera on'}
          >
            <svg
              className="w-5 h-5"
              fill="none"
              viewBox="0 0 24 24"
              stroke="currentColor"
              strokeWidth={1.5}
            >
              <path
                strokeLinecap="round"
                d="M15.75 10.5l4.72-4.72a.75.75 0 011.28.53v11.38a.75.75 0 01-1.28.53l-4.72-4.72M4.5 18.75h9.75a2.25 2.25 0 002.25-2.25V7.5a2.25 2.25 0 00-2.25-2.25H4.5A2.25 2.25 0 002.25 7.5v9A2.25 2.25 0 004.5 18.75z"
              />
            </svg>
          </button>
          {showCameraSwitcher && (
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                setCameraPickerOpen((v) => !v);
              }}
              aria-label="Switch camera"
              aria-haspopup="menu"
              aria-expanded={cameraPickerOpen}
              className="absolute -top-1 -right-1 w-6 h-6 rounded-full bg-surface-elevated text-txt-primary flex items-center justify-center shadow-md border border-border-soft active:scale-95 transition-transform"
            >
              <svg
                width="14"
                height="14"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth={2}
              >
                {/* Camera-flip icon: arrows around a camera */}
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  d="M4 7h3l1.5-2h7L17 7h3v12H4V7z"
                />
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  d="M9 13a3 3 0 003 3m3-3a3 3 0 00-3-3M9 13l-1.5-1.5M9 13l1.5-1.5M15 13l1.5 1.5M15 13l-1.5 1.5"
                />
              </svg>
            </button>
          )}
        </div>

        {/* Screen share — uses canonical handleScreenShareAction so the
            getDisplayMedia call actually fires (and propagates errors via
            voiceActions). The previous voiceStore.toggleScreenShare flipped
            only the boolean and never started capture. */}
        <button
          onClick={handleScreenShareAction}
          className={`w-12 h-12 rounded-full flex items-center justify-center transition-colors ${
            isScreenSharing
              ? 'bg-accent-mint/20 text-accent-mint'
              : 'bg-surface-elevated text-txt-primary hover:bg-interactive-hover'
          }`}
          aria-label={
            isScreenSharing ? 'Stop sharing screen' : 'Share screen'
          }
        >
          <svg
            className="w-5 h-5"
            fill="none"
            viewBox="0 0 24 24"
            stroke="currentColor"
            strokeWidth={1.5}
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              d="M9 17.25v1.007a3 3 0 01-.879 2.122L7.5 21h9l-.621-.621A3 3 0 0115 18.257V17.25m6-12V15a2.25 2.25 0 01-2.25 2.25H5.25A2.25 2.25 0 013 15V5.25m18 0A2.25 2.25 0 0018.75 3H5.25A2.25 2.25 0 003 5.25m18 0V12a9 9 0 01-9 9m0 0a9 9 0 01-9-9"
            />
          </svg>
        </button>

        {/* Disconnect */}
        <button
          onClick={handleDisconnect}
          className="w-12 h-12 rounded-full bg-accent-rose flex items-center justify-center text-white hover:bg-accent-rose/80 transition-colors"
          aria-label="Disconnect from call"
        >
          <svg
            className="w-5 h-5"
            fill="none"
            viewBox="0 0 24 24"
            stroke="currentColor"
            strokeWidth={2}
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              d="M15.75 9V5.25A2.25 2.25 0 0013.5 3h-6a2.25 2.25 0 00-2.25 2.25v13.5A2.25 2.25 0 007.5 21h6a2.25 2.25 0 002.25-2.25V15m3 0l3-3m0 0l-3-3m3 3H9"
            />
          </svg>
        </button>
      </div>

      {/* Camera picker popup — portaled to document.body so the upward
          expansion isn't clipped by the control bar's glass-bubble.
          Anchored to the chevron via getBoundingClientRect (recomputed on
          resize / scroll). max-height + overflow-y-auto + iOS scroll
          momentum keep every entry reachable on devices with many cameras. */}
      {showCameraSwitcher &&
        cameraPickerOpen &&
        cameraPickerRect &&
        createPortal(
          <div
            ref={cameraPickerPopupRef}
            role="menu"
            aria-label="Select camera"
            className="fixed z-[60] rounded-md bg-surface-elevated border border-border-hard py-1 shadow-lg overflow-y-auto"
            style={{
              left: cameraPickerRect.left,
              bottom: cameraPickerRect.bottom,
              minWidth: 180,
              maxWidth: 260,
              maxHeight: 'min(50vh, 320px)',
              WebkitOverflowScrolling: 'touch',
            }}
          >
            <button
              type="button"
              role="menuitemradio"
              aria-checked={cameraDeviceId === null}
              onClick={() => handlePickCamera(null)}
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
                role="menuitemradio"
                aria-checked={cameraDeviceId === d.deviceId}
                onClick={() => handlePickCamera(d.deviceId)}
                className={`w-full text-left px-3 py-2 text-[12px] truncate ${
                  cameraDeviceId === d.deviceId ? 'text-txt-primary' : 'text-txt-secondary'
                } active:bg-interactive-hover`}
              >
                {d.label || `Camera ${i + 1}`}
              </button>
            ))}
          </div>,
          document.body,
        )}
    </div>
  );
}
