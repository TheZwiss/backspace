import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';

// Stub AudioManager to avoid AudioWorkletNode reference error in jsdom. The
// hook imports exploreStore, which transitively pulls in spaceStore ->
// AudioManager; the audio worklet is unavailable under jsdom.
vi.mock('../audio/AudioManager', () => ({
  AudioManager: {
    getInstance: vi.fn().mockReturnValue({
      setOutputDevice: vi.fn(),
      setVolume: vi.fn(),
    }),
  },
}));

import { useSpaceJoin } from './useSpaceJoin';
import { useExploreStore, type TaggedExploreSpace } from '../stores/exploreStore';

function makeSpace(overrides: Partial<TaggedExploreSpace> = {}): TaggedExploreSpace {
  return {
    id: 's1',
    name: 'Test Space',
    icon: null,
    banner: null,
    avatarColor: null,
    description: null,
    visibility: 'public',
    memberCount: 3,
    createdAt: 0,
    joined: false,
    _instanceOrigin: '',
    ...overrides,
  };
}

beforeEach(() => {
  useExploreStore.setState({
    myRequests: [],
    publicJoin: vi.fn().mockResolvedValue({ id: 's1', name: 'Test Space' }),
    requestJoin: vi.fn().mockResolvedValue({ id: 'req1', spaceId: 's1', status: 'pending' }),
  });
});

describe('useSpaceJoin', () => {
  it('reports public/joined/pending flags from the space and store', () => {
    const { result } = renderHook(() => useSpaceJoin(makeSpace()));
    expect(result.current.isPublic).toBe(true);
    expect(result.current.isJoined).toBe(false);
    expect(result.current.isPending).toBe(false);
  });

  it('derives isPending from a matching pending request in the store', () => {
    useExploreStore.setState({
      myRequests: [{ id: 'r', spaceId: 's1', status: 'pending', _instanceOrigin: '' } as never],
    });
    const { result } = renderHook(() => useSpaceJoin(makeSpace({ visibility: 'request' })));
    expect(result.current.isPending).toBe(true);
  });

  it('isPending is keyed by (origin, spaceId): the same id on another origin is not pending', () => {
    const remote = 'https://chat.example.org';
    useExploreStore.setState({
      myRequests: [{ id: 'r', spaceId: 's1', status: 'pending', _instanceOrigin: remote } as never],
    });

    const { result: onRemote } = renderHook(() =>
      useSpaceJoin(makeSpace({ visibility: 'request', _instanceOrigin: remote })),
    );
    expect(onRemote.current.isPending).toBe(true);

    const { result: onHome } = renderHook(() =>
      useSpaceJoin(makeSpace({ visibility: 'request', _instanceOrigin: '' })),
    );
    expect(onHome.current.isPending).toBe(false);

    const { result: onOther } = renderHook(() =>
      useSpaceJoin(makeSpace({ visibility: 'request', _instanceOrigin: 'https://other.example.org' })),
    );
    expect(onOther.current.isPending).toBe(false);
  });

  it('ignores a request whose origin matches but whose status is not pending', () => {
    useExploreStore.setState({
      myRequests: [{ id: 'r', spaceId: 's1', status: 'declined', _instanceOrigin: '' } as never],
    });
    const { result } = renderHook(() => useSpaceJoin(makeSpace({ visibility: 'request' })));
    expect(result.current.isPending).toBe(false);
  });

  it('join() calls publicJoin and returns the full space', async () => {
    const { result } = renderHook(() => useSpaceJoin(makeSpace()));
    let full: unknown;
    await act(async () => { full = await result.current.join(); });
    expect(useExploreStore.getState().publicJoin).toHaveBeenCalled();
    expect((full as { id: string }).id).toBe('s1');
  });

  it('join() surfaces an error and returns null on failure', async () => {
    useExploreStore.setState({ publicJoin: vi.fn().mockRejectedValue(new Error('nope')) });
    const { result } = renderHook(() => useSpaceJoin(makeSpace()));
    let full: unknown = 'unset';
    await act(async () => { full = await result.current.join(); });
    expect(full).toBeNull();
    expect(result.current.joinError).toBe('nope');
    expect(result.current.joining).toBe(false);
  });

  it('openRequestForm/cancelRequestForm toggle showRequestForm', () => {
    const { result } = renderHook(() => useSpaceJoin(makeSpace({ visibility: 'request' })));
    expect(result.current.showRequestForm).toBe(false);
    act(() => result.current.openRequestForm());
    expect(result.current.showRequestForm).toBe(true);
    act(() => result.current.cancelRequestForm());
    expect(result.current.showRequestForm).toBe(false);
  });

  it('sendRequest() calls requestJoin and flips to pending', async () => {
    const { result } = renderHook(() => useSpaceJoin(makeSpace({ visibility: 'request' })));
    act(() => result.current.setRequestMessage('  please  '));
    await act(async () => { await result.current.sendRequest(); });
    expect(useExploreStore.getState().requestJoin).toHaveBeenCalledWith(
      expect.objectContaining({ id: 's1' }), 'please',
    );
    await waitFor(() => expect(result.current.isPending).toBe(true));
    expect(result.current.showRequestForm).toBe(false);
  });
});
