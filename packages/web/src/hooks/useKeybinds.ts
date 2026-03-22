import { useEffect, useRef } from 'react';
import { useKeybindStore, Keybind } from '../stores/keybindStore';
import { useVoiceStore } from '../stores/voiceStore';
import { isElectron } from '../platform/platform';
import { handleMuteAction, handleDeafenAction, handleCameraAction, handleScreenShareAction, handleDisconnectAction } from '../utils/voiceActions';
import { broadcastVoiceStatus } from '../utils/voice';
import { getChannelOrigin, getMyUserIdForOrigin, useSpaceStore } from '../stores/spaceStore';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Resolve space-mute/deafen state for the current voice session */
function getSpaceEnforcementState(): { isSpaceMuted: boolean; isSpaceDeafened: boolean } {
  const vs = useVoiceStore.getState();
  const { currentVoiceChannelId, spaceMutedUserIds, spaceDeafenedUserIds } = vs;
  if (!currentVoiceChannelId) return { isSpaceMuted: false, isSpaceDeafened: false };

  const origin = getChannelOrigin(currentVoiceChannelId);
  const myId = getMyUserIdForOrigin(origin);
  const spaceId = useSpaceStore.getState().channelToSpaceMap.get(currentVoiceChannelId);
  const spaceKey = spaceId && myId ? `${spaceId}:${myId}` : '';

  return {
    isSpaceMuted: spaceMutedUserIds.has(spaceKey),
    isSpaceDeafened: spaceDeafenedUserIds.has(spaceKey),
  };
}

/** Dispatch a keybind action to the appropriate voice handler */
function dispatchKeybindAction(actionId: string, pressed: boolean): void {
  const voice = useVoiceStore.getState();
  if (!voice.currentVoiceChannelId) return;

  const { isSpaceMuted, isSpaceDeafened } = getSpaceEnforcementState();

  switch (actionId) {
    case 'toggleMute':
      if (pressed) handleMuteAction(isSpaceMuted, isSpaceDeafened);
      break;
    case 'toggleDeafen':
      if (pressed) handleDeafenAction(isSpaceDeafened);
      break;
    case 'toggleCamera':
      if (pressed) handleCameraAction();
      break;
    case 'toggleScreenShare':
      if (pressed) handleScreenShareAction();
      break;
    case 'disconnect':
      if (pressed) handleDisconnectAction();
      break;
    case 'pushToTalk':
      voice.setMuted(!pressed); // pressed=true → unmute, pressed=false → mute
      broadcastVoiceStatus();
      break;
  }
}

// ---------------------------------------------------------------------------
// Modifier key detection (for web fallback input suppression)
// ---------------------------------------------------------------------------

function isCharacterKey(e: KeyboardEvent): boolean {
  return e.key.length === 1 && !e.ctrlKey && !e.altKey && !e.metaKey;
}

function isInputElement(target: EventTarget | null): boolean {
  if (!target || !(target instanceof HTMLElement)) return false;
  return target instanceof HTMLInputElement
    || target instanceof HTMLTextAreaElement
    || target.isContentEditable;
}

// ---------------------------------------------------------------------------
// Web fallback: capture-phase listeners
// ---------------------------------------------------------------------------

type WebCleanup = (() => void) | null;

