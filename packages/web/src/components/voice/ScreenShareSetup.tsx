import React, { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import { getElectronAPI, isElectron } from '../../platform/platform';
import { useVoiceStore } from '../../stores/voiceStore';
import { useScreenShareSetupStore } from '../../stores/screenShareSetupStore';
import { usePortalContainer } from '../../hooks/usePortalContainer';
import { getActiveRoom } from '../../hooks/useLiveKit';
import { broadcastVoiceStatus } from '../../utils/voice';
import {
  stageScreenCapture,
  applyStagedCaptureConfig,
  stopStagedCapture,
  publishScreenShare,
  isScreenCaptureSupported,
  isCaptureCancellation,
  describeStagedCapture,
  type CapturedSurfaceKind,
} from '../../utils/screenShare';
import { StreamQualityControls, StreamSummary } from './StreamQualityControls';

/**
 * ScreenShareSetup — the one screen every screen share starts from.
 *
 * Flow on every platform: pick a source → the capture is *staged* (live, but
 * not published; previewed here) → tune quality → "Start stream" publishes.
 * Cancelling stops the staged tracks; nothing was ever sent.
 *
 * Source picking differs by platform:
 *   - Electron with `getScreenSources` (current desktop): sources are listed
 *     up front. Clicking a tile preselects it in the main process and calls
 *     getDisplayMedia(), which the main process answers without a prompt.
 *   - Electron without it (older desktop): the "Choose" card calls
 *     getDisplayMedia(); the main process pushes its source list back
 *     (`onScreenShareSources`) and the grid appears inline; clicking a tile
 *     answers that in-flight request (`selectScreenSource`).
 *   - Electron on a system-picker platform (Wayland): same "Choose" card,
 *     but the OS screencast portal does the picking. Listing sources up front
 *     would open the portal on every open, so nothing is enumerated until the
 *     click; the main process answers the request with the portal's single
 *     result.
 *   - Browser: the "Choose" card calls getDisplayMedia() and the browser's
 *     own prompt does the picking. Must happen inside the click (transient
 *     activation), which is why the choice is a button and not automatic.
 *
 * The card is a fixed, near-viewport glass surface so the layout never jumps
 * with its content. The quality panel is a drawer that slides in over the
 * stage from the right, opened from the "Stream settings" button in the
 * footer's action pill (next to Cancel / Start) or the footer summary.
 */

type Tab = 'screens' | 'windows';
type SetupError = 'cancelled' | 'unsupported' | 'captureFailed' | 'startFailed' | null;

function errorKey(err: unknown): SetupError {
  if (isCaptureCancellation(err)) return 'cancelled';
  if (err instanceof Error && err.name === 'NotSupportedError') return 'unsupported';
  return 'captureFailed';
}

export function ScreenShareSetup() {
  const { t } = useTranslation(['voice', 'common']);
  const isOpen = useScreenShareSetupStore((s) => s.isOpen);
  const close = useScreenShareSetupStore((s) => s.close);
  const portalContainer = usePortalContainer();
  const config = useVoiceStore((s) => s.screenShareConfig);
  const isScreenSharing = useVoiceStore((s) => s.isScreenSharing);

  const api = getElectronAPI();
  const electron = isElectron();

  // Who picks: null until the desktop answered (or immediately 'app' where it can't be asked)
  const [pickerMode, setPickerMode] = useState<'app' | 'system' | null>(null);
  const canListSources = electron && pickerMode === 'app' && typeof api?.getScreenSources === 'function';
  const systemPicker = electron && pickerMode === 'system';

  // Electron source grid
  const [sources, setSources] = useState<ElectronScreenSource[]>([]);
  const [loadingSources, setLoadingSources] = useState(false);
  const [activeTab, setActiveTab] = useState<Tab>('screens');
  const [search, setSearch] = useState('');
  const [selectedId, setSelectedId] = useState<string | null>(null);

  // Quality drawer
  const [settingsOpen, setSettingsOpen] = useState(false);

  // Staged capture (all platforms)
  const [staged, setStaged] = useState<MediaStream | null>(null);
  const [stagedInfo, setStagedInfo] = useState<{ kind: CapturedSurfaceKind | null; label: string | null }>({ kind: null, label: null });
  const [stagedShareAudio, setStagedShareAudio] = useState<boolean>(config.shareAudio);
  const [staging, setStaging] = useState(false);
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState<SetupError>(null);
  const stagedRef = useRef<MediaStream | null>(null);
  const previewRef = useRef<HTMLVideoElement>(null);
  const drawerRef = useRef<HTMLDivElement>(null);

  // Older-desktop prompted flow bookkeeping. The ref is the source of truth for
  // synchronous decisions inside callbacks; the state mirror is what render reads.
  const promptInFlightRef = useRef(false);
  const [promptInFlight, setPromptInFlight] = useState(false);
  const pendingPromptIdRef = useRef<string | null>(null);

  /**
   * Bumped by every pick. A capture whose generation is stale by the time
   * getDisplayMedia() resolves belongs to nobody — the screen was closed, or a
   * newer source was picked — so it is stopped instead of being adopted. Without
   * it, cancelling mid-prompt leaks a live OS capture (this component is mounted
   * once in App.tsx and never unmounts, so no cleanup ever runs), and two quick
   * picks can leave the preview showing one surface while the labels name another.
   */
  const stageGenerationRef = useRef(0);

  const markPromptInFlight = useCallback((value: boolean) => {
    promptInFlightRef.current = value;
    setPromptInFlight(value);
  }, []);

  const replaceStaged = useCallback((next: MediaStream | null) => {
    if (stagedRef.current && stagedRef.current !== next) stopStagedCapture(stagedRef.current);
    stagedRef.current = next;
    setStaged(next);
    if (!next) setStagedInfo({ kind: null, label: null });
  }, []);

  /**
   * Capture via getDisplayMedia and hold the result as the staged preview.
   * `claimed` reuses a generation already taken by stageSource; a direct call
   * (the "Choose screen" button) takes a fresh one.
   */
  const stage = useCallback(async (claimed?: number) => {
    const generation = claimed ?? ++stageGenerationRef.current;
    setError(null);
    setStaging(true);
    const shareAudioAtStage = useVoiceStore.getState().screenShareConfig.shareAudio;
    // System picker: no tile carries the audio preference, so send it ahead of the request
    api?.setScreenShareAudioPreference?.(shareAudioAtStage);
    try {
      const stream = await stageScreenCapture();
      if (generation !== stageGenerationRef.current) {
        // Superseded while the picker was open: never adopt it, and never
        // leave the OS capturing for a stream nothing will publish.
        stopStagedCapture(stream);
        return;
      }
      replaceStaged(stream);
      setStagedInfo(describeStagedCapture(stream));
      setStagedShareAudio(shareAudioAtStage);
    } catch (err) {
      if (generation !== stageGenerationRef.current) return;
      replaceStaged(null);
      setSelectedId(null);
      setError(errorKey(err));
    } finally {
      // Only the newest attempt owns these flags; an older one finishing later
      // must not clear the spinner out from under the capture still running.
      if (generation === stageGenerationRef.current) {
        markPromptInFlight(false);
        setStaging(false);
      }
    }
  }, [api, replaceStaged, markPromptInFlight]);

  /** Electron: a tile was clicked. Resolve an in-flight prompt, or preselect and stage. */
  const stageSource = useCallback(async (sourceId: string) => {
    if (!api) return;
    const generation = ++stageGenerationRef.current;
    setSelectedId(sourceId);
    const shareAudio = useVoiceStore.getState().screenShareConfig.shareAudio;
    if (promptInFlightRef.current) {
      api.selectScreenSource(sourceId, shareAudio);
      return;
    }
    if (api.preselectScreenSource) {
      // Awaited: the preselection and getDisplayMedia() travel different IPC
      // pipes with no ordering guarantee between them. If the display-media
      // handler wins the race it finds no preselection, degrades to the
      // prompted flow, and the preselection then sits armed for its whole TTL
      // ready to hijack the next share. The round trip is free next to a dialog.
      try {
        await api.preselectScreenSource(sourceId, shareAudio);
      } catch (err) {
        console.error('[ScreenShareSetup] preselectScreenSource failed:', err);
      }
      // A newer tile was clicked while the preselection was in flight
      if (generation !== stageGenerationRef.current) return;
    } else {
      // Older desktop: the main process will push sources; answer with this id when it does.
      pendingPromptIdRef.current = sourceId;
    }
    void stage(generation);
  }, [api, stage]);

  // Ask the desktop who picks, once per open
  useEffect(() => {
    if (!isOpen) return;
    if (!electron) { setPickerMode('app'); return; }
    if (!api?.getScreenSharePickerMode) { setPickerMode('app'); return; }
    let cancelled = false;
    api.getScreenSharePickerMode()
      .then((mode) => { if (!cancelled) setPickerMode(mode); })
      .catch(() => { if (!cancelled) setPickerMode('app'); });
    return () => { cancelled = true; };
  }, [isOpen, electron, api]);

  // Electron: list sources up front when we can
  useEffect(() => {
    if (!isOpen || !canListSources || !api?.getScreenSources) return;
    let cancelled = false;
    setLoadingSources(true);
    api.getScreenSources()
      .then((list) => { if (!cancelled) setSources(list); })
      .catch((err) => { console.error('[ScreenShareSetup] getScreenSources failed:', err); if (!cancelled) setSources([]); })
      .finally(() => { if (!cancelled) setLoadingSources(false); });
    return () => { cancelled = true; };
  }, [isOpen, canListSources, api]);

  // Older desktop: main pushes sources for an in-flight getDisplayMedia
  useEffect(() => {
    if (!api) return;
    api.onScreenShareSources((incoming) => {
      const pendingId = pendingPromptIdRef.current;
      if (pendingId) {
        pendingPromptIdRef.current = null;
        api.selectScreenSource(pendingId, useVoiceStore.getState().screenShareConfig.shareAudio);
        return;
      }
      markPromptInFlight(true);
      setSources(incoming);
    });
    // Preload registers listeners without a remover; register once for the app lifetime.
  }, [api, markPromptInFlight]);

  // Reset per open
  useEffect(() => {
    if (!isOpen) return;
    setActiveTab('screens');
    setSearch('');
    setSelectedId(null);
    setError(null);
    setStarting(false);
    setSettingsOpen(false);
    setSources([]);
    // Abandon anything still in flight from the previous open, and drop a
    // capture staged back then: reopening must never offer a stale surface as
    // "ready to go live", nor let Start publish it instead of a fresh pick.
    stageGenerationRef.current++;
    replaceStaged(null);
    setStagedShareAudio(useVoiceStore.getState().screenShareConfig.shareAudio);
    setStaging(false);
    markPromptInFlight(false);
    pendingPromptIdRef.current = null;
  }, [isOpen, replaceStaged, markPromptInFlight]);

  // Auto-stage the only screen so the common case needs a single click on Start
  useEffect(() => {
    if (!isOpen || !canListSources || staged || staging || selectedId) return;
    const screens = sources.filter((s) => s.isScreen);
    if (screens.length === 1 && activeTab === 'screens') void stageSource(screens[0]!.id);
  }, [isOpen, canListSources, sources, staged, staging, selectedId, activeTab, stageSource]);

  // Preview element ↔ staged stream
  useEffect(() => {
    const el = previewRef.current;
    if (!el) return;
    el.srcObject = staged;
    if (staged) el.play().catch(() => {});
    return () => { el.srcObject = null; };
  }, [staged]);

  // Browser "Stop sharing" bar during staging ends the track: drop the preview
  useEffect(() => {
    const track = staged?.getVideoTracks()[0];
    if (!track) return;
    const onEnded = () => { replaceStaged(null); setSelectedId(null); };
    track.addEventListener('ended', onEnded);
    return () => track.removeEventListener('ended', onEnded);
  }, [staged, replaceStaged]);

  // Quality changes reach the staged track immediately (local only, no renegotiation)
  useEffect(() => {
    if (!staged) return;
    void applyStagedCaptureConfig(staged);
  }, [staged, config.height, config.fps, config.mode]);

  // The closed drawer is off-canvas but still in the DOM, so its buttons,
  // sliders and toggle would stay in the tab order: tabbing through the setup
  // screen would move focus into an aria-hidden subtree, which browsers refuse
  // ("Blocked aria-hidden on an element because its descendant retained
  // focus") and screen readers announce from nowhere. `inert` removes the whole
  // subtree from focus and the accessibility tree at once. React 18 has no
  // `inert` prop, so it is set as a DOM property.
  // `isOpen` is a dependency because the whole card is unmounted while closed:
  // reopening builds a new drawer element, and without it the effect would not
  // re-run (settingsOpen is false both before and after) so the fresh element
  // would stay focusable.
  useEffect(() => {
    const el = drawerRef.current;
    if (el) el.inert = !settingsOpen;
  }, [settingsOpen, isOpen]);

  const handleClose = useCallback(() => {
    // Abandon any capture still being picked. Without this the promise resolves
    // onto a closed screen and the OS keeps capturing forever.
    stageGenerationRef.current++;
    setStaging(false);
    if (promptInFlightRef.current && api) {
      api.selectScreenSource(null);
    }
    markPromptInFlight(false);
    pendingPromptIdRef.current = null;
    replaceStaged(null);
    close();
  }, [api, replaceStaged, close, markPromptInFlight]);

  // Already live (started elsewhere while open): the setup no longer applies
  useEffect(() => {
    if (isOpen && isScreenSharing && !starting) handleClose();
  }, [isOpen, isScreenSharing, starting, handleClose]);

  // Escape closes the drawer first, then the screen; also release the capture on unmount
  useEffect(() => {
    if (!isOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      if (settingsOpen) setSettingsOpen(false);
      else handleClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [isOpen, settingsOpen, handleClose]);
  useEffect(() => () => stopStagedCapture(stagedRef.current), []);

  const handleStart = useCallback(async () => {
    const stream = stagedRef.current;
    const room = getActiveRoom();
    if (!stream || !room) { setError('startFailed'); return; }
    setStarting(true);
    setError(null);
    const ok = await publishScreenShare(room, stream);
    if (!ok) {
      // publishScreenShare stopped the tracks on failure
      stagedRef.current = null;
      setStaged(null);
      setSelectedId(null);
      setStarting(false);
      setError('startFailed');
      return;
    }
    broadcastVoiceStatus();
    // Ownership moved to LiveKit: do not stop the tracks on close
    stagedRef.current = null;
    setStaged(null);
    setStarting(false);
    close();
  }, [close]);

  const screens = useMemo(() => sources.filter((s) => s.isScreen), [sources]);
  const windows = useMemo(() => {
    const wins = sources.filter((s) => !s.isScreen);
    if (!search.trim()) return wins;
    const q = search.trim().toLowerCase();
    return wins.filter((w) => w.name.toLowerCase().includes(q));
  }, [sources, search]);

  if (!isOpen) return null;

  const showGrid = electron && (canListSources || promptInFlight || sources.length > 0);
  const activeSources = activeTab === 'windows' ? windows : screens;
  const supported = isScreenCaptureSupported();
  const audioNeedsRepick = !!staged && stagedShareAudio !== config.shareAudio;
  const canStart = !!staged && !staging && !starting;
  const chooseHint = !electron
    ? t('voice:screenPicker.chooseHint')
    : systemPicker
      ? t('voice:screenPicker.chooseHintSystem')
      : null;
  const stageNow = () => void stage();
  const stagedSource = sources.find((s) => s.id === selectedId) ?? null;
  const stagedName = stagedSource?.name ?? stagedInfo.label;
  // What the picker handed us: the standard track setting where reported, else the tile we clicked
  const stagedKind: CapturedSurfaceKind | null =
    stagedInfo.kind ?? (stagedSource ? (stagedSource.isScreen ? 'monitor' : 'window') : null);
  const readyLabel = stagedKind
    ? `${t('voice:screenPicker.stageReady')} · ${t(`voice:screenPicker.kind.${stagedKind}`)}`
    : t('voice:screenPicker.stageReady');

  return createPortal(
    <div className="fixed inset-0 z-[200] flex items-center justify-center animate-fade-in">
      {/* Backdrop */}
      <div className="absolute inset-0 bg-black/50" onClick={handleClose} />

      {/* Card — fixed to the viewport so the layout never jumps with its content */}
      <div
        data-testid="screen-share-setup"
        className="relative w-[calc(calc(100*var(--app-vw))-6rem)] max-w-6xl h-[calc(88*var(--app-vh))] glass-modal rounded-xl animate-slide-up flex flex-col"
      >
        {/* Header */}
        <div className="flex items-start justify-between gap-4 px-6 pt-5 pb-3 flex-shrink-0">
          <div className="min-w-0">
            <h2 className="text-xl font-bold text-txt-primary leading-tight">{t('voice:screenPicker.title')}</h2>
            <p className="text-[13px] text-txt-tertiary mt-0.5">{t('voice:screenPicker.subtitle')}</p>
          </div>
          <button
            onClick={handleClose}
            className="text-txt-tertiary hover:text-txt-primary transition-colors p-1 -mr-1 flex-shrink-0"
            aria-label={t('common:actions.close')}
          >
            <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor">
              <path d="M18.4 4L12 10.4L5.6 4L4 5.6L10.4 12L4 18.4L5.6 20L12 13.6L18.4 20L20 18.4L13.6 12L20 5.6L18.4 4Z" />
            </svg>
          </button>
        </div>

        {/* Toolbar — Screens / Windows plus window search; only where the app lists sources */}
        {showGrid && (
          <div className="flex items-center justify-between gap-3 px-6 pb-3 flex-shrink-0">
            <div className="flex items-center gap-1 p-1 rounded-full bg-white/[0.04] ring-1 ring-white/[0.06]">
              <TabButton
                active={activeTab === 'screens'}
                onClick={() => setActiveTab('screens')}
                label={t('voice:screenPicker.tabs.screens')}
                count={screens.length}
              />
              <TabButton
                active={activeTab === 'windows'}
                onClick={() => setActiveTab('windows')}
                label={t('voice:screenPicker.tabs.windows')}
                count={windows.length}
              />
            </div>
            {showGrid && activeTab === 'windows' && (
              <input
                type="text"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder={t('voice:screenPicker.searchWindows')}
                className="input-search w-64 max-w-[45%]"
                autoFocus
              />
            )}
          </div>
        )}

        {/* Body: full-width source area; the quality drawer slides in over it */}
        <div className="relative flex-1 min-h-0 overflow-hidden flex">
          {/* Source area */}
          <div className="flex-1 min-w-0 min-h-0 flex flex-col px-6 pb-4">
            {showGrid ? (
              <>
                {/* Source grid */}
                <div className="flex-1 min-h-0 overflow-y-auto scrollbar-thin rounded-xl bg-black/20 ring-1 ring-white/[0.06] p-3">
                  {loadingSources && sources.length === 0 ? (
                    <div className="h-full flex items-center justify-center text-txt-tertiary text-sm">
                      {t('voice:screenPicker.loadingSources')}
                    </div>
                  ) : activeSources.length === 0 ? (
                    <div className="h-full flex items-center justify-center text-txt-tertiary text-sm">
                      {activeTab === 'windows' && search.trim()
                        ? t('voice:screenPicker.noWindowsMatch')
                        : activeTab === 'screens'
                          ? t('voice:screenPicker.noScreens')
                          : t('voice:screenPicker.noWindows')}
                    </div>
                  ) : (
                    <div className={`grid gap-3 ${activeTab === 'screens' ? 'grid-cols-2 desktop:grid-cols-3' : 'grid-cols-2 desktop:grid-cols-4'}`}>
                      {activeSources.map((source) => (
                        <SourceCard
                          key={source.id}
                          source={source}
                          selected={selectedId === source.id}
                          onClick={() => void stageSource(source.id)}
                          onDoubleClick={() => { if (stagedRef.current && selectedId === source.id) void handleStart(); }}
                        />
                      ))}
                    </div>
                  )}
                </div>

                {/* Staged strip — live preview of the chosen tile */}
                <div className={`flex-shrink-0 overflow-hidden transition-all duration-300 ${staged ? 'max-h-40 mt-3 opacity-100' : 'max-h-0 mt-0 opacity-0'}`}>
                  <div className="flex items-center gap-4 rounded-xl glass px-3 py-3">
                    <div className="w-44 flex-shrink-0">
                      <div className="relative rounded-lg overflow-hidden bg-black/60 aspect-video ring-1 ring-white/[0.08]">
                        <video ref={previewRef} autoPlay muted playsInline className="w-full h-full object-contain" />
                      </div>
                    </div>
                    <div className="min-w-0 flex-1">
                      <div className="text-[11px] font-semibold uppercase tracking-wider text-accent-mint truncate">{readyLabel}</div>
                      <div className="text-[14px] font-semibold text-txt-primary truncate mt-0.5">
                        {stagedName ?? t('voice:screenPicker.preview')}
                      </div>
                      {audioNeedsRepick && (
                        <div className="text-[11px] text-accent-amber/80 mt-1">{t('voice:screenPicker.audioNeedsRepick')}</div>
                      )}
                    </div>
                  </div>
                </div>
              </>
            ) : (
              /* Browser, system picker, or older desktop before its prompt: the stage */
              <div className="relative flex-1 min-h-0 rounded-xl overflow-hidden bg-surface-base ring-1 ring-white/[0.06]">
                {/* Ambient glow so the empty stage reads as a screen, not a form field */}
                <div className="absolute inset-0 pointer-events-none bg-[radial-gradient(ellipse_at_50%_40%,rgba(255,255,255,0.05),transparent_60%)]" />
                <div className="absolute inset-0 pointer-events-none bg-[radial-gradient(ellipse_at_50%_110%,rgba(140,130,255,0.12),transparent_55%)]" />

                {staged ? (
                  <>
                    <video ref={previewRef} autoPlay muted playsInline className="absolute inset-0 w-full h-full object-contain bg-black/70" />
                    <div className="absolute top-3 left-3 px-2 py-0.5 rounded-md bg-black/60 text-[10px] font-bold uppercase tracking-wide text-white/80">
                      {t('voice:screenPicker.preview')}
                    </div>
                    <div className="absolute inset-x-0 bottom-0 px-4 py-3 flex flex-col items-start gap-2 desktop:flex-row desktop:items-center desktop:justify-between desktop:gap-3 bg-gradient-to-t from-black/70 via-black/30 to-transparent">
                      <div className="min-w-0">
                        <div className="text-[11px] font-semibold uppercase tracking-wider text-accent-mint truncate">{readyLabel}</div>
                        {stagedName && (
                          <div className="text-[13px] font-semibold text-white truncate mt-0.5">{stagedName}</div>
                        )}
                        {audioNeedsRepick && (
                          <div className="text-[11px] text-accent-amber/90 mt-0.5">{t('voice:screenPicker.audioNeedsRepick')}</div>
                        )}
                      </div>
                      <button
                        onClick={stageNow}
                        disabled={staging}
                        className="flex-shrink-0 px-3 py-1.5 rounded-full glass text-txt-primary hover:bg-white/[0.08] text-[13px] font-medium transition-colors disabled:opacity-40"
                      >
                        {t('voice:screenPicker.chooseAgain')}
                      </button>
                    </div>
                  </>
                ) : (
                  <div className="relative h-full flex flex-col items-center justify-center text-center gap-4 px-6">
                    {/* Monitor illustration */}
                    <svg width="112" height="88" viewBox="0 0 112 88" fill="none" aria-hidden="true" className="drop-shadow-[0_8px_24px_rgba(140,130,255,0.25)]">
                      <rect x="4" y="4" width="104" height="66" rx="8" stroke="rgba(255,255,255,0.22)" strokeWidth="2" fill="rgba(255,255,255,0.03)" />
                      <rect x="10" y="10" width="92" height="54" rx="4" fill="url(#ss-stage-screen)" />
                      <path d="M46 78h20M56 70v8" stroke="rgba(255,255,255,0.22)" strokeWidth="2" strokeLinecap="round" />
                      <path d="M40 84h32" stroke="rgba(255,255,255,0.16)" strokeWidth="2" strokeLinecap="round" />
                      <path d="M62 37l-10-6.5v13L62 37z" fill="rgba(255,255,255,0.55)" />
                      <defs>
                        <linearGradient id="ss-stage-screen" x1="10" y1="10" x2="102" y2="64" gradientUnits="userSpaceOnUse">
                          <stop stopColor="rgba(140,130,255,0.35)" />
                          <stop offset="1" stopColor="rgba(140,130,255,0.08)" />
                        </linearGradient>
                      </defs>
                    </svg>
                    <div>
                      <div className="text-[11px] font-semibold uppercase tracking-wider text-txt-tertiary">{t('voice:screenPicker.stageIdle')}</div>
                      <div className="text-[17px] font-bold text-txt-primary mt-1">{t('voice:screenPicker.chooseTitle')}</div>
                      {chooseHint && (
                        <div className="text-[13px] text-txt-tertiary max-w-md mt-1">{chooseHint}</div>
                      )}
                    </div>
                    <button
                      onClick={stageNow}
                      disabled={staging || !supported || (electron && pickerMode === null)}
                      className="px-5 py-2.5 rounded-full bg-accent-primary hover:bg-accent-primary-hover text-white text-sm font-semibold transition-colors shadow-lg shadow-accent-primary/20 disabled:opacity-40 disabled:cursor-not-allowed disabled:shadow-none"
                    >
                      {t('voice:screenPicker.choose')}
                    </button>
                    {!supported && (
                      <div className="text-[12px] text-txt-danger">{t('voice:screenPicker.unsupported')}</div>
                    )}
                  </div>
                )}
              </div>
            )}
          </div>

          {/* Drawer scrim — click outside the drawer closes it */}
          <div
            className={`absolute inset-0 z-10 bg-black/40 transition-opacity duration-300 ${settingsOpen ? 'opacity-100' : 'opacity-0 pointer-events-none'}`}
            onClick={() => setSettingsOpen(false)}
          />

          {/* Quality drawer: slides in from the right, over the source area */}
          <div
            ref={drawerRef}
            id="stream-settings-drawer-panel"
            data-testid="stream-settings-drawer"
            aria-hidden={!settingsOpen}
            className={`absolute inset-y-0 right-0 z-20 w-[calc(calc(100*var(--app-vw))-5rem)] desktop:w-[340px] glass border-l border-border-hard flex flex-col min-h-0 shadow-2xl transition-transform duration-300 ease-out ${
              settingsOpen ? 'translate-x-0' : 'translate-x-full'
            }`}
          >
            <div className="flex items-center justify-between px-5 pt-4 pb-3 border-b border-border-hard flex-shrink-0">
              <span className="text-[15px] font-bold text-txt-primary">{t('voice:streamSettings.title')}</span>
              <button
                onClick={() => setSettingsOpen(false)}
                className="text-txt-tertiary hover:text-txt-primary transition-colors p-1 -mr-1"
                aria-label={t('common:actions.close')}
              >
                <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
                  <path d="M18.4 4L12 10.4L5.6 4L4 5.6L10.4 12L4 18.4L5.6 20L12 13.6L18.4 20L20 18.4L13.6 12L20 5.6L18.4 4Z" />
                </svg>
              </button>
            </div>
            <div className="flex-1 min-h-0 overflow-y-auto scrollbar-thin px-5 py-4">
              <StreamQualityControls />
            </div>
          </div>
        </div>

        {/* Footer */}
        <div className="flex-shrink-0 flex items-center justify-between gap-3 px-6 pt-3 pb-4 border-t border-border-hard">
          <div className="min-w-0 flex flex-col">
            <button
              onClick={() => setSettingsOpen(true)}
              className="text-left hover:text-txt-secondary transition-colors truncate"
              title={t('voice:streamSettings.title')}
            >
              <StreamSummary />
            </button>
            {error && (
              <span className="text-[12px] text-txt-danger truncate" role="alert">
                {t(`voice:screenPicker.${error}`)}
              </span>
            )}
          </div>
          <div className="glass-bubble rounded-full px-2 py-2 flex items-center gap-1 flex-shrink-0">
            <button
              onClick={() => setSettingsOpen((open) => !open)}
              aria-expanded={settingsOpen}
              aria-controls="stream-settings-drawer-panel"
              aria-label={t('voice:streamSettings.title')}
              title={t('voice:streamSettings.title')}
              className={`flex items-center gap-2 pl-3 pr-3.5 py-1.5 rounded-full text-sm font-medium transition-colors ${
                settingsOpen
                  ? 'bg-white/[0.1] text-txt-primary'
                  : 'text-txt-secondary hover:text-txt-primary hover:bg-white/[0.06]'
              }`}
            >
              <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor" className="flex-shrink-0">
                <path d="M3 17v2h6v-2H3zM3 5v2h10V5H3zm10 16v-2h8v-2h-8v-2h-2v6h2zM7 9v2H3v2h4v2h2V9H7zm14 4v-2H11v2h10zm-6-4h2V7h4V5h-4V3h-2v6z" />
              </svg>
              <span className="hidden desktop:inline">{t('voice:streamSettings.title')}</span>
            </button>
            <div className="w-px h-5 bg-white/10 mx-1" />
            <button
              onClick={handleClose}
              className="px-3 py-1 text-sm text-txt-tertiary hover:text-txt-secondary transition-colors"
            >
              {t('common:actions.cancel')}
            </button>
            <button
              onClick={() => void handleStart()}
              disabled={!canStart}
              className="px-4 py-1.5 bg-accent-primary hover:bg-accent-primary-hover text-white text-sm font-semibold rounded-full transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
            >
              {t('voice:screenPicker.start')}
            </button>
          </div>
        </div>

      </div>
    </div>,
    portalContainer,
  );
}

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

function TabButton({ active, onClick, label, count }: {
  active: boolean;
  onClick: () => void;
  label: string;
  count: number | null;
}) {
  return (
    <button
      onClick={onClick}
      className={`px-3.5 py-1.5 text-sm font-medium rounded-full transition-colors ${
        active
          ? 'bg-accent-primary text-white shadow-sm'
          : 'text-txt-secondary hover:text-txt-primary hover:bg-white/[0.06]'
      }`}
    >
      {label}
      {count !== null && count > 0 && (
        <span className={`ml-1.5 text-xs ${active ? 'text-white/70' : 'text-txt-tertiary'}`}>
          {count}
        </span>
      )}
    </button>
  );
}

function SourceCard({ source, selected, onClick, onDoubleClick }: {
  source: ElectronScreenSource;
  selected: boolean;
  onClick: () => void;
  onDoubleClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      onDoubleClick={onDoubleClick}
      className={`group flex flex-col rounded-lg overflow-hidden transition-all text-left ring-2 ${
        selected
          ? 'ring-accent-primary bg-accent-primary/10'
          : 'ring-transparent hover:ring-white/20 bg-surface-elevated/60 hover:bg-surface-elevated'
      }`}
    >
      {/* Thumbnail */}
      <div className="relative aspect-video bg-black/40 overflow-hidden">
        <img
          src={source.thumbnailDataUrl}
          alt={source.name}
          className="w-full h-full object-contain"
          draggable={false}
        />
        {selected && (
          <div className="absolute top-2 right-2 w-5 h-5 rounded-full bg-accent-primary flex items-center justify-center">
            <svg width="12" height="12" viewBox="0 0 24 24" fill="white">
              <path d="M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z" />
            </svg>
          </div>
        )}
      </div>

      {/* Label */}
      <div className="flex items-center gap-1.5 px-2.5 py-2 min-w-0">
        {source.appIconDataUrl && (
          <img
            src={source.appIconDataUrl}
            alt=""
            className="w-4 h-4 flex-shrink-0"
            draggable={false}
          />
        )}
        <span className={`text-xs truncate ${selected ? 'text-txt-primary' : 'text-txt-secondary'}`}>
          {source.name}
        </span>
      </div>
    </button>
  );
}
