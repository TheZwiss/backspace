import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DmChannel } from '@backspace/shared';

// jsdom has no AudioWorkletNode; the handler's imports reach the voice stack.
vi.mock('../audio/AudioManager', () => ({
  AudioManager: {
    getInstance: vi.fn().mockReturnValue({
      setOutputDevice: vi.fn(),
      setVolume: vi.fn(),
      playSound: vi.fn(() => Promise.resolve(null)),
      clearInputDenial: vi.fn(),
      resumeContext: vi.fn(() => Promise.resolve()),
      setInputDevice: vi.fn(() => Promise.resolve(null)),
    }),
  },
}));
vi.mock('../hooks/useMascotAnimation', () => ({ useMascotAnimation: vi.fn() }));

/** A socket the real handler talks to; the test plays the server through `deliver`. */
class FakeWebSocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;
  static all: FakeWebSocket[] = [];
  readyState = FakeWebSocket.CONNECTING;
  onopen: (() => void) | null = null;
  onmessage: ((e: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  constructor(public url: string) { FakeWebSocket.all.push(this); }
  send(): void {}
  close(): void { this.readyState = FakeWebSocket.CLOSED; }
  open(): void { this.readyState = FakeWebSocket.OPEN; this.onopen?.(); }
  deliver(event: Record<string, unknown>): void {
    this.onmessage?.({ data: JSON.stringify(event) });
  }
}

class InertWorker {
  onmessage: (() => void) | null = null;
  postMessage(): void {}
  terminate(): void {}
}

vi.stubGlobal('WebSocket', FakeWebSocket);
vi.stubGlobal('Worker', InertWorker);
vi.stubGlobal('URL', Object.assign(URL, { createObjectURL: () => 'blob:heartbeat', revokeObjectURL: () => {} }));

const { connectInstance, disconnectInstance, dmCallEventIsOurs } = await import('./useWebSocket');
const { useSpaceStore } = await import('../stores/spaceStore');
const { useUIStore } = await import('../stores/uiStore');
const { useVoiceStore } = await import('../stores/voiceStore');
const { startDmCall } = await import('../utils/voiceActions');
const { initI18n } = await import('../i18n');
const i18n = (await import('../i18n')).default;

// #415: a dm_call_start the server refuses must not leave the client in its
// calling state (which keeps the outgoing ring playing), and the end of one
// DM's call must not tear down a different call the client is in.

const GROUP = 'dm-group';
const OTHER = 'dm-other';

/** A call the client is in, held by its DM id through the DM's own instance. */
function active(dmChannelId: string) {
  return { dmChannelId, federatedCallId: null, callOrigin: null, livekit: null };
}

/** A call this client is placing. */
function outgoing(dmChannelId: string) {
  return { dmChannelId, withCamera: false };
}

function dm(id: string, federatedId: string | null): DmChannel {
  return { id, federatedId, members: [], ownerId: 'owner' } as unknown as DmChannel;
}

const opened: string[] = [];
function homeSocket(): FakeWebSocket {
  connectInstance('', 'token-home');
  opened.push('');
  const ws = FakeWebSocket.all.at(-1)!;
  ws.open();
  return ws;
}

beforeEach(async () => {
  await initI18n();
  FakeWebSocket.all = [];
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'log').mockImplementation(() => {});
  useUIStore.setState({ toasts: [] });
  useSpaceStore.setState({
    dmChannels: [dm(GROUP, 'key-group'), dm(OTHER, null)],
    channelOriginMap: new Map(),
  });
  useVoiceStore.setState({
    outgoingCall: null,
    incomingCall: null,
    activeDmCall: null,
    currentVoiceChannelId: null,
    isLiveKitConnected: false,
    voiceUsers: new Map(),
    disconnectFn: null,
    connectFn: null,
  });
});

afterEach(() => {
  for (const origin of opened.splice(0)) disconnectInstance(origin);
  vi.restoreAllMocks();
});

describe('a refused dm_call_start', () => {
  it('clears the calling state and says why', () => {
    const ws = homeSocket();
    expect(startDmCall(GROUP)).toBe(true);
    expect(useVoiceStore.getState().outgoingCall).toEqual(outgoing(GROUP));

    ws.deliver({ type: 'error', message: 'A call is already running in this conversation', code: 'dm_call_in_progress', dmChannelId: GROUP });

    expect(useVoiceStore.getState().outgoingCall).toBeNull();
    const toasts = useUIStore.getState().toasts;
    expect(toasts).toHaveLength(1);
    expect(toasts[0]!.message).toBe(i18n.t('errors:dm_call_in_progress'));
  });

  it('keeps a call being placed in another DM', () => {
    const ws = homeSocket();
    startDmCall(GROUP);

    ws.deliver({ type: 'error', message: 'refused', code: 'dm_call_in_progress', dmChannelId: OTHER });

    expect(useVoiceStore.getState().outgoingCall).toEqual(outgoing(GROUP));
  });

  it('ignores a refusal from an instance that does not serve the DM', () => {
    const ws = homeSocket();
    useSpaceStore.setState({ channelOriginMap: new Map([[GROUP, 'https://remote.example']]) });
    useVoiceStore.setState({ outgoingCall: outgoing(GROUP) });

    ws.deliver({ type: 'error', message: 'refused', code: 'dm_call_in_progress', dmChannelId: GROUP });

    expect(useVoiceStore.getState().outgoingCall).toEqual(outgoing(GROUP));
  });
});

