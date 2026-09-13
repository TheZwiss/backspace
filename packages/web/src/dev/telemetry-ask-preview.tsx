// Dev-only harness for the first-boot telemetry ask. Nothing in the app imports
// this file; `telemetry-ask.html` is its only entry, and that page exists so the
// modal can be looked at without registering an admin on a fresh instance.
import { useCallback, useState } from 'react';
import { createRoot } from 'react-dom/client';
import type { TelemetryPayload } from '@backspace/shared';
import { HelloModal } from '../components/telemetry/HelloModal';
import { SettingsSectionsProvider } from '../components/modals/SettingsSectionsContext';
import { SettingsTabBar } from '../components/modals/SettingsTabBar';
import { SidebarSubLinks } from '../components/modals/UserSettings';
import { useSettingsSections } from '../hooks/useSettingsSections';
import { initI18n } from '../i18n';
import { initializeInterfaceScale } from '../platform/interfaceScale';
import '../styles/globals.css';

/** Shaped like the preview endpoint's response, with the same two-significant-digit rounding. */
const SAMPLE_PAYLOAD: TelemetryPayload = {
  schema: 1,
  instance: '7f3c1a9e4b2d6058',
  day: new Date().toISOString().slice(0, 10),
  build: { version: '1.2.2', commit: '6c3b6b9e', modified: false },
  users: { registered: 42, active1d: 12, active7d: 28, active30d: 39 },
  clients: { web: 25, desktop: 16, mobile: 1 },
  content: { spaces: 3, channels: 17, messages: 8600, messages7d: 430, storageMiB: 1200 },
  features: { voice: true, federation: true, peers: 2, registrationOpen: false },
  runtime: { install: 'prebuilt', os: 'linux', arch: 'arm64', node: 20 },
  installedAt: '2026-04-18',
};


/** The instance sub-tabs exactly as InstancePanel registers them, with the
    telemetry entry carrying the invitation an unanswered instance shows. */
const NAV_SECTIONS = [
  { id: 'general', label: 'General' },
  { id: 'registration', label: 'Registration' },
  { id: 'federation', label: 'Federation' },
  { id: 'streaming', label: 'Streaming' },
  { id: 'storage', label: 'Storage' },
  { id: 'users', label: 'Users' },
  { id: 'updates', label: 'Updates' },
  { id: 'telemetry', label: 'Say hi', invite: true },
];

function NavPreview() {
  useSettingsSections(NAV_SECTIONS, { onNavigate: () => undefined, activeTab: 'general' });
  return (
    <div style={{ display: 'flex', gap: 32, alignItems: 'flex-start' }}>
      <div style={{ width: 232, background: 'rgb(var(--bg-channel))', borderRadius: 8, padding: 8 }}>
        {/* i18n-check: allow-literal */}
        <div style={{ fontSize: 13, color: 'rgb(var(--text-primary))', padding: '8px 12px' }}>Instance</div>
        <SidebarSubLinks />
      </div>
      <div style={{ flex: 1, minWidth: 0, maxWidth: 900 }}>
        <SettingsTabBar />
      </div>
    </div>
  );
}

type Answer = { enabled: boolean } | null;

function Harness() {
  // `?closed=1` starts with the ask dismissed, so the settings placements
  // behind it can be looked at on their own.
  const [open, setOpen] = useState(!new URLSearchParams(window.location.search).has('closed'));
  const [answer, setAnswer] = useState<Answer>(null);
  const [failSave, setFailSave] = useState(false);
  const [withPreview, setWithPreview] = useState(true);

  const onAnswer = useCallback(async (enabled: boolean): Promise<void> => {
    // The real store awaits a PUT, so the saving stage is visible here too.
    await new Promise((resolve) => setTimeout(resolve, 400));
    if (failSave) throw new Error('save failed');
    setAnswer({ enabled });
  }, [failSave]);

  const reopen = useCallback(() => {
    setAnswer(null);
    setOpen(true);
  }, []);

  return (
    <div className="min-h-screen p-8 space-y-4 text-sm text-txt-secondary">
      {/* i18n-check: allow-literal */}
      <h1 className="text-lg font-semibold text-txt-primary">Telemetry ask — dev preview</h1>
      <p>
        {/* i18n-check: allow-literal */}
        The modal below is the one an instance admin sees once, on first boot.
        Answering or dismissing it here changes nothing on any instance.
      </p>
      <div className="space-y-2">
        <label className="flex items-center gap-2">
          <input type="checkbox" checked={withPreview} onChange={(e) => setWithPreview(e.target.checked)} />
          {/* i18n-check: allow-literal */}
          Payload preview available (uncheck to see the fetch-failed text)
        </label>
        <label className="flex items-center gap-2">
          <input type="checkbox" checked={failSave} onChange={(e) => setFailSave(e.target.checked)} />
          {/* i18n-check: allow-literal */}
          Make saving the answer fail (shows the error on the ask)
        </label>
      </div>
      <p className="text-txt-tertiary">
        {answer === null ? 'No answer recorded yet.' : `Answered: ${answer.enabled ? 'yes' : 'no'}`}
      </p>
      {!open && (
        <button
          type="button"
          className="px-4 py-2 rounded-lg bg-surface-elevated hover:bg-interactive-selected text-txt-primary"
          onClick={reopen}
        >
          Show the ask again
        </button>
      )}
      <SettingsSectionsProvider>
        <NavPreview />
      </SettingsSectionsProvider>
      <HelloModal
        open={open}
        onAnswer={onAnswer}
        onDismiss={() => setOpen(false)}
        preview={withPreview ? SAMPLE_PAYLOAD : null}
        previewFailed={!withPreview}
      />
    </div>
  );
}

async function start(): Promise<void> {
  initializeInterfaceScale();
  await initI18n();
  const host = document.getElementById('root');
  if (!host) throw new Error('missing #root');
  createRoot(host).render(<Harness />);
}

void start();
