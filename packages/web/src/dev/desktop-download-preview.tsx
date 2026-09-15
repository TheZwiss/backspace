// Dev-only workbench for the desktop download panel. Nothing in the app imports
// this file; `dev-desktop-download.html` is its only entry. It exists so the
// panel can be looked at and screenshotted for every platform it detects,
// without owning five machines.
//
// `?os=windows|mac|linux|other` picks the platform the detector will see, and
// `&guessed=1` withholds the architecture client hint so the panel falls to the
// platform default and shows the note that admits the guess.
import { createRoot } from 'react-dom/client';
import { DesktopDownloadPanel } from '../components/modals/settingsPanels/DesktopDownloadPanel';
import { initI18n } from '../i18n';
import { initializeInterfaceScale } from '../platform/interfaceScale';
import '../styles/globals.css';

type PreviewOs = 'windows' | 'mac' | 'linux' | 'other';

/** The `platform` value Chromium reports for each case, `other` standing in for a phone. */
const HINT_PLATFORMS: Record<PreviewOs, string> = {
  windows: 'Windows',
  mac: 'macOS',
  linux: 'Linux',
  other: 'Android',
};

interface HintNavigator extends Navigator {
  userAgentData?: {
    platform?: string;
    mobile?: boolean;
    getHighEntropyValues?: (hints: string[]) => Promise<Record<string, unknown>>;
  };
}

function readOs(search: string): PreviewOs {
  const value = new URLSearchParams(search).get('os');
  if (value === 'windows' || value === 'mac' || value === 'linux' || value === 'other') return value;
  return 'mac';
}

/**
 * The architecture the browser would report on a typical machine of each kind.
 * The brief's non-guessed Mac is Apple Silicon; a Linux or Windows desktop is
 * far more likely to be x64, and the architecture is what the picker starts on.
 */
const HINT_ARCHITECTURES: Record<PreviewOs, string> = {
  windows: 'x86',
  mac: 'arm',
  linux: 'x86',
  other: 'arm',
};

/**
 * Installs the client hints the detector reads. Without `getHighEntropyValues`
 * the detector has no architecture to go on and falls to the platform default,
 * which is exactly the `archGuessed` case.
 */
function installNavigatorHints(os: PreviewOs, guessed: boolean): void {
  const hints: HintNavigator['userAgentData'] = {
    platform: HINT_PLATFORMS[os],
    mobile: os === 'other',
  };
  if (!guessed) {
    hints.getHighEntropyValues = () =>
      Promise.resolve({ architecture: HINT_ARCHITECTURES[os], bitness: '64' });
  }
  Object.defineProperty(window.navigator, 'userAgentData', {
    value: hints,
    configurable: true,
    writable: true,
  });
}

/** The settings modal's content column, at the width it has on a desktop window and on a phone. */
function Column({ width, caption }: { width: number; caption: string }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      <span style={{ fontSize: 11, color: 'rgb(var(--text-tertiary))' }}>{caption}</span>
      <div className="bg-surface-channel p-8" style={{ width, borderRadius: 12 }}>
        <DesktopDownloadPanel version="1.3.0" />
      </div>
    </div>
  );
}

function Workbench({ os, guessed }: { os: PreviewOs; guessed: boolean }) {
  return (
    <div
      style={{
        minHeight: 'calc(100 * var(--app-vh))',
        background: 'rgb(var(--bg-chat))',
        padding: 40,
        display: 'flex',
        flexDirection: 'column',
        gap: 40,
      }}
    >
      <Column width={720} caption={`os=${os}${guessed ? ' guessed' : ''}, 720px content column`} />
      <Column width={380} caption="380px, the stacked layout" />
    </div>
  );
}

async function start(): Promise<void> {
  const os = readOs(window.location.search);
  const guessed = new URLSearchParams(window.location.search).get('guessed') === '1';
  installNavigatorHints(os, guessed);
  initializeInterfaceScale();
  await initI18n();
  const host = document.getElementById('root');
  if (!host) throw new Error('missing #root');
  createRoot(host).render(<Workbench os={os} guessed={guessed} />);
}

void start();