describe('the end of a DM call', () => {
  it('tears down the call the client is in', () => {
    const ws = homeSocket();
    const disconnectFn = vi.fn().mockResolvedValue(undefined);
    useVoiceStore.setState({ activeDmCall: active(GROUP), disconnectFn });

    ws.deliver({ type: 'dm_call_ended', dmChannelId: GROUP });

    expect(useVoiceStore.getState().activeDmCall).toBeNull();
    expect(disconnectFn).toHaveBeenCalledTimes(1);
  });

  it('leaves alone a call in a different DM', () => {
    const ws = homeSocket();
    const disconnectFn = vi.fn().mockResolvedValue(undefined);
    useVoiceStore.setState({ activeDmCall: active(OTHER), disconnectFn });

    ws.deliver({ type: 'dm_call_rejected', dmChannelId: GROUP });
    ws.deliver({ type: 'dm_call_ended', dmChannelId: GROUP });

    expect(useVoiceStore.getState().activeDmCall).toEqual(active(OTHER));
    expect(disconnectFn).not.toHaveBeenCalled();
  });

  it('clears who is in the ended call, so no join is offered', () => {
    const ws = homeSocket();
    useVoiceStore.setState({ voiceUsers: new Map([[GROUP, ['alice', 'bob']]]) });

    ws.deliver({ type: 'dm_call_ended', dmChannelId: GROUP });

    expect(useVoiceStore.getState().voiceUsers.get(GROUP)).toEqual([]);
  });
});

describe('dmCallEventIsOurs', () => {
  it('matches a call held by its conversation key', () => {
    useVoiceStore.setState({ incomingCall: { dmChannelId: null, federatedCallId: 'key-group', callOrigin: '', callerId: 'c', callerName: 'C', livekit: null } });
    expect(dmCallEventIsOurs({ dmChannelId: GROUP })).toBe(true);
    expect(dmCallEventIsOurs({ dmChannelId: null, federatedCallId: 'key-group' })).toBe(true);
  });

  it('matches an event naming the key of the DM the client is calling', () => {
    useVoiceStore.setState({ outgoingCall: outgoing(GROUP) });
    expect(dmCallEventIsOurs({ dmChannelId: 'copy-on-peer', federatedCallId: 'key-group' })).toBe(true);
  });

  it('matches nothing when the client holds no call', () => {
    expect(dmCallEventIsOurs({ dmChannelId: GROUP, federatedCallId: 'key-group' })).toBe(false);
  });
});

describe('an accept in a DM call', () => {
  it('connects the caller of that DM', () => {
    const ws = homeSocket();
    const connectFn = vi.fn().mockResolvedValue(undefined);
    useVoiceStore.setState({ outgoingCall: outgoing(GROUP), connectFn });

    ws.deliver({ type: 'dm_call_accepted', dmChannelId: GROUP });

    expect(useVoiceStore.getState().outgoingCall).toBeNull();
    expect(useVoiceStore.getState().activeDmCall).toEqual(active(GROUP));
    expect(connectFn).toHaveBeenCalledWith(GROUP, true);
  });

  it('leaves alone a member calling a different DM', () => {
    const ws = homeSocket();
    const connectFn = vi.fn().mockResolvedValue(undefined);
    useVoiceStore.setState({ outgoingCall: outgoing(OTHER), connectFn });

    ws.deliver({ type: 'dm_call_accepted', dmChannelId: GROUP });

    expect(useVoiceStore.getState().outgoingCall).toEqual(outgoing(OTHER));
    expect(useVoiceStore.getState().activeDmCall).toBeNull();
    expect(connectFn).not.toHaveBeenCalled();
  });

  it('does not pull a member in a voice channel into the call', () => {
    const ws = homeSocket();
    useVoiceStore.setState({ isLiveKitConnected: true, currentVoiceChannelId: 'voice-1' });

    ws.deliver({ type: 'dm_call_accepted', dmChannelId: GROUP });

    expect(useVoiceStore.getState().activeDmCall).toBeNull();
  });
});

