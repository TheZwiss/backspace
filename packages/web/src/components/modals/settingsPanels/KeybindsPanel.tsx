import React, { useState, useEffect, useRef, useCallback } from 'react';
import { useKeybindStore, BINDABLE_ACTIONS, Keybind } from '../../../stores/keybindStore';
import { isElectron, isElectronMac } from '../../../platform/platform';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const MODIFIER_CODES = new Set([
  'ShiftLeft', 'ShiftRight', 'ControlLeft', 'ControlRight',
  'AltLeft', 'AltRight', 'MetaLeft', 'MetaRight',
]);

const MOUSE_BUTTON_MAP: Record<number, number> = { 1: 3, 3: 4, 4: 5 };
const MOUSE_BUTTON_NAMES: Record<number, string> = { 3: 'Middle Click', 4: 'Mouse 4', 5: 'Mouse 5' };

function keyDisplayName(code: string, key: string): string {
  if (code.startsWith('Shift')) return 'Shift';
  if (code.startsWith('Control')) return 'Ctrl';
  if (code.startsWith('Alt')) return isElectronMac() ? 'Option' : 'Alt';
  if (code.startsWith('Meta')) return isElectronMac() ? 'Cmd' : 'Win';
  if (code.startsWith('Key')) return code.slice(3).toUpperCase();
  if (code.startsWith('Digit')) return code.slice(5);
  if (key === ' ') return 'Space';
  return key.length === 1 ? key.toUpperCase() : key;
}

function codeToNumeric(code: string): number {
  // djb2 hash — produces unique numeric IDs for all KeyboardEvent.code values
  let hash = 5381;
  for (let i = 0; i < code.length; i++) {
    hash = ((hash << 5) + hash + code.charCodeAt(i)) | 0;
  }
  return hash >>> 0; // ensure unsigned
}

// ---------------------------------------------------------------------------
// Keybind Row
// ---------------------------------------------------------------------------

interface KeybindRowProps {
  actionId: string;
  label: string;
  keybind: Keybind | undefined;
  isRecording: boolean;
  recordingDisplay: string;
  onStartRecording: () => void;
  onDelete: () => void;
  rowRef: React.RefObject<HTMLDivElement>;
}

