import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import type { InstanceInfoResponse, User } from '@backspace/shared';

// The screen reads three stores through selectors, and the panel it opens reads
// a fourth. Each is mocked with the selector-aware callable idiom used across
// the web suite (modals/UserSettings.test.tsx). Everything a `vi.mock` factory
// touches lives in `vi.hoisted`, because those factories run before module-level
// `const`s are initialised.
const mocks = vi.hoisted(() => {
  const user: User = {
    id: 'user-self',
    username: 'me',
    displayName: 'Me',
    avatar: null,
    banner: null,
    accentColor: null,
    avatarColor: null,
    bio: null,
    status: 'online',
    customStatus: null,
    isAdmin: false,
    createdAt: 0,
    homeInstance: null,
    homeUserId: null,
    replicatedInstances: [],
  };

  const instanceInfo: InstanceInfoResponse = {
    name: 'Test Instance',
    version: '1.2.1',
    registrationOpen: true,
    federatedRegistrationOpen: true,
    instanceId: 'instance-1',
    sourceCodeUrl: 'https://github.com/TheZwiss/backspace',
    commit: 'abc1234',
  };

  return {
    ui: { pushMobileScreen: vi.fn(), popMobileScreen: vi.fn() },
    auth: { user },
    // useInstanceUpdateBadge reads these three; no update is pending, so no dot.
    settings: {
      updateStatus: null,
      updateAck: { seenVersion: null, toastShownFor: null },
      isAdmin: false,
    },
    instanceInfo,
    // The update store the Electron panel consumes, copied from
    // ../modals/settingsPanels/DesktopPanel.test.tsx.
    update: {
      initialize: vi.fn(),
      snapshot: {
        capability: 'external' as const,
        dismissedVersion: null,
        status: { phase: 'idle' as const },
      },
      currentVersion: '1.0.5',
      checkNow: vi.fn(),
      install: vi.fn(),
      openDownloadPage: vi.fn(),
    },
  };
});

vi.mock('../../stores/uiStore', () => ({
  useUIStore: Object.assign(
    (selector: (s: typeof mocks.ui) => unknown) => selector(mocks.ui),
    { getState: () => mocks.ui, setState: vi.fn(), subscribe: vi.fn() },
  ),
}));

vi.mock('../../stores/authStore', () => ({
  useAuthStore: Object.assign(
    (selector: (s: typeof mocks.auth) => unknown) => selector(mocks.auth),
    { getState: () => mocks.auth, setState: vi.fn(), subscribe: vi.fn() },
  ),
}));

vi.mock('../../stores/settingsStore', () => ({
  useSettingsStore: Object.assign(
    (selector: (s: typeof mocks.settings) => unknown) => selector(mocks.settings),
    { getState: () => mocks.settings, setState: vi.fn(), subscribe: vi.fn() },
  ),
}));

vi.mock('../../stores/updateStore', () => ({
  useUpdateStore: (selector: (s: typeof mocks.update) => unknown) => selector(mocks.update),
}));

vi.mock('../../api/client', () => ({
  api: { instance: { info: () => Promise.resolve(mocks.instanceInfo) } },
}));

// Only the two Desktop panels are exercised here, so every other panel and the
// transfer tray are stubbed out.
vi.mock('./TransferIndicator', () => ({ TransferIndicator: () => null }));
vi.mock('../modals/settingsPanels/AccountPanel', () => ({ AccountPanel: () => null }));
vi.mock('../modals/settingsPanels/AppearancePanel', () => ({ AppearancePanel: () => null }));
vi.mock('../modals/settingsPanels/VoicePanel', () => ({ VoicePanel: () => null }));
vi.mock('../modals/settingsPanels/PrivacyPanel', () => ({ PrivacyPanel: () => null }));
vi.mock('../modals/settingsPanels/ConnectionsPanel', () => ({ ConnectionsPanel: () => null }));
vi.mock('../modals/settingsPanels/KeybindsPanel', () => ({ KeybindsPanel: () => null }));

import { MobileSettingsScreen } from './MobileSettingsScreen';

/** The preload bridge whose presence is what `isElectron()` reads. */
function installDesktopHost() {
  Object.defineProperty(window, 'backspace', {
    configurable: true,
    writable: true,
    value: {
      isSandboxed: vi.fn().mockResolvedValue(false),
      getAutoLaunchSettings: vi.fn().mockResolvedValue({ openAtLogin: false, startMinimized: true }),
      setAutoLaunchSettings: vi.fn(),
      clearInstanceUrl: vi.fn(),
    },
  });
}

/**
 * Taps the hub's Desktop entry and renders the screen it pushes, the way
 * MobileShell routes `settings-desktop` back into this component.
 */
function openDesktopPanel(): void {
  fireEvent.click(screen.getByRole('button', { name: 'Desktop' }));
  expect(mocks.ui.pushMobileScreen).toHaveBeenCalledWith('settings-desktop');
  cleanup();
  render(<MobileSettingsScreen initialPanel="desktop" />);
}

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  cleanup();
  Reflect.deleteProperty(window as unknown as Record<string, unknown>, 'backspace');
});

describe('MobileSettingsScreen Desktop entry', () => {
  it('opens the download offer in the browser', async () => {
    render(<MobileSettingsScreen />);

    // Desktop is listed outside Electron; Keybinds still is not.
    expect(screen.getByRole('button', { name: 'Desktop' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Keybinds' })).not.toBeInTheDocument();

    openDesktopPanel();

    expect(await screen.findByRole('link', { name: 'All releases on GitHub' })).toBeInTheDocument();
    // The version reaches the panel, so the links name release assets.
    expect(await screen.findByRole('link', { name: 'Download for Windows' })).toHaveAttribute(
      'href',
      'https://github.com/TheZwiss/backspace/releases/download/v1.2.1/Backspace-1.2.1-win-x64.exe',
    );
    // The Electron-only panel stays out of the browser.
    expect(screen.queryByRole('button', { name: 'Change Instance' })).not.toBeInTheDocument();
  });

  it('opens the desktop app settings inside Electron', async () => {
    installDesktopHost();
    render(<MobileSettingsScreen />);

    expect(screen.getByRole('button', { name: 'Keybinds' })).toBeInTheDocument();

    openDesktopPanel();

    // Both panels carry the same "Desktop" header, so the instance control is
    // what tells them apart.
    expect(await screen.findByRole('button', { name: 'Change Instance' })).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'All releases on GitHub' })).not.toBeInTheDocument();
  });
});
