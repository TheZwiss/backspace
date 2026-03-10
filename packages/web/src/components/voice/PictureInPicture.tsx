import React, { useRef, useEffect, useState, useCallback, useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import { useVoiceStore } from '../../stores/voiceStore';
import { useChatStore } from '../../stores/chatStore';
import { useUIStore } from '../../stores/uiStore';
import { useSpaceStore } from '../../stores/spaceStore';
import { Avatar } from '../ui/Avatar';
import type { ParticipantInfo } from '../../hooks/useLiveKit';
import { useVoiceParticipantMeta } from '../../hooks/useVoiceParticipantMeta';

/** Stable fallback for useVoiceParticipantMeta when no participant exists */
const EMPTY_PARTICIPANT: ParticipantInfo = {
  identity: '', userId: '', username: '', homeUserId: null,
  isMuted: false, isDeafened: false, isCameraOn: false, isScreenSharing: false,
  isLocal: false, audioTrack: null, videoTrack: null, screenTrack: null,
  screenAudioTrack: null, lkVideoTrack: null, lkScreenTrack: null,
};

const PIP_WIDTH = 320;
const PIP_HEIGHT = 180;
const PIP_MARGIN = 16;
const DRAG_THRESHOLD = 5;

/**
 * Computes PiP boundary box by measuring actual DOM obstacles.
 * Obstacle elements declare themselves with data-pip-obstacle="left"|"bottom".
 * PiP queries them at boundary-check time — no hardcoded layout values.
 *
 * On mobile (<768px) there are no fixed side/bottom UI obstacles.
 */
function getPipBounds(pipX: number): {
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
} {
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  let minX = PIP_MARGIN;
  const maxX = vw - PIP_WIDTH - PIP_MARGIN;
  const minY = PIP_MARGIN;
  let maxY = vh - PIP_HEIGHT - PIP_MARGIN;

  if (vw < 768) return { minX, maxX, minY, maxY };

  const obstacles = document.querySelectorAll<HTMLElement>('[data-pip-obstacle]');
  for (const el of obstacles) {
    const rect = el.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) continue;

    const direction = el.dataset.pipObstacle;
    if (direction === 'left') {
      minX = Math.max(minX, rect.right + PIP_MARGIN);
    } else if (direction === 'bottom') {
      const pipRight = pipX + PIP_WIDTH;
      if (pipX < rect.right && pipRight > rect.left) {
        maxY = Math.min(maxY, rect.top - PIP_HEIGHT - PIP_MARGIN);
      }
    }
  }

  return { minX, maxX, minY, maxY };
}

interface SelectedStream {
  participant: ParticipantInfo;
  track: MediaStreamTrack;
  type: 'screen' | 'camera';
}

function selectPipStream(
  participants: ParticipantInfo[],
  focusedId: string | null,
  watchingStreams: Set<string>,
): SelectedStream | null {
  // Priority 1: Screen share from a user we're watching
  const screenSharer = participants.find(
    p => p.screenTrack !== null && watchingStreams.has(p.userId),
  );
  if (screenSharer?.screenTrack) {
    return { participant: screenSharer, track: screenSharer.screenTrack, type: 'screen' };
  }

  // Priority 2: Focused participant with camera
  if (focusedId) {
    const focused = participants.find(p => p.identity === focusedId);
    if (focused?.videoTrack) {
      return { participant: focused, track: focused.videoTrack, type: 'camera' };
    }
  }

  // Priority 3: Remote participant with camera
  const remoteWithCamera = participants.find(p => !p.isLocal && p.videoTrack !== null);
  if (remoteWithCamera?.videoTrack) {
    return { participant: remoteWithCamera, track: remoteWithCamera.videoTrack, type: 'camera' };
  }

  // Priority 4: Local participant with camera
  const localWithCamera = participants.find(p => p.isLocal && p.videoTrack !== null);
  if (localWithCamera?.videoTrack) {
    return { participant: localWithCamera, track: localWithCamera.videoTrack, type: 'camera' };
  }

  return null;
}