function KeybindRow({ actionId, label, keybind, isRecording, recordingDisplay, onStartRecording, onDelete, rowRef }: KeybindRowProps) {
  return (
    <div
      ref={rowRef}
      className={`flex items-center justify-between px-4 py-3 rounded-lg transition-all ${
        isRecording
          ? 'ring-2 ring-accent-mint bg-surface-elevated'
          : 'bg-surface-primary hover:bg-surface-elevated'
      }`}
    >
      <div className="flex-1 min-w-0">
        <div className="text-sm text-txt-primary">{label}</div>
        <div className="text-xs text-txt-tertiary mt-0.5">
          {isRecording ? (
            <span className="text-accent-mint animate-pulse">
              {recordingDisplay || 'Press a key combo...'}
            </span>
          ) : keybind ? (
            keybind.displayLabel
          ) : (
            'Not bound'
          )}
        </div>
      </div>
      <div className="flex items-center gap-1.5 ml-3">
        {!isRecording && (
          <>
            <button
              onClick={onStartRecording}
              className="text-xs px-2.5 py-1 rounded text-txt-tertiary hover:text-txt-primary hover:bg-white/[0.06] transition-colors"
            >
              {keybind ? 'Edit' : 'Record'}
            </button>
            {keybind && (
              <button
                onClick={onDelete}
                className="text-xs px-2.5 py-1 rounded text-txt-tertiary hover:text-rose-400 hover:bg-rose-400/10 transition-colors"
              >
                Delete
              </button>
            )}
          </>
        )}
        {isRecording && (
          <span className="text-[10px] text-txt-tertiary">ESC to cancel</span>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Conflict Dialog (inline)
// ---------------------------------------------------------------------------

interface ConflictInfo {
  newActionId: string;
  existingKeybind: Keybind;
  pendingKeybind: Keybind;
}

// ---------------------------------------------------------------------------
// KeybindsPanel
// ---------------------------------------------------------------------------

export function KeybindsPanel() {
  const { keybinds, setKeybind, removeKeybind, findConflict } = useKeybindStore();

  const [recordingActionId, setRecordingActionId] = useState<string | null>(null);
  const [recordingDisplay, setRecordingDisplay] = useState('');
  const [conflict, setConflict] = useState<ConflictInfo | null>(null);

  const [accessibilityTrusted, setAccessibilityTrusted] = useState<boolean | null>(null);
  const [hookError, setHookError] = useState<string | null>(null);

  const pressedCodesRef = useRef(new Map<string, { numeric: number; display: string }>());
  const mouseButtonRef = useRef<number | null>(null);
  const mouseDisplayRef = useRef<string | null>(null);
  const debounceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const rowRefs = useRef<Record<string, React.RefObject<HTMLDivElement>>>({});

  for (const action of BINDABLE_ACTIONS) {
    if (!rowRefs.current[action.id]) {
      rowRefs.current[action.id] = React.createRef();
    }
  }

  // --- Platform checks on mount ---
  useEffect(() => {
    if (isElectronMac() && window.backspace?.checkAccessibility) {
      window.backspace.checkAccessibility().then(setAccessibilityTrusted);
    }
    if (isElectron() && window.backspace?.onAccessibilityStatus) {
      const cleanup = window.backspace.onAccessibilityStatus((status) => {
        setAccessibilityTrusted(status.trusted);
      });
      return cleanup;
    }
  }, []);

  useEffect(() => {
    if (isElectron() && window.backspace?.onKeybindHookError) {
      const cleanup = window.backspace.onKeybindHookError((error) => {
        setHookError(error.message);
      });
      return cleanup;
    }
  }, []);

  // --- Recording logic ---
  const cancelRecording = useCallback(() => {
    setRecordingActionId(null);
    setRecordingDisplay('');
    pressedCodesRef.current.clear();
    mouseButtonRef.current = null;
    mouseDisplayRef.current = null;
    if (debounceTimerRef.current) {
      clearTimeout(debounceTimerRef.current);
      debounceTimerRef.current = null;
    }
  }, []);

  const finalizeRecording = useCallback((actionId: string) => {
    const codes = pressedCodesRef.current;
    const mouseBtn = mouseButtonRef.current;

    const keys = Array.from(codes.values()).map((c) => c.numeric).sort((a, b) => a - b);
    const displayParts = Array.from(codes.values()).map((c) => c.display);
    if (mouseBtn && MOUSE_BUTTON_NAMES[mouseBtn]) {
      displayParts.push(MOUSE_BUTTON_NAMES[mouseBtn]);
    }
    const displayLabel = displayParts.join(' + ');

    const hasNonModifier = Array.from(codes.keys()).some((code) => !MODIFIER_CODES.has(code));
    if (!hasNonModifier && !mouseBtn) {
      return;
    }

    const newKeybind: Keybind = { actionId, keys, mouseButton: mouseBtn ?? undefined, displayLabel };

    const existing = findConflict(keys, mouseBtn ?? undefined, actionId);
    if (existing) {
      setConflict({ newActionId: actionId, existingKeybind: existing, pendingKeybind: newKeybind });
      cancelRecording();
      return;
    }

    setKeybind(newKeybind);
    cancelRecording();
  }, [findConflict, setKeybind, cancelRecording]);

  // --- Recording event listeners ---
  useEffect(() => {
    if (!recordingActionId) return;

    function onKeyDown(e: KeyboardEvent) {
      e.preventDefault();
      e.stopPropagation();

      if (e.code === 'Escape') {
        cancelRecording();
        return;
      }

      if (debounceTimerRef.current) {
        clearTimeout(debounceTimerRef.current);
        debounceTimerRef.current = null;
      }

      const display = keyDisplayName(e.code, e.key);
      const numeric = codeToNumeric(e.code);
      pressedCodesRef.current.set(e.code, { numeric, display });

      const parts = Array.from(pressedCodesRef.current.values()).map((c) => c.display);
      if (mouseDisplayRef.current) parts.push(mouseDisplayRef.current);
      setRecordingDisplay(parts.join(' + '));
    }

    function onKeyUp(e: KeyboardEvent) {
      e.preventDefault();
      e.stopPropagation();

      if (debounceTimerRef.current) clearTimeout(debounceTimerRef.current);
      debounceTimerRef.current = setTimeout(() => {
        if (recordingActionId) finalizeRecording(recordingActionId);
      }, 300);
    }

    function onMouseDown(e: MouseEvent) {
      const rowRef = rowRefs.current[recordingActionId!];
      if (rowRef?.current && !rowRef.current.contains(e.target as Node)) {
        cancelRecording();
        return;
      }

      const uiButton = MOUSE_BUTTON_MAP[e.button];
      if (!uiButton) return;

      e.preventDefault();
      e.stopPropagation();

      mouseButtonRef.current = uiButton;
      mouseDisplayRef.current = MOUSE_BUTTON_NAMES[uiButton] ?? `Mouse ${uiButton}`;

      const parts = Array.from(pressedCodesRef.current.values()).map((c) => c.display);
      parts.push(mouseDisplayRef.current);
      setRecordingDisplay(parts.join(' + '));

      finalizeRecording(recordingActionId!);
    }

    window.addEventListener('keydown', onKeyDown, true);
    window.addEventListener('keyup', onKeyUp, true);
    window.addEventListener('mousedown', onMouseDown, true);

    return () => {
      window.removeEventListener('keydown', onKeyDown, true);
      window.removeEventListener('keyup', onKeyUp, true);
      window.removeEventListener('mousedown', onMouseDown, true);
      if (debounceTimerRef.current) clearTimeout(debounceTimerRef.current);
    };
  }, [recordingActionId, cancelRecording, finalizeRecording]);

  // --- Conflict resolution ---
  const confirmConflict = () => {
    if (!conflict) return;
    removeKeybind(conflict.existingKeybind.actionId);
    setKeybind(conflict.pendingKeybind);
    setConflict(null);
  };

  const cancelConflict = () => setConflict(null);

  const getKeybind = (actionId: string) => keybinds.find((kb) => kb.actionId === actionId);

  return (
    <div className="space-y-5">
      <h2 className="text-lg font-semibold text-txt-primary mb-6">Keybinds</h2>
      {/* macOS Accessibility Warning */}
      {isElectronMac() && accessibilityTrusted === false && (
        <div className="rounded-lg bg-amber-500/10 border border-amber-500/20 p-3.5">
          <div className="text-sm text-amber-200 font-medium">Accessibility Permission Required</div>
          <div className="text-xs text-amber-200/70 mt-1">
            Backspace needs Accessibility permission for global shortcuts to work outside the app.
          </div>
          <button
            onClick={() => {
              window.backspace?.checkAccessibility().then(setAccessibilityTrusted);
            }}
            className="mt-2 text-xs px-3 py-1.5 rounded bg-amber-500/20 text-amber-200 hover:bg-amber-500/30 transition-colors"
          >
            Grant Permission
          </button>
        </div>
      )}

      {/* Linux hook error warning */}
      {isElectron() && hookError && (
        <div className="rounded-lg bg-amber-500/10 border border-amber-500/20 p-3.5">
          <div className="text-sm text-amber-200 font-medium">Global Shortcuts Unavailable</div>
          <div className="text-xs text-amber-200/70 mt-1">
            Failed to start input listener. On Linux, your user may need to be in the <code className="bg-black/20 px-1 rounded">input</code> group.
          </div>
        </div>
      )}

      {/* Web limitation note */}
      {!isElectron() && (
        <div className="text-xs text-txt-tertiary px-1">
          Shortcuts work while this tab is focused. For global shortcuts that work in other apps, use the desktop app.
        </div>
      )}

      {/* Keybind rows */}
      <div>
        <div className="text-[11px] font-semibold text-txt-tertiary uppercase tracking-wider mb-1.5">
          Voice Shortcuts
        </div>
        <div className="space-y-1.5">
          {BINDABLE_ACTIONS.map((action) => (
            <KeybindRow
              key={action.id}
              actionId={action.id}
              label={action.label}
              keybind={getKeybind(action.id)}
              isRecording={recordingActionId === action.id}
              recordingDisplay={recordingDisplay}
              onStartRecording={() => {
                cancelRecording();
                setRecordingActionId(action.id);
              }}
              onDelete={() => removeKeybind(action.id)}
              rowRef={rowRefs.current[action.id]!}
            />
          ))}
        </div>
      </div>

      {/* Conflict dialog */}
      {conflict && (
        <div className="rounded-lg bg-surface-elevated border border-white/[0.06] p-3.5">
          <div className="text-sm text-txt-primary">
            <span className="font-medium">{conflict.pendingKeybind.displayLabel}</span> is already bound to{' '}
            <span className="font-medium">
              {BINDABLE_ACTIONS.find((a) => a.id === conflict.existingKeybind.actionId)?.label}
            </span>
            . Overwrite?
          </div>
          <div className="flex gap-2 mt-2.5">
            <button
              onClick={confirmConflict}
              className="text-xs px-3 py-1.5 rounded bg-accent-mint/20 text-accent-mint hover:bg-accent-mint/30 transition-colors"
            >
              Overwrite
            </button>
            <button
              onClick={cancelConflict}
              className="text-xs px-3 py-1.5 rounded bg-white/[0.06] text-txt-secondary hover:bg-white/[0.1] transition-colors"
            >
              Cancel
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
