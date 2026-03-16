import React, { useState, useEffect, useCallback, useMemo } from 'react';
import { create } from 'zustand';
import { getElectronAPI } from '../../platform/platform';
import { useVoiceStore } from '../../stores/voiceStore';

// ---------------------------------------------------------------------------
// Zustand micro-store — bridges the event-driven API to React state
// ---------------------------------------------------------------------------

interface ScreenPickerState {
  isOpen: boolean;
  sources: ElectronScreenSource[];
}

const useScreenPickerStore = create<ScreenPickerState>(() => ({
  isOpen: false,
  sources: [],
}));

// ---------------------------------------------------------------------------
// Close helper — sends selection back to main process
// ---------------------------------------------------------------------------

function closePicker(sourceId: string | null, shareAudio?: boolean) {
  const api = getElectronAPI();
  if (api) api.selectScreenSource(sourceId, shareAudio);
  useScreenPickerStore.setState({ isOpen: false, sources: [] });
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

type Tab = 'screens' | 'windows';

export function ScreenSharePicker() {
  const { isOpen, sources } = useScreenPickerStore();
  const [activeTab, setActiveTab] = useState<Tab>('screens');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const shareAudio = useVoiceStore((s) => s.screenShareConfig.shareAudio);
  const setScreenShareConfig = useVoiceStore((s) => s.setScreenShareConfig);

  // Register listener for sources from main process (once on mount)
  useEffect(() => {
    const api = getElectronAPI();
    console.log('[Picker] Mounted, registering onScreenShareSources listener, hasAPI:', !!api);
    if (!api) return;

    api.onScreenShareSources((incomingSources) => {
      console.log('[Picker] Received', incomingSources.length, 'sources from main process');
      useScreenPickerStore.setState({
        isOpen: true,
        sources: incomingSources,
      });
    });
  }, []);

  // Reset local state when picker opens
  useEffect(() => {
    if (isOpen) {
      setActiveTab('screens');
      setSelectedId(null);
      setSearch('');
    }
  }, [isOpen]);

  // Auto-select if there's exactly one screen
  useEffect(() => {
    if (isOpen && sources.length > 0 && !selectedId) {
      const screens = sources.filter((s) => s.isScreen);
      if (screens.length === 1 && activeTab === 'screens') {
        setSelectedId(screens[0]!.id);
      }
    }
  }, [isOpen, sources, selectedId, activeTab]);

  const handleKeyDown = useCallback((e: KeyboardEvent) => {
    if (e.key === 'Escape') {
      closePicker(null);
    }
  }, []);

  useEffect(() => {
    if (isOpen) {
      document.addEventListener('keydown', handleKeyDown);
      return () => document.removeEventListener('keydown', handleKeyDown);
    }
  }, [isOpen, handleKeyDown]);

  const screens = useMemo(() => sources.filter((s) => s.isScreen), [sources]);
  const windows = useMemo(() => {
    const wins = sources.filter((s) => !s.isScreen);
    if (!search.trim()) return wins;
    const q = search.trim().toLowerCase();
    return wins.filter((w) => w.name.toLowerCase().includes(q));
  }, [sources, search]);

  if (!isOpen) return null;

  const activeSources = activeTab === 'screens' ? screens : windows;

  return (
    <div className="fixed inset-0 z-[200] flex items-center justify-center animate-fade-in">
      {/* Backdrop */}
      <div
        className="absolute inset-0 bg-black/50"
        onClick={() => closePicker(null)}
      />

      {/* Modal card */}
      <div className="relative w-full max-w-3xl mx-4 glass-modal rounded-lg animate-slide-up flex flex-col max-h-[calc(100vh-4rem)]">
        {/* Header */}
        <div className="flex items-center justify-between px-5 pt-5 pb-3 flex-shrink-0">
          <h2 className="text-lg font-bold text-txt-primary">Share Your Screen</h2>
          <button
            onClick={() => closePicker(null)}
            className="text-txt-tertiary hover:text-txt-primary transition-colors p-1"
          >
            <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor">
              <path d="M18.4 4L12 10.4L5.6 4L4 5.6L10.4 12L4 18.4L5.6 20L12 13.6L18.4 20L20 18.4L13.6 12L20 5.6L18.4 4Z" />
            </svg>
          </button>
        </div>

        {/* Tabs */}
        <div className="flex gap-1 px-5 pb-3 flex-shrink-0">
          <TabButton
            active={activeTab === 'screens'}
            onClick={() => { setActiveTab('screens'); setSelectedId(null); }}
            label="Screens"
            count={screens.length}
          />
          <TabButton
            active={activeTab === 'windows'}
            onClick={() => { setActiveTab('windows'); setSelectedId(null); }}
            label="Windows"
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
              placeholder="Search windows..."
              className="input-search w-full"
              autoFocus
            />
          </div>
        )}

        {/* Source grid */}
        <div className="flex-1 min-h-0 overflow-y-auto scrollbar-thin px-5 py-2">
          {activeSources.length === 0 ? (
            <div className="text-center py-12 text-txt-tertiary text-sm">
              {activeTab === 'windows' && search.trim()
                ? 'No windows match your search'
                : `No ${activeTab} available`}
            </div>
          ) : (
            <div className={`grid gap-3 ${activeTab === 'screens' ? 'grid-cols-2' : 'grid-cols-3'}`}>
              {activeSources.map((source) => (
                <SourceCard
                  key={source.id}
                  source={source}
                  selected={selectedId === source.id}
                  onClick={() => setSelectedId(source.id)}
                  onDoubleClick={() => closePicker(source.id, shareAudio)}
                />
              ))}
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="flex-shrink-0 flex flex-col items-center px-5 pt-2 pb-4">
          <div className="flex flex-col items-center gap-1 mb-2">
            <label className="flex items-center gap-2 cursor-pointer select-none">
              <input
                type="checkbox"
                checked={shareAudio}
                onChange={(e) => setScreenShareConfig({ shareAudio: e.target.checked })}
                className="w-3.5 h-3.5 rounded accent-accent-primary cursor-pointer"
              />
              <span className="text-[12px] text-txt-secondary">Share system audio</span>
            </label>
            {shareAudio && (
              <div className="text-[11px] text-accent-amber/80">
                Headphones recommended to prevent echo
              </div>
            )}
          </div>
          <div className="glass-bubble rounded-full px-3 py-2 flex items-center gap-3">
            <button
              onClick={() => closePicker(null)}
              className="px-3 py-1 text-sm text-txt-tertiary hover:text-txt-secondary transition-colors"
            >
              Cancel
            </button>
            <button
              onClick={() => closePicker(selectedId, shareAudio)}
              disabled={!selectedId}
              className="px-3 py-1.5 bg-accent-primary hover:bg-accent-primary-hover text-white text-sm font-medium rounded-full transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
            >
              Share
            </button>
          </div>
        </div>
      </div>
    </div>
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
