import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react';
import type { User } from '@backspace/shared';

// ── Store mocks ─────────────────────────────────────────────────────────────
// AccountPanel reads its self user from `useAuthStore((s) => s.user)`. We drive
// that user through a mutable fixture and mock the store with a selector-aware
// callable (mirrors the selector-mock idiom used across the web test suite).
let currentUser: User | null = null;
// Instances backing the re-attach fallback action — mutated per test.
let currentInstances: unknown[] = [];
const noop = vi.fn();
const setUserMock = vi.fn();
// The peer re-attach call (primary `api.users.reattach`), asserted by the
// two-step-confirm test.
const mockReattach = vi.fn();

interface AuthState {
  user: User | null;
  updateProfile: (...args: unknown[]) => unknown;
  changePassword: (...args: unknown[]) => unknown;
  setUser: (user: User) => void;
}

vi.mock('../../../stores/authStore', () => ({
  useAuthStore: Object.assign(
    (selector: (s: AuthState) => unknown) =>
      selector({ user: currentUser, updateProfile: noop, changePassword: noop, setUser: setUserMock }),
    {
      getState: (): AuthState => ({ user: currentUser, updateProfile: noop, changePassword: noop, setUser: setUserMock }),
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
    (selector: (s: { instances: unknown[] }) => unknown) => selector({ instances: currentInstances }),
    { getState: () => ({ instances: currentInstances }), setState: vi.fn(), subscribe: vi.fn() },
  ),
}));

vi.mock('../../../stores/transferStore', () => ({
  useTransferStore: Object.assign(
    (selector: (s: unknown) => unknown) => selector({}),
    { getState: () => ({ startUpload: noop, transfers: new Map() }), setState: vi.fn(), subscribe: vi.fn() },
  ),
}));

// api.uploads.url is referenced during render for avatar/banner sources;
// api.users.reattach is the peer call the fallback action fires on confirm.
vi.mock('../../../api/client', () => ({
  // reattach is wrapped so the top-level `mockReattach` const is dereferenced
  // lazily at call time (vi.mock factories are hoisted above const init).
  api: { uploads: { url: (f: string) => `/api/uploads/${f}` }, users: { reattach: (...args: unknown[]) => mockReattach(...args) } },
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

// A connected home-domain instance carrying the proof-mint API surface the
// fallback action calls. Only the fields AccountPanel touches are populated.
function makeHomeConnection(overrides: {
  origin?: string;
  username?: string;
  attachProof?: ReturnType<typeof vi.fn>;
} = {}) {
  return {
    origin: overrides.origin ?? 'https://orbit.test',
    username: overrides.username ?? 'youruser',
    status: 'connected' as const,
    api: { auth: { attachProof: overrides.attachProof ?? vi.fn() } },
  };
}

beforeEach(() => {
  cleanup();
  currentUser = null;
  currentInstances = [];
  setUserMock.mockReset();
  mockReattach.mockReset();
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

describe('AccountPanel re-attach fallback action', () => {
  it('shows the re-attach action when a connection to the home domain exists', () => {
    currentUser = makeUser({ username: 'youruser@orbit.test', federationHomeOrphaned: true, homeInstance: 'orbit.test' });
    currentInstances = [makeHomeConnection()];
    render(<AccountPanel />);
    expect(screen.getByRole('button', { name: /re-attach to orbit\.test/i })).toBeInTheDocument();
  });

  it('hides the re-attach action without a home-domain connection', () => {
    currentUser = makeUser({ username: 'youruser@orbit.test', federationHomeOrphaned: true, homeInstance: 'orbit.test' });
    currentInstances = [];
    render(<AccountPanel />);
    expect(screen.queryByRole('button', { name: /re-attach/i })).not.toBeInTheDocument();
    // Informational copy still present:
    expect(screen.getByText(/detached from its home instance/i)).toBeInTheDocument();
  });

  it('two-step confirm: first click arms, second click mints proof and calls reattach', async () => {
    currentUser = makeUser({ username: 'youruser@orbit.test', federationHomeOrphaned: true, homeInstance: 'orbit.test' });
    const attachProof = vi.fn().mockResolvedValue({ token: 'a'.repeat(64) });
    currentInstances = [makeHomeConnection({ attachProof })];
    mockReattach.mockResolvedValue({ success: true, user: makeUser({ username: 'youruser@orbit.test', federationHomeOrphaned: false, homeInstance: 'orbit.test' }) });

    render(<AccountPanel />);
    fireEvent.click(screen.getByRole('button', { name: /re-attach to orbit\.test/i }));
    fireEvent.click(screen.getByRole('button', { name: /confirm re-attach/i }));
    await waitFor(() => expect(mockReattach).toHaveBeenCalledWith({ token: 'a'.repeat(64) }));
    expect(attachProof).toHaveBeenCalled();
  });
});
