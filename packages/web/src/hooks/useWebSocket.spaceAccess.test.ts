import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Channel, MemberWithUser, Role, SpaceWithChannelsAndMembers, User } from '@backspace/shared';

// jsdom has no AudioWorkletNode; the handler's imports reach the voice stack.
vi.mock('../audio/AudioManager', () => ({
  AudioManager: {
    getInstance: vi.fn().mockReturnValue({
      setOutputDevice: vi.fn(),
      setVolume: vi.fn(),
      playSound: vi.fn(() => Promise.resolve(null)),
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

const { connectInstance, disconnectInstance } = await import('./useWebSocket');
const { useSpaceStore } = await import('../stores/spaceStore');
const { useChatStore } = await import('../stores/chatStore');
const { useUIStore } = await import('../stores/uiStore');
const { api } = await import('../api/client');
const { initI18n } = await import('../i18n');
const i18n = (await import('../i18n')).default;

type TaggedSpace = import('../stores/spaceStore').TaggedSpace;

// #374: a change to the space's roles arrives as `space_access_changed`. The
// client refetches that space's detail without the loading skeleton and
// without touching its message caches; a channel the refresh no longer lists
// goes the way a deleted one does. #365: a voice moderation refusal reaches
// the user as a toast.

const SPACE_ID = 'sp';
const OTHER_ID = 'sp-other';

function space(id: string): TaggedSpace {
  return {
    id, name: `Space ${id}`, icon: null, banner: null, avatarColor: 'lavender', ownerId: 'owner',
    inviteCode: null, visibility: 'public', directoryListed: false, description: '', createdAt: 1,
    _instanceOrigin: '',
  };
}

function channel(id: string, spaceId = SPACE_ID): Channel & { myPermissions: string } {
  return { id, spaceId, name: id, type: 'text', topic: null, position: 0, categoryId: null, createdAt: 1, myPermissions: '1026' };
}

function role(id: string, position: number, spaceId = SPACE_ID): Role {
  return { id, spaceId, name: id, color: '#c4b5fd', position, permissions: '0', createdAt: 1 };
}

function user(id: string): User {
  return {
    id, username: id, displayName: null, avatar: null, banner: null, accentColor: null, avatarColor: null,
    bio: null, status: 'online', customStatus: null, isAdmin: false, createdAt: 1, homeInstance: null, homeUserId: null,
    replicatedInstances: [],
  };
}

function member(id: string, roles: Role[]): MemberWithUser {
  return { spaceId: SPACE_ID, userId: id, nickname: null, joinedAt: 1, user: user(id), roles };
}

function detail(id: string, channels: Channel[], roles: Role[], members: MemberWithUser[], myPermissions: string): SpaceWithChannelsAndMembers {
  const s = space(id);
  return {
    id, name: s.name, icon: null, banner: null, avatarColor: s.avatarColor, ownerId: s.ownerId, inviteCode: null,
    visibility: s.visibility, directoryListed: false, description: '', createdAt: 1,
    channels, categories: [], members, roles, myPermissions,
  };
}

const opened: string[] = [];
function homeSocket(): FakeWebSocket {
  connectInstance('', 'token-home');
  opened.push('');
  const ws = FakeWebSocket.all.at(-1)!;
  ws.open();
  return ws;
}

const cachedMessages = [{ id: 'm1' }] as unknown as ReturnType<typeof useChatStore.getState>['messages'] extends Map<string, infer V> ? V : never;

beforeEach(async () => {
  await initI18n();
  FakeWebSocket.all = [];
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'log').mockImplementation(() => {});
  useUIStore.setState({ toasts: [] });
  useSpaceStore.setState({
    spaces: [space(SPACE_ID), space(OTHER_ID)],
    currentSpaceId: SPACE_ID,
    loadingSpaceId: null,
    channels: [channel('general'), channel('staff')],
    categories: [],
    roles: [role(SPACE_ID, 0), role('r-mod', 1)],
    members: [member('me', [])],
    spacePermissions: new Map([[SPACE_ID, '1026'], [OTHER_ID, '1026']]),
    channelPermissions: new Map([['general', '1026'], ['staff', '1026']]),
    channelToSpaceMap: new Map([['general', SPACE_ID], ['staff', SPACE_ID], ['other-general', OTHER_ID]]),
    channelOriginMap: new Map([['general', ''], ['staff', ''], ['other-general', '']]),
  });
  useChatStore.setState({
    currentChannelId: 'staff',
    messages: new Map([['general', cachedMessages], ['staff', cachedMessages]]),
  });
});

afterEach(() => {
  for (const origin of opened.splice(0)) disconnectInstance(origin);
  vi.restoreAllMocks();
});

describe('space_access_changed (#374)', () => {
  it('refreshes the open space quietly: no skeleton, caches kept, roles and members replaced', async () => {
    const roles = [role(SPACE_ID, 0), role('r-mod', 2), role('r-new', 1)];
    let land!: () => void;
    vi.spyOn(api.spaces, 'get').mockImplementation(() => new Promise((resolve) => {
      land = () => resolve(detail(SPACE_ID, [channel('general'), channel('staff')], roles, [member('me', [roles[1]!])], '1030'));
    }));
    const loadingSeen: (string | null)[] = [];
    const unsubscribe = useSpaceStore.subscribe((s) => { loadingSeen.push(s.loadingSpaceId); });

    homeSocket().deliver({ type: 'space_access_changed', spaceId: SPACE_ID });
    land();
    await vi.waitFor(() => expect(useSpaceStore.getState().roles.map((r) => r.id)).toContain('r-new'));
    unsubscribe();

    expect(loadingSeen.every((id) => id === null)).toBe(true);
    const state = useSpaceStore.getState();
    expect(state.members[0]!.roles.map((r) => r.id)).toEqual(['r-mod']);
    expect(state.spacePermissions.get(SPACE_ID)).toBe('1030');
    expect(state.currentSpaceId).toBe(SPACE_ID);
    const chat = useChatStore.getState();
    expect(chat.messages.get('general')).toBe(cachedMessages);
    expect(chat.messages.get('staff')).toBe(cachedMessages);
    expect(chat.currentChannelId).toBe('staff');
  });

  it('closes the open channel when the refresh no longer lists it, the way channel_deleted does', async () => {
    vi.spyOn(api.spaces, 'get').mockResolvedValue(detail(SPACE_ID, [channel('general')], [role(SPACE_ID, 0)], [member('me', [])], '1026'));

    homeSocket().deliver({ type: 'space_access_changed', spaceId: SPACE_ID });

    await vi.waitFor(() => expect(useChatStore.getState().currentChannelId).toBeNull());
    const state = useSpaceStore.getState();
    expect(state.channels.map((c) => c.id)).toEqual(['general']);
    expect(state.channelToSpaceMap.has('staff')).toBe(false);
    expect(useChatStore.getState().messages.get('general')).toBe(cachedMessages);
  });

  it('for a space that is not open, updates its permissions without opening it', async () => {
    vi.spyOn(api.spaces, 'get').mockResolvedValue(detail(OTHER_ID, [channel('other-general', OTHER_ID)], [role(OTHER_ID, 0, OTHER_ID)], [], '8'));

    homeSocket().deliver({ type: 'space_access_changed', spaceId: OTHER_ID });

    await vi.waitFor(() => expect(useSpaceStore.getState().spacePermissions.get(OTHER_ID)).toBe('8'));
    const state = useSpaceStore.getState();
    expect(state.currentSpaceId).toBe(SPACE_ID);
    expect(state.channels.map((c) => c.id)).toEqual(['general', 'staff']);
    expect(state.roles.map((r) => r.id)).toEqual([SPACE_ID, 'r-mod']);
    expect(useChatStore.getState().currentChannelId).toBe('staff');
  });

  it('makes a channel the viewer can now see known to the lookups, and forgets one they cannot', async () => {
    vi.spyOn(api.spaces, 'get').mockResolvedValue(detail(OTHER_ID, [channel('other-secret', OTHER_ID)], [role(OTHER_ID, 0, OTHER_ID)], [], '8'));

    homeSocket().deliver({ type: 'space_access_changed', spaceId: OTHER_ID });

    await vi.waitFor(() => expect(useSpaceStore.getState().channelToSpaceMap.get('other-secret')).toBe(OTHER_ID));
    const state = useSpaceStore.getState();
    expect(state.channelOriginMap.get('other-secret')).toBe('');
    expect(state.channelPermissions.get('other-secret')).toBe('1026');
    expect(state.channelToSpaceMap.has('other-general')).toBe(false);
    expect(state.channels.map((c) => c.id)).toEqual(['general', 'staff']);
  });

  it('ignores a space this client does not have from that origin', () => {
    const get = vi.spyOn(api.spaces, 'get');
    homeSocket().deliver({ type: 'space_access_changed', spaceId: 'unknown' });
    expect(get).not.toHaveBeenCalled();
  });
});

describe('a refused action over the socket (#365)', () => {
  it('shows the localized refusal for an error with a code', () => {
    homeSocket().deliver({ type: 'error', message: 'role hierarchy', code: 'role_hierarchy' });
    const toasts = useUIStore.getState().toasts;
    expect(toasts).toHaveLength(1);
    expect(toasts[0]!.message).toBe(i18n.t('errors:role_hierarchy'));
    expect(toasts[0]!.type).toBe('warning');
  });

  it('only logs an error without a code, as older servers send', () => {
    homeSocket().deliver({ type: 'error', message: 'Rate limited' });
    expect(useUIStore.getState().toasts).toHaveLength(0);
  });
});