describe('what a ring leaves behind', () => {
  it('does not let a ring someone else answered tear down a later call', () => {
    const ws = homeSocket();
    const disconnectFn = vi.fn().mockResolvedValue(undefined);
    useVoiceStore.setState({ disconnectFn, isLiveKitConnected: false });

    // Rung for federated call F; another member answers it.
    ws.deliver({ type: 'dm_call_incoming', dmChannelId: null, federatedCallId: 'fed-f', callerId: 'c', callerName: 'C' });
    ws.deliver({ type: 'dm_call_accepted', dmChannelId: null, federatedCallId: 'fed-f' });
    expect(useVoiceStore.getState().incomingCall).toBeNull();

    // Later in a call in another DM, F ends.
    useVoiceStore.setState({ activeDmCall: active(OTHER) });
    ws.deliver({ type: 'dm_call_ended', dmChannelId: null, federatedCallId: 'fed-f' });

    expect(useVoiceStore.getState().activeDmCall).toEqual(active(OTHER));
    expect(disconnectFn).not.toHaveBeenCalled();
  });

  it('does not change the ids or the origin of the call the client is in', () => {
    const ws = homeSocket();
    const held = { dmChannelId: null, federatedCallId: 'fed-held', callOrigin: 'https://peer.example', livekit: null };
    useVoiceStore.setState({ activeDmCall: held });

    ws.deliver({
      type: 'dm_call_incoming', dmChannelId: null, federatedCallId: 'fed-new', callerId: 'c', callerName: 'C',
      livekitUrl: 'wss://host/lk', livekitToken: 'tok-new',
    });

    expect(useVoiceStore.getState().activeDmCall).toEqual(held);
    expect(useVoiceStore.getState().incomingCall).toEqual({
      dmChannelId: null, federatedCallId: 'fed-new', callOrigin: '', callerId: 'c', callerName: 'C',
      livekit: { url: 'wss://host/lk', token: 'tok-new' },
    });
    expect(dmCallEventIsOurs({ dmChannelId: null, federatedCallId: 'fed-held' })).toBe(true);
  });
});

describe('a ring answered on another device', () => {
  it('does not put a client sitting in a voice channel into the call', () => {
    const ws = homeSocket();
    const connectFn = vi.fn().mockResolvedValue(undefined);
    useVoiceStore.setState({ isLiveKitConnected: true, currentVoiceChannelId: 'voice-1', connectFn });
    ws.deliver({ type: 'dm_call_incoming', dmChannelId: GROUP, callerId: 'c', callerName: 'C' });

    ws.deliver({ type: 'dm_call_accepted', dmChannelId: GROUP });

    expect(useVoiceStore.getState().incomingCall).toBeNull();
    expect(useVoiceStore.getState().activeDmCall).toBeNull();
    expect(useVoiceStore.getState().currentVoiceChannelId).toBe('voice-1');
    expect(connectFn).not.toHaveBeenCalled();
  });
});

describe('an accept naming the held call by another id', () => {
  it('keeps the id a joined client holds the call by', () => {
    const ws = homeSocket();
    useVoiceStore.setState({ activeDmCall: active(GROUP), isLiveKitConnected: true });

    ws.deliver({ type: 'dm_call_accepted', dmChannelId: 'copy-on-peer', federatedCallId: 'key-group' });

    expect(useVoiceStore.getState().activeDmCall).toEqual(active(GROUP));
  });

  it('connects the caller under the id it called', () => {
    const ws = homeSocket();
    const connectFn = vi.fn().mockResolvedValue(undefined);
    useVoiceStore.setState({ outgoingCall: outgoing(GROUP), connectFn });

    ws.deliver({ type: 'dm_call_accepted', dmChannelId: 'copy-on-peer', federatedCallId: 'key-group' });

    expect(useVoiceStore.getState().activeDmCall).toEqual(active(GROUP));
    expect(connectFn).toHaveBeenCalledWith(GROUP, true);
  });
});

describe('a refused dm_call_accept', () => {
  it('takes the client out of the call it joined on its side', () => {
    const ws = homeSocket();
    const disconnectFn = vi.fn().mockResolvedValue(undefined);
    useVoiceStore.setState({ activeDmCall: active(GROUP), disconnectFn });

    ws.deliver({ type: 'error', message: 'This call has already ended', code: 'dm_call_not_found', dmChannelId: GROUP });

    expect(useVoiceStore.getState().activeDmCall).toBeNull();
    expect(disconnectFn).toHaveBeenCalledTimes(1);
    expect(useUIStore.getState().toasts[0]!.message).toBe(i18n.t('errors:dm_call_not_found'));
  });

  it('leaves alone a call in another DM', () => {
    const ws = homeSocket();
    const disconnectFn = vi.fn().mockResolvedValue(undefined);
    useVoiceStore.setState({ activeDmCall: active(OTHER), disconnectFn });

    ws.deliver({ type: 'error', message: 'This call has already ended', code: 'dm_call_not_found', dmChannelId: GROUP });

    expect(useVoiceStore.getState().activeDmCall).toEqual(active(OTHER));
    expect(disconnectFn).not.toHaveBeenCalled();
  });
});
