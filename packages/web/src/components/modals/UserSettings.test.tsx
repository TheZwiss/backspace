import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import type { InstanceInfoResponse, User } from '@backspace/shared';

// ── Fixtures and store mocks ────────────────────────────────────────────────
// The modal reads four stores through selectors. Each is mocked with the
// selector-aware callable idiom used across the web suite
// (settingsPanels/AccountPanel.detachedNotice.test.tsx), so a selector gets the
// fixture state and `getState()` keeps working for anything that reaches for it
// outside a render. Everything a `vi.mock` factory touches lives in `vi.hoisted`,
// because those factories run before module-level `const`s are initialised.
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
    ui: {
      activeModal: 'userSettings',
      modalData: {} as Record<string, unknown>,
      isMobile: false,
      closeModal: vi.fn(),
      addToast: vi.fn(),
    },
    auth: { user, logout: vi.fn() },
    // useInstanceUpdateBadge reads these three; no update is pending, so no dot.
    settings: {
      updateStatus: null,
      updateAck: { seenVersion: null, toastShownFor: null },
      isAdmin: false,
    },
    instanceInfo,
    // The update store the Electron panel consumes, copied from
    // settingsPanels/DesktopPanel.test.tsx.
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

// Every sibling panel is stubbed, so this test renders only the modal chrome and
// whichever of the two Desktop panels the wiring picks.
vi.mock('./settingsPanels/AccountPanel', () => ({ AccountPanel: () => null }));
vi.mock('./settingsPanels/AppearancePanel', () => ({ AppearancePanel: () => null }));
vi.mock('./settingsPanels/VoicePanel', () => ({ VoicePanel: () => null }));
vi.mock('./settingsPanels/PrivacyPanel', () => ({ PrivacyPanel: () => null }));
vi.mock('./settingsPanels/ConnectionsPanel', () => ({ ConnectionsPanel: () => null }));
vi.mock('./settingsPanels/KeybindsPanel', () => ({ KeybindsPanel: () => null }));
vi.mock('./settingsPanels/InstancePanel', () => ({ InstancePanel: () => null }));

import { UserSettingsModal } from './UserSettings';

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
 * Renders the modal and waits for the instance info fetch to land, so the
 * assertions that follow run against a settled tree.
 */
async function openSettings(): Promise<void> {
  render(<UserSettingsModal />);
  await screen.findByRole('link', { name: /Source code/i });
}

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  cleanup();
  Reflect.deleteProperty(window as unknown as Record<string, unknown>, 'backspace');
});

describe('UserSettingsModal Desktop tab', () => {
  it('shows the download offer in the browser', async () => {
    await openSettings();

    const tab = screen.getByRole('button', { name: 'Desktop' });
    // The tab belongs to App Settings, after the keybinds entry of that group.
    const appSettings = screen.getByText('App Settings');
    expect(appSettings.compareDocumentPosition(tab) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();

    fireEvent.click(tab);

    expect(await screen.findByRole('link', { name: 'All releases' })).toBeInTheDocument();
    // The Electron-only panel stays out of the browser.
    expect(screen.queryByRole('button', { name: 'Change Instance' })).not.toBeInTheDocument();
  });

  it('shows the desktop app settings inside Electron', async () => {
    installDesktopHost();
    await openSettings();

    fireEvent.click(screen.getByRole('button', { name: 'Desktop' }));

    // Both panels carry the same "Desktop" title, so the instance control is
    // what tells them apart.
    expect(await screen.findByRole('heading', { name: 'Desktop' })).toBeInTheDocument();
    expect(await screen.findByRole('button', { name: 'Change Instance' })).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'All releases' })).not.toBeInTheDocument();
  });
});
