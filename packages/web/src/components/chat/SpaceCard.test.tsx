import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import type { DirectoryEntry } from '@backspace/shared';
import type { SpaceJoinControls } from '../../hooks/useSpaceJoin';
import { SpaceCard } from './SpaceCard';

// The Inner join state machine is not under test here: the outer branch must
// never reach for its actions, so the hook is replaced by inert controls whose
// spies prove that.
const { controls, useSpaceJoin } = vi.hoisted(() => {
  const controls = {
    isJoined: false,
    isPublic: true,
    isPending: false,
    joining: false,
    joinError: '',
    showRequestForm: false,
    requestMessage: '',
    setRequestMessage: vi.fn(),
    openRequestForm: vi.fn(),
    cancelRequestForm: vi.fn(),
    join: vi.fn(async () => null),
    sendRequest: vi.fn(async () => {}),
  };
  return { controls, useSpaceJoin: vi.fn(() => controls) };
});

vi.mock('../../hooks/useSpaceJoin', () => ({ useSpaceJoin }));

function entry(overrides: Partial<DirectoryEntry> = {}): DirectoryEntry {
  return {
    id: 'space-1',
    name: 'Nebula',
    description: 'A quiet corner',
    icon: null,
    banner: null,
    avatarColor: null,
    visibility: 'public',
    memberCount: 12,
    createdAt: 1,
    origin: 'https://orbit.example',
    instanceName: 'Orbit',
    federatedRegistrationOpen: true,
    ...overrides,
  };
}

function renderOuter(e: DirectoryEntry, onConnect = vi.fn()) {
  const view = render(
    <SpaceCard
      space={{ ...e, _instanceOrigin: e.origin, joined: false }}
      onJoinSuccess={vi.fn()}
      outer={{ entry: e, onConnect }}
    />,
  );
  return { ...view, onConnect };
}

describe('SpaceCard outer branch', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    controls.isPublic = true;
  });

  it('always renders the origin chip', () => {
    renderOuter(entry());
    expect(screen.getByText('orbit.example')).toBeInTheDocument();
  });

  it('shows the closed badge only when federated registration is closed', () => {
    const { unmount } = renderOuter(entry({ federatedRegistrationOpen: false }));
    expect(screen.getByText('Closed to new accounts')).toBeInTheDocument();
    unmount();

    renderOuter(entry({ federatedRegistrationOpen: true }));
    expect(screen.queryByText('Closed to new accounts')).not.toBeInTheDocument();
  });

  it('labels the action "Connect and join" for a public space', () => {
    renderOuter(entry({ visibility: 'public' }));
    expect(screen.getByRole('button', { name: 'Connect and join' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Join Space' })).not.toBeInTheDocument();
  });

  it('labels the action "Connect and request" for a request space', () => {
    controls.isPublic = false;
    renderOuter(entry({ visibility: 'request' }));
    expect(screen.getByRole('button', { name: 'Connect and request' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Request to Join' })).not.toBeInTheDocument();
  });

  it('calls onConnect with the entry and never the Inner join actions', () => {
    const e = entry();
    const { onConnect } = renderOuter(e);
    fireEvent.click(screen.getByRole('button', { name: 'Connect and join' }));
    expect(onConnect).toHaveBeenCalledTimes(1);
    expect(onConnect).toHaveBeenCalledWith(e);
    expect(controls.join).not.toHaveBeenCalled();
    expect(controls.openRequestForm).not.toHaveBeenCalled();
    expect(controls.sendRequest).not.toHaveBeenCalled();
  });

  it('keeps the Inner action for a card without outer', () => {
    const e = entry();
    render(
      <SpaceCard space={{ ...e, _instanceOrigin: '', joined: false }} onJoinSuccess={vi.fn()} />,
    );
    expect(screen.getByRole('button', { name: 'Join Space' })).toBeInTheDocument();
    expect(screen.queryByText('Closed to new accounts')).not.toBeInTheDocument();
  });
});

// Keep the hook's return type honest: a field added to SpaceJoinControls has to
// be added to the stub above or this file stops compiling.
const _typeCheck: SpaceJoinControls = controls;
void _typeCheck;
