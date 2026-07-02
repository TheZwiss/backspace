import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import type { User } from '@backspace/shared';

// ── Store mocks ─────────────────────────────────────────────────────────────
// AccountPanel reads its self user from `useAuthStore((s) => s.user)`. We drive
// that user through a mutable fixture and mock the store with a selector-aware
// callable (mirrors the selector-mock idiom used across the web test suite).
let currentUser: User | null = null;
const noop = vi.fn();

interface AuthState {
  user: User | null;
  updateProfile: (...args: unknown[]) => unknown;
  changePassword: (...args: unknown[]) => unknown;
}

vi.mock('../../../stores/authStore', () => ({
  useAuthStore: Object.assign(
    (selector: (s: AuthState) => unknown) =>
      selector({ user: currentUser, updateProfile: noop, changePassword: noop }),
    {
      getState: (): AuthState => ({ user: currentUser, updateProfile: noop, changePassword: noop }),
      setState: vi.fn(),
      subscribe: vi.fn(),
    },
  ),
}));

vi.mock('../../../stores/uiStore', () => ({
  useUIStore: Object.assign(
    (selector: (s: { addToast: (...args: unknown[]) => void }) => unknown) =>
      selector({ addToast: noop }),
    { getState: () => ({ addToast: noop }), setState: vi.fn(), subscribe: vi.fn() },
  ),
}));

vi.mock('../../../stores/instanceStore', () => ({
  useInstanceStore: Object.assign(
    (selector: (s: { instances: unknown[] }) => unknown) => selector({ instances: [] }),
    { getState: () => ({ instances: [] }), setState: vi.fn(), subscribe: vi.fn() },
  ),
}));

vi.mock('../../../stores/transferStore', () => ({
  useTransferStore: Object.assign(
    (selector: (s: unknown) => unknown) => selector({}),
    { getState: () => ({ startUpload: noop, transfers: new Map() }), setState: vi.fn(), subscribe: vi.fn() },
  ),
}));

// api.uploads.url is referenced during render for avatar/banner sources.
vi.mock('../../../api/client', () => ({
  api: { uploads: { url: (f: string) => `/api/uploads/${f}` } },
}));

// Child modals are closed in these render cases; stub them so their transitive
// store imports don't participate in this isolated component render.
vi.mock('../../ui/ImageCropModal', () => ({ ImageCropModal: () => null }));
vi.mock('../DeleteAccountModal', () => ({ DeleteAccountModal: () => null }));

import { AccountPanel } from './AccountPanel';

// ── Fixtures ────────────────────────────────────────────────────────────────
function makeUser(overrides: Partial<User> = {}): User {
  return {
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
    ...overrides,
  };
}

const NOTICE = /This account is detached from its home instance\./i;

beforeEach(() => {
  cleanup();
  currentUser = null;
});

describe('AccountPanel detached-account notice', () => {
  it('renders the notice when the account is detached and carries a home instance', () => {
    currentUser = makeUser({ federationHomeOrphaned: true, homeInstance: 'old.example.net' });
    render(<AccountPanel />);
    expect(screen.getByText(NOTICE)).toBeInTheDocument();
    // Names the lost home instance so the owner understands what happened.
    expect(screen.getByText(/old\.example\.net/)).toBeInTheDocument();
  });

  it('does not render the notice for a non-detached federated account', () => {
    currentUser = makeUser({ federationHomeOrphaned: false, homeInstance: 'live.example.net' });
    render(<AccountPanel />);
    expect(screen.queryByText(NOTICE)).not.toBeInTheDocument();
  });

  it('does not render the notice for a normal local account (no home instance)', () => {
    currentUser = makeUser({ federationHomeOrphaned: true, homeInstance: null });
    render(<AccountPanel />);
    expect(screen.queryByText(NOTICE)).not.toBeInTheDocument();
  });
});
