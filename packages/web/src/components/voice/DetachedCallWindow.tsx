import { Tooltip } from '../ui/Tooltip';
import { DmCallStatus } from './DmCallStatus';
import { useEffect, useRef, useState } from 'react';
import { usePointerReveal } from '../../hooks/usePointerReveal';
import { createPortal } from 'react-dom';
import { useUIStore } from '../../stores/uiStore';
import { useVoiceStore } from '../../stores/voiceStore';
import { useScreenShareSetupStore } from '../../stores/screenShareSetupStore';
import { VoiceGrid } from './VoiceGrid';
import { VoiceControlBar } from './VoiceControlBar';

let callWindow: Window | null = null;

/** Open synchronously from a click so Electron accepts the popup. */
export function openDetachedCallWindow(): boolean {
  if (callWindow && !callWindow.closed) { callWindow.focus(); return true; }
  let child: Window | null;
  try { child = window.open('about:blank', 'backspace-voice-call', 'width=960,height=640'); }
  catch (error) { console.warn('[Call window] Opening failed:', error); return false; }
  if (!child) { console.warn('[Call window] Popup was blocked by the desktop shell'); return false; }
  callWindow = child;
  try {
    child.document.title = 'Backspace — Call';
    for (const attribute of document.documentElement.attributes) {
      child.document.documentElement.setAttribute(attribute.name, attribute.value);
    }
    for (const node of document.querySelectorAll('link[rel="stylesheet"], style')) {
      child.document.head.appendChild(node.cloneNode(true));
    }
    child.document.body.style.margin = '0';
    child.document.body.style.background = '#111116';
    child.addEventListener('beforeunload', () => {
      if (useScreenShareSetupStore.getState().targetDocument === child.document) useScreenShareSetupStore.getState().close();
      if (callWindow === child) callWindow = null;
      useUIStore.getState().setCallWindowOpen(false);
    }, { once: true });
    useUIStore.getState().setCallWindowOpen(true);
    return true;
  } catch (error) {
    console.warn('[Call window] Could not initialize popup:', error);
    child.close();
    callWindow = null;
    useUIStore.getState().setCallWindowOpen(false);
    return false;
  }
}

/** The window remains under the main renderer so it uses the existing room. */
export function DetachedCallWindow() {
  const open = useUIStore((s) => s.callWindowOpen);
  const participants = useVoiceStore((s) => s.participants);
  const channel = useVoiceStore((s) => s.currentVoiceChannelId);
  const dm = useVoiceStore((s) => s.activeDmCall);
  const [, refresh] = useState(0);
  const [fullscreen, setFullscreen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const focusedParticipantId = useVoiceStore((s) => s.focusedParticipantId);
  const chromeRevealed = usePointerReveal(containerRef, fullscreen, undefined, !!focusedParticipantId?.endsWith(':stream'));
  useEffect(() => {
    if (!open || !callWindow) { setFullscreen(false); return; }
    const doc = callWindow.document;
    const sync = () => setFullscreen(!!doc.fullscreenElement);
    doc.addEventListener('fullscreenchange', sync);
    return () => doc.removeEventListener('fullscreenchange', sync);
  }, [open]);
  const toggleFullscreen = () => {
    const doc = callWindow?.document;
    const target = containerRef.current;
    if (!doc || !target) return;
    const action = doc.fullscreenElement ? doc.exitFullscreen() : target.requestFullscreen();
    void action.catch((error) => console.warn('[Call window] Fullscreen failed:', error));
  };
  useEffect(() => {
    if (open && !channel && !dm) callWindow?.close();
  }, [open, channel, dm]);
  useEffect(() => () => { callWindow?.close(); callWindow = null; }, []);
  useEffect(() => {
    if (!open || !callWindow) return;
    // BrowserWindow size changes are observed by the grid's ResizeObserver.
    const child = callWindow;
    const onResize = () => refresh((value) => value + 1);
    child.addEventListener('resize', onResize);
    return () => child.removeEventListener('resize', onResize);
  }, [open]);
  if (!open || !callWindow || callWindow.closed) return null;
  const customTitlebar = window.backspace?.platform === 'linux' && !!window.backspace.controlCallWindow;
  return createPortal(
    <div ref={containerRef} className="h-screen w-screen flex flex-col relative bg-surface-base overflow-hidden">
      {customTitlebar && !fullscreen && (
        <div className="titlebar-drag flex justify-end shrink-0 bg-[#0b0b10]" style={{ height: 'calc(32px / var(--interface-scale, 1))', fontFamily: 'sans-serif' }}>
          {([['minimize', '−', 'Minimize'], ['maximize', '□', 'Maximize or restore'], ['close', '×', 'Close']] as const).map(([action, symbol, label]) => (
            <Tooltip content={label} position="top"><button key={action} type="button"  aria-label={label}
              className={`titlebar-no-drag text-[#d8d8de] ${action === 'close' ? 'hover:bg-[#c42b1c]' : 'hover:bg-white/10'}`}
              style={{ width: 'calc(46px / var(--interface-scale, 1))', height: '100%', padding: 0, border: 0, fontSize: 'calc(18px / var(--interface-scale, 1))', lineHeight: 'normal' }}
              onClick={() => window.backspace?.controlCallWindow?.(action)}>{symbol}</button></Tooltip>
          ))}
        </div>
      )}
      {!fullscreen && dm?.dmChannelId && <DmCallStatus channelId={dm.dmChannelId} />}
      <div className="flex-1 flex min-h-0"><VoiceGrid participants={participants} fullscreen={fullscreen} chromeRevealed={chromeRevealed} /></div>
      <VoiceControlBar variant={fullscreen ? "floating" : "docked"} detached detachedFullscreen={fullscreen} onDetachedFullscreenToggle={toggleFullscreen} revealed={chromeRevealed} />
    </div>,
    callWindow.document.body,
  );
}