function setupWebFallback(keybindsRef: React.MutableRefObject<Keybind[]>): WebCleanup {
  const pressedKeys = new Set<number>();
  const activeActions = new Set<string>();

  function browserCodeToUiohook(code: string): number {
    // Stable numeric ID from KeyboardEvent.code — consistent within web context
    // because the recorder captures using the same mapping
    return code.charCodeAt(0) * 256 + (code.charCodeAt(1) || 0);
  }

  function checkKeybinds(isDown: boolean): void {
    for (const kb of keybindsRef.current) {
      const keysMatch = kb.keys.length === 0 || kb.keys.every((k) => pressedKeys.has(k));
      // Mouse buttons handled separately in mousedown handler
      if (!kb.mouseButton && keysMatch && kb.keys.length > 0) {
        if (isDown && !activeActions.has(kb.actionId)) {
          activeActions.add(kb.actionId);
          dispatchKeybindAction(kb.actionId, true);
        }
      }
    }
    // Check for releases
    if (!isDown) {
      for (const actionId of activeActions) {
        const kb = keybindsRef.current.find((k) => k.actionId === actionId);
        if (kb && !kb.keys.every((k) => pressedKeys.has(k))) {
          activeActions.delete(actionId);
          dispatchKeybindAction(actionId, false);
        }
      }
    }
  }

  function onKeyDown(e: KeyboardEvent): void {
    // Input suppression: single character key + no modifiers + input focused → skip
    if (isInputElement(e.target) && isCharacterKey(e)) return;

    const code = browserCodeToUiohook(e.code);
    pressedKeys.add(code);
    checkKeybinds(true);
  }

  function onKeyUp(e: KeyboardEvent): void {
    const code = browserCodeToUiohook(e.code);
    pressedKeys.delete(code);
    checkKeybinds(false);
  }

  // Browser button index → uiohook button index
  const buttonMap: Record<number, number> = { 1: 3, 3: 4, 4: 5 };

  function onMouseDown(e: MouseEvent): void {
    const uiButton = buttonMap[e.button];
    if (!uiButton) return;

    for (const kb of keybindsRef.current) {
      if (kb.mouseButton === uiButton) {
        const keysMatch = kb.keys.length === 0 || kb.keys.every((k) => pressedKeys.has(k));
        if (keysMatch && !activeActions.has(kb.actionId)) {
          activeActions.add(kb.actionId);
          dispatchKeybindAction(kb.actionId, true);
        }
      }
    }
  }

  function onMouseUp(e: MouseEvent): void {
    const uiButton = buttonMap[e.button];
    if (!uiButton) return;

    for (const actionId of [...activeActions]) {
      const kb = keybindsRef.current.find((k) => k.actionId === actionId);
      if (kb && kb.mouseButton === uiButton) {
        activeActions.delete(actionId);
        dispatchKeybindAction(actionId, false);
      }
    }
  }

  window.addEventListener('keydown', onKeyDown, true);
  window.addEventListener('keyup', onKeyUp, true);
  window.addEventListener('mousedown', onMouseDown, true);
  window.addEventListener('mouseup', onMouseUp, true);

  return () => {
    window.removeEventListener('keydown', onKeyDown, true);
    window.removeEventListener('keyup', onKeyUp, true);
    window.removeEventListener('mousedown', onMouseDown, true);
    window.removeEventListener('mouseup', onMouseUp, true);
  };
}

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

export function useKeybinds(): void {
  const keybinds = useKeybindStore((s) => s.keybinds);
  const currentVoiceChannelId = useVoiceStore((s) => s.currentVoiceChannelId);
  const keybindsRef = useRef(keybinds);
  keybindsRef.current = keybinds;

  // --- PTT activation lifecycle ---
  useEffect(() => {
    const hasPtt = keybinds.some((kb) => kb.actionId === 'pushToTalk');
    const inVoice = !!currentVoiceChannelId;
    const voice = useVoiceStore.getState();

    if (hasPtt && inVoice) {
      voice.setPttActive(true);
      voice.setMuted(true);
      broadcastVoiceStatus();
    } else if (voice.pttActive) {
      voice.setPttActive(false);
    }
  }, [keybinds, currentVoiceChannelId]);

  // --- Electron: IPC bridge ---
  useEffect(() => {
    if (!isElectron()) return;
    const api = window.backspace;
    if (!api?.syncKeybinds || !api?.onKeybindAction) return;

    api.syncKeybinds(keybinds.map((kb) => ({
      actionId: kb.actionId,
      keys: kb.keys,
      mouseButton: kb.mouseButton,
    })));

    const cleanup = api.onKeybindAction((action) => {
      dispatchKeybindAction(action.actionId, action.pressed);
    });

    return cleanup;
  }, [keybinds]);

  // --- Web fallback: capture-phase listeners ---
  useEffect(() => {
    if (isElectron()) return;
    if (keybinds.length === 0) return;

    const cleanup = setupWebFallback(keybindsRef);
    return cleanup ?? undefined;
  }, [keybinds]);
}