export function PictureInPicture() {
  const navigate = useNavigate();
  const videoRef = useRef<HTMLVideoElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  // Store state
  const currentVoiceChannelId = useVoiceStore((s) => s.currentVoiceChannelId);
  const activeDmCall = useVoiceStore((s) => s.activeDmCall);
  const participants = useVoiceStore((s) => s.participants);
  const focusedParticipantId = useVoiceStore((s) => s.focusedParticipantId);
  const watchingStreams = useVoiceStore((s) => s.watchingStreams);
  const speakingParticipantIds = useVoiceStore((s) => s.speakingParticipantIds);
  const currentChannelId = useChatStore((s) => s.currentChannelId);
  const voiceFullscreen = useUIStore((s) => s.voiceFullscreen);
  const pipCollapsed = useUIStore((s) => s.pipCollapsed);
  const setPipCollapsed = useUIStore((s) => s.setPipCollapsed);
  const channelToSpaceMap = useSpaceStore((s) => s.channelToSpaceMap);
  const channels = useSpaceStore((s) => s.channels);

  // Drag state
  const [position, setPosition] = useState<{ x: number; y: number }>({ x: -1, y: -1 });
  const [isDragging, setIsDragging] = useState(false);
  const dragOffset = useRef({ x: 0, y: 0 });
  const dragStartPos = useRef({ x: 0, y: 0 });
  const hasMoved = useRef(false);

  // Reset pipCollapsed when joining a new call
  const prevVoiceChannel = useRef(currentVoiceChannelId);
  const prevDmCall = useRef(activeDmCall?.dmChannelId ?? null);
  useEffect(() => {
    const voiceChanged = currentVoiceChannelId !== prevVoiceChannel.current;
    const dmChanged = (activeDmCall?.dmChannelId ?? null) !== prevDmCall.current;
    prevVoiceChannel.current = currentVoiceChannelId;
    prevDmCall.current = activeDmCall?.dmChannelId ?? null;
    if ((voiceChanged && currentVoiceChannelId) || (dmChanged && activeDmCall)) {
      setPipCollapsed(false);
    }
  }, [currentVoiceChannelId, activeDmCall, setPipCollapsed]);

  // Visibility — split into wouldShow (ignores collapsed) and shouldShow (full check)
  const isInServerVoice = currentVoiceChannelId !== null && currentChannelId !== currentVoiceChannelId;
  const isInDmCall = activeDmCall !== null && currentChannelId !== activeDmCall.dmChannelId;
  const wouldShow = (isInServerVoice || isInDmCall) && !voiceFullscreen;
  const shouldShow = wouldShow && !pipCollapsed;

  // Reset pipCollapsed when wouldShow transitions false → true
  // (user navigated away from voice channel view → PiP reappears)
  const prevWouldShow = useRef(wouldShow);
  useEffect(() => {
    if (wouldShow && !prevWouldShow.current) {
      setPipCollapsed(false);
    }
    prevWouldShow.current = wouldShow;
  }, [wouldShow, setPipCollapsed]);

  // Stream selection
  const selectedStream = useMemo(
    () => selectPipStream(participants, focusedParticipantId, watchingStreams),
    [participants, focusedParticipantId, watchingStreams],
  );

  // Fallback participant for avatar (most relevant remote, or first participant)
  const fallbackParticipant = useMemo(() => {
    const speaking = participants.find(p => !p.isLocal && speakingParticipantIds.has(p.identity));
    if (speaking) return speaking;
    const remote = participants.find(p => !p.isLocal);
    if (remote) return remote;
    return participants[0] ?? null;
  }, [participants, speakingParticipantIds]);

  // Channel name for display
  const channelName = useMemo(() => {
    if (currentVoiceChannelId) {
      const ch = channels.find(c => c.id === currentVoiceChannelId);
      return ch?.name ?? 'Voice';
    }
    return 'Call';
  }, [currentVoiceChannelId, channels]);

  // Derive the LiveKit Track from the selected stream's participant
  const lkTrack = selectedStream
    ? (selectedStream.type === 'screen'
        ? selectedStream.participant.lkScreenTrack
        : selectedStream.participant.lkVideoTrack)
    : null;

  // Video track attachment — use LiveKit's track.attach() to register the element
  // with the adaptive stream observer (enables SFU layer switching by viewport size)
  // shouldShow in deps ensures re-run when PiP becomes visible (videoRef was null before)
  useEffect(() => {
    const videoEl = videoRef.current;
    if (!videoEl) return;
    if (lkTrack) {
      lkTrack.attach(videoEl);
      return () => { lkTrack.detach(videoEl); };
    } else {
      videoEl.srcObject = null;
    }
  }, [lkTrack, shouldShow]);

  // Initialize position to bottom-right
  useEffect(() => {
    if (shouldShow && position.x === -1) {
      const initX = window.innerWidth - PIP_WIDTH - PIP_MARGIN;
      const { maxY } = getPipBounds(initX);
      setPosition({ x: initX, y: maxY });
    }
  }, [shouldShow, position.x]);

  // Re-clamp PiP when viewport resizes, obstacles appear/disappear, or obstacles resize
  useEffect(() => {
    if (!shouldShow) return;

    const reclamp = () => {
      setPosition(prev => {
        if (prev.x === -1) return prev;
        const { minX, maxX } = getPipBounds(prev.x);
        const clampedX = Math.max(minX, Math.min(maxX, prev.x));
        const { minY, maxY } = getPipBounds(clampedX);
        return { x: clampedX, y: Math.max(minY, Math.min(maxY, prev.y)) };
      });
    };

    // Observe obstacle elements for size changes (e.g., voice panel expanding)
    let knownObstacles = new Set(document.querySelectorAll<HTMLElement>('[data-pip-obstacle]'));
    const resizeObserver = new ResizeObserver(reclamp);
    knownObstacles.forEach(el => resizeObserver.observe(el));

    // Detect obstacle elements being added/removed from the DOM
    const mutationObserver = new MutationObserver(() => {
      const current = new Set(document.querySelectorAll<HTMLElement>('[data-pip-obstacle]'));
      if (current.size !== knownObstacles.size || ![...current].every(el => knownObstacles.has(el))) {
        resizeObserver.disconnect();
        current.forEach(el => resizeObserver.observe(el));
        knownObstacles = current;
        reclamp();
      }
    });
    mutationObserver.observe(document.body, { childList: true, subtree: true });

    window.addEventListener('resize', reclamp);
    return () => {
      window.removeEventListener('resize', reclamp);
      mutationObserver.disconnect();
      resizeObserver.disconnect();
    };
  }, [shouldShow]);

  // Snap to nearest horizontal edge
  const snapToEdge = useCallback((currentX: number, currentY: number) => {
    const centerX = currentX + PIP_WIDTH / 2;
    const screenMidX = window.innerWidth / 2;
    const { minX } = getPipBounds(currentX);
    const targetX = centerX < screenMidX
      ? minX
      : window.innerWidth - PIP_WIDTH - PIP_MARGIN;
    const { minY, maxY } = getPipBounds(targetX);
    const clampedY = Math.max(minY, Math.min(maxY, currentY));
    setPosition({ x: targetX, y: clampedY });
  }, []);

  // Drag handlers
  const handlePointerDown = useCallback((e: React.PointerEvent) => {
    if ((e.target as HTMLElement).closest('[data-pip-action]')) return;
    setIsDragging(true);
    hasMoved.current = false;
    dragOffset.current = { x: e.clientX - position.x, y: e.clientY - position.y };
    dragStartPos.current = { x: e.clientX, y: e.clientY };
    containerRef.current?.setPointerCapture(e.pointerId);
  }, [position]);

  const handlePointerMove = useCallback((e: React.PointerEvent) => {
    if (!isDragging) return;
    const dx = Math.abs(e.clientX - dragStartPos.current.x);
    const dy = Math.abs(e.clientY - dragStartPos.current.y);
    if (dx > DRAG_THRESHOLD || dy > DRAG_THRESHOLD) {
      hasMoved.current = true;
    }
    const rawX = e.clientX - dragOffset.current.x;
    const bounds = getPipBounds(rawX);
    const newX = Math.max(bounds.minX, Math.min(bounds.maxX, rawX));
    const { minY, maxY } = getPipBounds(newX);
    const newY = Math.max(minY, Math.min(maxY, e.clientY - dragOffset.current.y));
    setPosition({ x: newX, y: newY });
  }, [isDragging]);

  const handlePointerUp = useCallback((e: React.PointerEvent) => {
    if (!isDragging) return;
    setIsDragging(false);
    containerRef.current?.releasePointerCapture(e.pointerId);

    if (!hasMoved.current) {
      // Click — navigate back to voice channel
      if (activeDmCall) {
        navigate(`/channels/@me/${activeDmCall.dmChannelId}`);
      } else if (currentVoiceChannelId) {
        const spaceId = channelToSpaceMap.get(currentVoiceChannelId);
        if (spaceId) {
          navigate(`/channels/${spaceId}/${currentVoiceChannelId}`);
        }
      }
    } else {
      // Drag ended — snap to edge
      snapToEdge(position.x, position.y);
    }
  }, [isDragging, activeDmCall, currentVoiceChannelId, channelToSpaceMap, navigate, snapToEdge, position]);

  const handleClose = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    setPipCollapsed(true);
  }, [setPipCollapsed]);

  // Compute displayParticipant before early return so hook is called unconditionally
  const displayParticipant = useMemo(
    () => selectedStream?.participant ?? fallbackParticipant,
    [selectedStream, fallbackParticipant],
  );

  const { displayName: resolvedName, avatar: resolvedAvatar } =
    useVoiceParticipantMeta(displayParticipant ?? EMPTY_PARTICIPANT);

  if (!shouldShow) return null;

  const displayName = displayParticipant
    ? (displayParticipant.isLocal ? `${resolvedName} (You)` : resolvedName)
    : channelName;
  const hasVideo = selectedStream !== null;
  const isScreen = selectedStream?.type === 'screen';

  return (
    <div
      ref={containerRef}
      className={`fixed z-[40] overflow-hidden rounded-lg shadow-2xl ring-1 ring-white/10 bg-surface-base select-none ${
        isDragging ? 'cursor-grabbing' : 'cursor-grab'
      }`}
      style={{
        width: PIP_WIDTH,
        height: PIP_HEIGHT,
        left: position.x,
        top: position.y,
        transition: isDragging ? 'none' : 'left 0.2s ease, top 0.2s ease',
        touchAction: 'none',
      }}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={handlePointerUp}
    >
      {/* Video or Avatar fallback */}
      {hasVideo ? (
        <video
          ref={videoRef}
          autoPlay
          playsInline
          muted
          className="w-full h-full object-cover"
          style={{ imageRendering: 'auto' }}
        />
      ) : (
        <div className="w-full h-full flex items-center justify-center bg-surface-channel">
          {displayParticipant ? (
            <div className="relative flex">
              <Avatar
                src={resolvedAvatar}
                name={resolvedName}
                size={64}
                userId={displayParticipant.homeUserId ?? displayParticipant.userId}
              />
              {speakingParticipantIds.has(displayParticipant.identity) && (
                <div className="absolute -inset-1 rounded-full ring-2 ring-status-online animate-pulse" />
              )}
            </div>
          ) : (
            <div className="flex items-center gap-2 text-txt-tertiary">
              <svg width="24" height="24" viewBox="0 0 24 24" fill="currentColor">
                <path d="M11 5L6 9H2V15H6L11 19V5ZM15.54 8.46C16.48 9.4 17 10.67 17 12S16.48 14.6 15.54 15.54L14.12 14.12C14.69 13.55 15 12.79 15 12S14.69 10.45 14.12 9.88L15.54 8.46Z" />
              </svg>
              <span className="text-sm font-medium">{channelName}</span>
            </div>
          )}
        </div>
      )}

      {/* LIVE badge */}
      {isScreen && (
        <div className="absolute top-2 left-2 px-1.5 py-0.5 bg-accent-rose rounded text-[11px] font-bold text-white uppercase tracking-wide">
          LIVE
        </div>
      )}

      {/* Close button */}
      <button
        data-pip-action="close"
        onClick={handleClose}
        className="absolute top-2 right-2 w-6 h-6 bg-black/60 hover:bg-black/80 rounded-full flex items-center justify-center text-white/80 hover:text-white transition-colors"
      >
        <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor">
          <path d="M18.4 4L12 10.4L5.6 4L4 5.6L10.4 12L4 18.4L5.6 20L12 13.6L18.4 20L20 18.4L13.6 12L20 5.6L18.4 4Z" />
        </svg>
      </button>

      {/* Bottom overlay with name */}
      <div className="absolute bottom-0 left-0 right-0 px-3 py-2 bg-gradient-to-t from-black/70 to-transparent">
        <div className="flex items-center gap-1.5">
          <span className="text-white text-xs font-semibold truncate">{displayName}</span>
          {displayParticipant && speakingParticipantIds.has(displayParticipant.identity) && (
            <div className="w-2 h-2 rounded-full bg-status-online flex-shrink-0 animate-pulse" />
          )}
        </div>
        <div className="text-white/50 text-[10px] truncate">{channelName}</div>
      </div>

      {/* Expand icon hint (bottom-right) */}
      <div className="absolute bottom-2 right-2 w-5 h-5 flex items-center justify-center text-white/40">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
          <path d="M21 11V3h-8l3.29 3.29-10 10L3 13v8h8l-3.29-3.29 10-10z" />
        </svg>
      </div>
    </div>
  );
}
