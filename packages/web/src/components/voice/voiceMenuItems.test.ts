import { describe, it, expect, vi, beforeEach } from 'vitest';

// Stub AudioManager to avoid an AudioWorkletNode reference error in jsdom.
// Reached transitively via spaceStore -> chatStore -> useWebSocket -> voiceStore.
vi.mock('../../audio/AudioManager', () => ({
  AudioManager: {
    getInstance: vi.fn().mockReturnValue({
      setOutputDevice: vi.fn(),
      setVolume: vi.fn(),
    }),
  },
}));

import { buildVoiceModMenuItems } from './voiceMenuItems';
import { useSpaceStore } from '../../stores/spaceStore';
import { useAuthStore } from '../../stores/authStore';
import { PermissionBits, permissionsToString } from '../../utils/permissions';

const bits = (...b: bigint[]) => permissionsToString(b.reduce((acc, x) => acc | x, 0n));

const ALL_MOD = [
  PermissionBits.MUTE_MEMBERS,
  PermissionBits.DEAFEN_MEMBERS,
  PermissionBits.MOVE_MEMBERS,
  PermissionBits.DISCONNECT_MEMBERS,
];

function seed(spacePerms: string, channelPerms: string): void {
  useSpaceStore.setState({
    channels: [
      { id: 'voice-1', spaceId: 'space-1', name: 'lobby', type: 'voice', topic: null, position: 0, categoryId: null, createdAt: 1 },
      { id: 'voice-2', spaceId: 'space-1', name: 'stage', type: 'voice', topic: null, position: 1, categoryId: null, createdAt: 1 },
    ],
    channelToSpaceMap: new Map([['voice-1', 'space-1'], ['voice-2', 'space-1']]),
    spacePermissions: new Map([['space-1', spacePerms]]),
    channelPermissions: new Map([['voice-1', channelPerms]]),
  });
}

const keys = () => buildVoiceModMenuItems('target-user', 'voice-1').map((i) => i.key);

beforeEach(() => {
  useSpaceStore.setState({ channelPermissions: new Map(), spacePermissions: new Map() });
});

// The server checks each moderation bit against the voice channel the target
// is in, overrides included (ws/events.ts), so the menu must read that
// channel's permissions rather than the space's.
describe('buildVoiceModMenuItems permission scope', () => {
  it('offers every action a channel override grants, with none granted space-wide', () => {
    seed(bits(PermissionBits.VIEW_CHANNEL), bits(PermissionBits.VIEW_CHANNEL, ...ALL_MOD));
    expect(keys()).toEqual(expect.arrayContaining(['space-mute', 'space-deafen', 'disconnect', 'move-to']));
  });

  it('offers nothing when a channel override denies what the space grants', () => {
    seed(bits(PermissionBits.VIEW_CHANNEL, ...ALL_MOD), bits(PermissionBits.VIEW_CHANNEL));
    expect(keys()).toEqual([]);
  });

  it('offers only the granted subset', () => {
    seed(bits(PermissionBits.VIEW_CHANNEL), bits(PermissionBits.VIEW_CHANNEL, PermissionBits.MUTE_MEMBERS));
    expect(keys()).toEqual(['space-mute']);
  });
});

// #299: the server refuses voice moderation of a member ranked at or above the
// actor (permissions.md, "Role hierarchy"), so the menu does not offer it.
describe('buildVoiceModMenuItems role hierarchy', () => {
  function role(id: string, position: number) {
    return { id, spaceId: 'space-1', name: id, color: '#c4b5fd', position, createdAt: 1 };
  }
  function user(id: string) {
    return {
      id, username: id, displayName: null, avatar: null, banner: null, accentColor: null, avatarColor: null,
      bio: null, status: 'online' as const, customStatus: null, isAdmin: false, createdAt: 1,
      homeInstance: null, homeUserId: null, replicatedInstances: [],
    };
  }
  function member(id: string, roles: ReturnType<typeof role>[]) {
    return { spaceId: 'space-1', userId: id, nickname: null, joinedAt: 1, user: user(id), roles };
  }

  beforeEach(() => {
    seed(bits(PermissionBits.VIEW_CHANNEL), bits(PermissionBits.VIEW_CHANNEL, ...ALL_MOD));
    useAuthStore.setState({ user: user('me') });
    useSpaceStore.setState({
      currentSpaceId: 'space-1',
      spaces: [{
        id: 'space-1', name: 'Space', icon: null, banner: null, avatarColor: null, ownerId: 'owner',
        inviteCode: null, visibility: 'public', directoryListed: false, description: null, createdAt: 1, _instanceOrigin: '',
      }],
      members: [
        member('me', [role('r-helper', 2)]),
        member('senior', [role('r-mod', 3)]),
        member('peer', [role('r-helper', 2)]),
        member('junior', [role('r-member', 1)]),
        member('owner', []),
      ],
    });
  });

  const keysFor = (target: string) => buildVoiceModMenuItems(target, 'voice-1').map((i) => i.key);

  it('offers nothing against a member ranked above or level with the viewer, or the owner', () => {
    expect(keysFor('senior')).toEqual([]);
    expect(keysFor('peer')).toEqual([]);
    expect(keysFor('owner')).toEqual([]);
  });

  it('offers the actions against a member ranked below the viewer', () => {
    expect(keysFor('junior')).toEqual(expect.arrayContaining(['space-mute', 'space-deafen', 'disconnect', 'move-to']));
  });

  it('offers everything to the space owner', () => {
    useAuthStore.setState({ user: user('owner') });
    expect(keysFor('senior')).toEqual(expect.arrayContaining(['space-mute', 'disconnect']));
  });
});
