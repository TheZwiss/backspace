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
 * The quality panel is a drawer that slides in over the source area from the
 * right (toggle on the card's edge), so the picker keeps the full width.
 */

type Tab = 'screens' | 'windows';
type SetupError = 'cancelled' | 'unsupported' | 'captureFailed' | 'startFailed' | null;

function errorKey(err: unknown): SetupError {
  if (err instanceof DOMException || (err instanceof Error && 'name' in err)) {
    const name = (err as { name: string }).name;
    if (name === 'NotAllowedError' || name === 'AbortError') return 'cancelled';
    if (name === 'NotSupportedError') return 'unsupported';
  }
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
  const [stagedShareAudio, setStagedShareAudio] = useState<boolean>(config.shareAudio);
  const [staging, setStaging] = useState(false);
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState<SetupError>(null);
  const stagedRef = useRef<MediaStream | null>(null);
  const previewRef = useRef<HTMLVideoElement>(null);

  // Older-desktop prompted flow bookkeeping
  const promptInFlightRef = useRef(false);
  const pendingPromptIdRef = useRef<string | null>(null);

  const replaceStaged = useCallback((next: MediaStream | null) => {
    if (stagedRef.current && stagedRef.current !== next) stopStagedCapture(stagedRef.current);
    stagedRef.current = next;
    setStaged(next);
  }, []);

  /** Capture via getDisplayMedia and hold the result as the staged preview. */
  const stage = useCallback(async () => {
    setError(null);
    setStaging(true);
    const shareAudioAtStage = useVoiceStore.getState().screenShareConfig.shareAudio;
    // System picker: no tile carries the audio preference, so send it ahead of the request
    api?.setScreenShareAudioPreference?.(shareAudioAtStage);
    try {
      const stream = await stageScreenCapture();
      replaceStaged(stream);
      setStagedShareAudio(shareAudioAtStage);
    } catch (err) {
      replaceStaged(null);
      setSelectedId(null);
      setError(errorKey(err));
    } finally {
      promptInFlightRef.current = false;
      setStaging(false);
    }
  }, [api, replaceStaged]);

  /** Electron: a tile was clicked. Resolve an in-flight prompt, or preselect and stage. */
  const stageSource = useCallback((sourceId: string) => {
    if (!api) return;
    setSelectedId(sourceId);
    const shareAudio = useVoiceStore.getState().screenShareConfig.shareAudio;
    if (promptInFlightRef.current) {
      api.selectScreenSource(sourceId, shareAudio);
      return;
    }
    if (api.preselectScreenSource) {
      api.preselectScreenSource(sourceId, shareAudio);
    } else {
      // Older desktop: the main process will push sources; answer with this id when it does.
      pendingPromptIdRef.current = sourceId;
    }
    void stage();
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
      promptInFlightRef.current = true;
      setSources(incoming);
    });
    // Preload registers listeners without a remover; register once for the app lifetime.
  }, [api]);

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
  }, [isOpen]);

  // Auto-stage the only screen so the common case needs a single click on Start
  useEffect(() => {
    if (!isOpen || !canListSources || staged || staging || selectedId) return;
    const screens = sources.filter((s) => s.isScreen);
    if (screens.length === 1 && activeTab === 'screens') stageSource(screens[0]!.id);
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

  const handleClose = useCallback(() => {
    if (promptInFlightRef.current && api) {
      api.selectScreenSource(null);
      promptInFlightRef.current = false;
    }
    pendingPromptIdRef.current = null;
    replaceStaged(null);
    close();
  }, [api, replaceStaged, close]);

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

  const showGrid = electron && (canListSources || promptInFlightRef.current || sources.length > 0);
  const activeSources = activeTab === 'screens' ? screens : windows;
  const supported = isScreenCaptureSupported();
  const audioNeedsRepick = !!staged && stagedShareAudio !== config.shareAudio;
  const canStart = !!staged && !staging && !starting;
  const chooseHint = !electron
    ? t('voice:screenPicker.chooseHint')
    : systemPicker
      ? t('voice:screenPicker.chooseHintSystem')
      : null;

  const previewBlock = (
    <div className="relative rounded-lg overflow-hidden bg-black/60 aspect-video ring-1 ring-white/[0.06]">
      <video ref={previewRef} autoPlay muted playsInline className="w-full h-full object-contain" />
      <div className="absolute top-2 left-2 px-1.5 py-0.5 rounded bg-black/60 text-[10px] font-bold uppercase tracking-wide text-white/80">
        {t('voice:screenPicker.preview')}
      </div>
    </div>
  );

  return createPortal(
    <div className="fixed inset-0 z-[200] flex items-center justify-center animate-fade-in">
      {/* Backdrop */}
      <div className="absolute inset-0 bg-black/50" onClick={handleClose} />

      {/* Modal card */}
      <div
        data-testid="screen-share-setup"
        className="relative w-full max-w-4xl mx-4 glass-modal rounded-lg animate-slide-up flex flex-col max-h-[calc(calc(100*var(--app-vh))-4rem)]"
      >
        {/* Header */}
        <div className="flex items-center justify-between px-5 pt-5 pb-3 flex-shrink-0">
          <h2 className="text-lg font-bold text-txt-primary">{t('voice:screenPicker.title')}</h2>
          <button
            onClick={handleClose}
            className="text-txt-tertiary hover:text-txt-primary transition-colors p-1"
            aria-label={t('common:actions.close')}
          >
            <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor">
              <path d="M18.4 4L12 10.4L5.6 4L4 5.6L10.4 12L4 18.4L5.6 20L12 13.6L18.4 20L20 18.4L13.6 12L20 5.6L18.4 4Z" />
            </svg>
          </button>
        </div>

        {/* Body: full-width source area; the quality drawer slides in over it */}
        <div className="relative flex-1 min-h-0 overflow-hidden flex">
          {/* Source area */}
          <div className="flex-1 min-w-0 min-h-0 flex flex-col pr-9">
            {showGrid ? (
              <>
                {/* Tabs */}
                <div className="flex gap-1 px-5 pb-3 flex-shrink-0">
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

                {/* Search (windows tab only) */}
                {activeTab === 'windows' && (
                  <div className="px-5 pb-3 flex-shrink-0">
                    <input
                      type="text"
                      value={search}
                      onChange={(e) => setSearch(e.target.value)}
                      placeholder={t('voice:screenPicker.searchWindows')}
                      className="input-search w-full"
                      autoFocus
                    />
                  </div>
                )}

                {/* Source grid */}
                <div className="flex-1 min-h-0 overflow-y-auto scrollbar-thin px-5 py-2">
                  {loadingSources && sources.length === 0 ? (
                    <div className="text-center py-12 text-txt-tertiary text-sm">
                      {t('voice:screenPicker.loadingSources')}
                    </div>
                  ) : activeSources.length === 0 ? (
                    <div className="text-center py-12 text-txt-tertiary text-sm">
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
                          onClick={() => stageSource(source.id)}
                          onDoubleClick={() => { if (stagedRef.current && selectedId === source.id) void handleStart(); }}
                        />
                      ))}
                    </div>
                  )}
                </div>

                {/* Staged preview strip */}
                {staged && (
                  <div className="px-5 pb-3 pt-2 flex-shrink-0 flex items-start gap-3 border-t border-border-hard">
                    <div className="w-40 flex-shrink-0 mt-2">{previewBlock}</div>
                    <div className="min-w-0 pt-3">
                      <div className="text-[13px] font-semibold text-txt-primary truncate">
                        {sources.find((s) => s.id === selectedId)?.name ?? t('voice:screenPicker.preview')}
                      </div>
                      {audioNeedsRepick && (
                        <div className="text-[11px] text-accent-amber/80 mt-1">{t('voice:screenPicker.audioNeedsRepick')}</div>
                      )}
                    </div>
                  </div>
                )}
              </>
            ) : (
              /* Browser, system picker, or older desktop before its prompt: choose card / preview */
              <div className="flex-1 min-h-0 overflow-y-auto scrollbar-thin px-5 pb-3 flex flex-col">
                {staged ? (
                  <div className="flex-1 flex flex-col justify-center gap-3">
                    {previewBlock}
                    {audioNeedsRepick && (
                      <div className="text-[11px] text-accent-amber/80">{t('voice:screenPicker.audioNeedsRepick')}</div>
                    )}
                    <button
                      onClick={() => void stage()}
                      disabled={staging}
                      className="self-start px-3 py-1.5 rounded-full bg-surface-elevated text-txt-secondary hover:bg-interactive-hover hover:text-txt-primary text-[13px] font-medium transition-colors disabled:opacity-40"
                    >
                      {t('voice:screenPicker.chooseAgain')}
                    </button>
                  </div>
                ) : (
                  <div className="flex-1 min-h-[220px] rounded-lg border-2 border-dashed border-white/[0.08] bg-white/[0.02] flex flex-col items-center justify-center text-center gap-3 px-6 py-8">
                    <svg width="40" height="40" viewBox="0 0 24 24" fill="currentColor" className="text-txt-tertiary">
                      <path d="M20 18C21.1 18 22 17.1 22 16V6C22 4.9 21.1 4 20 4H4C2.9 4 2 4.9 2 6V16C2 17.1 2.9 18 4 18H0V20H24V18H20ZM4 6H20V16H4V6Z" />
                      <path d="M15 11L11 14V12H9V10H11V8L15 11Z" />
                    </svg>
                    <div className="text-[15px] font-semibold text-txt-primary">{t('voice:screenPicker.chooseTitle')}</div>
                    {chooseHint && (
                      <div className="text-[13px] text-txt-tertiary max-w-sm">{chooseHint}</div>
                    )}
                    <button
                      onClick={() => void stage()}
                      disabled={staging || !supported || (electron && pickerMode === null)}
                      className="mt-1 px-4 py-2 rounded-full bg-accent-primary hover:bg-accent-primary-hover text-white text-sm font-medium transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
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
          {settingsOpen && (
            <div className="absolute inset-0 z-10 bg-black/30 animate-fade-in" onClick={() => setSettingsOpen(false)} />
          )}

          {/* Quality drawer: slides in from the right, over the source area */}
          <div
            data-testid="stream-settings-drawer"
            className={`absolute inset-y-0 right-0 z-20 flex items-stretch transition-transform duration-300 ease-out ${
              settingsOpen ? 'translate-x-0' : 'translate-x-[calc(100%-2.25rem)]'
            }`}
          >
            {/* Edge tab — stays attached to the drawer so it doubles as the close handle */}
            <button
              onClick={() => setSettingsOpen((open) => !open)}
              aria-expanded={settingsOpen}
              aria-controls="stream-settings-drawer-panel"
              aria-label={t('voice:streamSettings.title')}
              title={t('voice:streamSettings.title')}
              className={`self-center w-9 h-28 -mr-px rounded-l-lg flex flex-col items-center justify-center gap-2 transition-colors ${
                settingsOpen
                  ? 'glass text-txt-primary'
                  : 'bg-surface-elevated/90 text-txt-secondary hover:bg-interactive-hover hover:text-txt-primary ring-1 ring-white/[0.06]'
              }`}
            >
              <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor">
                <path d="M3 17v2h6v-2H3zM3 5v2h10V5H3zm10 16v-2h8v-2h-8v-2h-2v6h2zM7 9v2H3v2h4v2h2V9H7zm14 4v-2H11v2h10zm-6-4h2V7h4V5h-4V3h-2v6z" />
              </svg>
              <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor" className={`transition-transform duration-300 ${settingsOpen ? 'rotate-180' : ''}`}>
                <path d="M15.41 7.41L14 6l-6 6 6 6 1.41-1.41L10.83 12z" />
              </svg>
            </button>

            {/* Panel */}
            <div
              id="stream-settings-drawer-panel"
              aria-hidden={!settingsOpen}
              className="w-[calc(calc(100*var(--app-vw))-5rem)] desktop:w-[320px] glass rounded-l-lg flex flex-col min-h-0 shadow-2xl"
            >
              <div className="flex items-center justify-between px-4 pt-3 pb-2 border-b border-border-hard flex-shrink-0">
                <span className="text-[14px] font-bold text-txt-primary">{t('voice:streamSettings.title')}</span>
                <button
                  onClick={() => setSettingsOpen(false)}
                  className="text-txt-tertiary hover:text-txt-primary transition-colors p-1"
                  aria-label={t('common:actions.close')}
                  tabIndex={settingsOpen ? 0 : -1}
                >
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
                    <path d="M18.4 4L12 10.4L5.6 4L4 5.6L10.4 12L4 18.4L5.6 20L12 13.6L18.4 20L20 18.4L13.6 12L20 5.6L18.4 4Z" />
                  </svg>
                </button>
              </div>
              <div className="flex-1 min-h-0 overflow-y-auto scrollbar-thin px-4 py-3">
                <StreamQualityControls />
              </div>
            </div>
          </div>
        </div>

        {/* Footer */}
        <div className="flex-shrink-0 flex items-center justify-between gap-3 px-5 pt-3 pb-4 border-t border-border-hard">
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
          <div className="glass-bubble rounded-full px-3 py-2 flex items-center gap-3 flex-shrink-0">
            <button
              onClick={handleClose}
              className="px-3 py-1 text-sm text-txt-tertiary hover:text-txt-secondary transition-colors"
            >
              {t('common:actions.cancel')}
            </button>
            <button
              onClick={() => void handleStart()}
              disabled={!canStart}
              className="px-3 py-1.5 bg-accent-primary hover:bg-accent-primary-hover text-white text-sm font-medium rounded-full transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
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
  count: number;
}) {
  return (
    <button
      onClick={onClick}
      className={`px-3 py-1.5 text-sm font-medium rounded-full transition-colors ${
        active
          ? 'bg-accent-primary text-white'
          : 'bg-white/[0.06] text-txt-secondary hover:text-txt-primary hover:bg-white/[0.1]'
      }`}
    >
      {label}
      {count > 0 && (
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
      className={`group flex flex-col rounded-lg overflow-hidden transition-all text-left border-2 ${
        selected
          ? 'border-accent-primary bg-accent-primary/10'
          : 'border-white/[0.06] hover:border-border-soft bg-surface-base hover:bg-white/[0.04] hover:brightness-110'
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
