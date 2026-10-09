import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resolveChannelNotificationPolicy, type NotificationSetting } from '@backspace/shared';

const list = vi.fn();
const updateSpace = vi.fn();
const updateChannel = vi.fn();
const clientFor = vi.fn((origin: string) => {
  void origin;
  return { notificationSettings: { list, updateSpace, updateChannel } };
});

vi.mock('../utils/crossStoreResolvers', () => ({
  getApiForOrigin: (origin: string) => clientFor(origin),
}));

const {
  notificationSettingKey,
  selectChannelNotificationPolicy,
  useNotificationSettingsStore,
} = await import('./notificationSettingsStore');

const REMOTE = 'https://remote.example';
const HOUR = 60 * 60 * 1000;

function setting(over: Partial<NotificationSetting> & Pick<NotificationSetting, 'spaceId'>): NotificationSetting {
  return { channelId: null, level: null, muted: false, mutedUntil: null, updatedAt: 1, ...over };
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => { resolve = r; });
  return { promise, resolve };
}

const store = () => useNotificationSettingsStore.getState();
const get = (origin: string, spaceId: string, channelId: string | null) =>
  store().settings.get(notificationSettingKey(origin, { spaceId, channelId }));

beforeEach(() => {
  list.mockReset();
  updateSpace.mockReset();
  updateChannel.mockReset();
  clientFor.mockClear();
  store().reset();
});

afterEach(() => {
  vi.useRealTimers();
  store().reset();
});

describe('notificationSettingKey', () => {
  it('keeps instances apart, and spaces apart from channels', () => {
    const keys = new Set([
      notificationSettingKey('', { spaceId: 'x', channelId: null }),
      notificationSettingKey(REMOTE, { spaceId: 'x', channelId: null }),
      notificationSettingKey('', { spaceId: 'y', channelId: 'x' }),
    ]);
    expect(keys.size).toBe(3);
  });
});

describe('load', () => {
  it('asks the instance at the origin and files its settings under that origin', async () => {
    list.mockResolvedValue({ settings: [setting({ spaceId: 's1', level: 'all' })] });
    await store().load(REMOTE);
    expect(clientFor).toHaveBeenCalledWith(REMOTE);
    expect(get(REMOTE, 's1', null)?.level).toBe('all');
    expect(get('', 's1', null)).toBeUndefined();
  });

  it('replaces that origin\'s entries and keeps the other origins\'', async () => {
    store().apply('', setting({ spaceId: 'home-space', level: 'nothing' }));
    store().apply(REMOTE, setting({ spaceId: 'gone', level: 'all' }));
    list.mockResolvedValue({ settings: [setting({ spaceId: 'kept', level: 'mentions' })] });
    await store().load(REMOTE);
    expect(get(REMOTE, 'gone', null)).toBeUndefined();
    expect(get(REMOTE, 'kept', null)?.level).toBe('mentions');
    expect(get('', 'home-space', null)?.level).toBe('nothing');
  });

  it('keeps a push that arrived while the list was loading when it is newer', async () => {
    const pending = deferred<{ settings: NotificationSetting[] }>();
    list.mockReturnValue(pending.promise);
    const loading = store().load(REMOTE);
    store().apply(REMOTE, setting({ spaceId: 's1', level: 'all', updatedAt: 20 }));
    pending.resolve({ settings: [setting({ spaceId: 's1', level: 'nothing', updatedAt: 10 })] });
    await loading;
    expect(get(REMOTE, 's1', null)?.level).toBe('all');
  });

  it('lets the list win over an older push that arrived while it was loading', async () => {
    const pending = deferred<{ settings: NotificationSetting[] }>();
    list.mockReturnValue(pending.promise);
    const loading = store().load(REMOTE);
    store().apply(REMOTE, setting({ spaceId: 's1', level: 'all', updatedAt: 5 }));
    pending.resolve({ settings: [setting({ spaceId: 's1', level: 'nothing', updatedAt: 10 })] });
    await loading;
    expect(get(REMOTE, 's1', null)?.level).toBe('nothing');
  });

  it('drops the answer of a load superseded by a newer one', async () => {
    const first = deferred<{ settings: NotificationSetting[] }>();
    const second = deferred<{ settings: NotificationSetting[] }>();
    list.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    const a = store().load(REMOTE);
    const b = store().load(REMOTE);
    second.resolve({ settings: [setting({ spaceId: 'new', level: 'all' })] });
    await b;
    first.resolve({ settings: [setting({ spaceId: 'old', level: 'all' })] });
    await a;
    expect(get(REMOTE, 'new', null)).toBeDefined();
    expect(get(REMOTE, 'old', null)).toBeUndefined();
  });

  it('drops an answer that arrives after a sign-out', async () => {
    const pending = deferred<{ settings: NotificationSetting[] }>();
    list.mockReturnValue(pending.promise);
    const loading = store().load('');
    store().reset();
    pending.resolve({ settings: [setting({ spaceId: 's1', level: 'all' })] });
    await loading;
    expect(store().settings.size).toBe(0);
  });

  it('leaves the store as it was when the instance cannot answer', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    store().apply(REMOTE, setting({ spaceId: 's1', level: 'all' }));
    list.mockRejectedValue(new Error('HTTP 404'));
    await store().load(REMOTE);
    expect(get(REMOTE, 's1', null)?.level).toBe('all');
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });
});

describe('apply', () => {
  it('keeps the newer of two writes', () => {
    store().apply('', setting({ spaceId: 's1', level: 'all', updatedAt: 10 }));
    store().apply('', setting({ spaceId: 's1', level: 'nothing', updatedAt: 5 }));
    expect(get('', 's1', null)?.level).toBe('all');
    store().apply('', setting({ spaceId: 's1', level: 'nothing', updatedAt: 11 }));
    expect(get('', 's1', null)?.level).toBe('nothing');
  });

  it('keeps a cleared setting as an entry, so an older push cannot bring the old one back', () => {
    store().apply('', setting({ spaceId: 's1', level: 'all', updatedAt: 10 }));
    store().apply('', setting({ spaceId: 's1', level: null, updatedAt: 11 }));
    store().apply('', setting({ spaceId: 's1', level: 'all', updatedAt: 10 }));
    expect(get('', 's1', null)?.level).toBeNull();
  });
});

describe('update', () => {
  it('writes a space setting to the space\'s instance and applies the answer', async () => {
    const answer = setting({ spaceId: 's1', level: 'nothing', updatedAt: 3 });
    updateSpace.mockResolvedValue(answer);
    await expect(store().update(REMOTE, { spaceId: 's1', channelId: null }, { level: 'nothing' })).resolves.toEqual(answer);
    expect(clientFor).toHaveBeenCalledWith(REMOTE);
    expect(updateSpace).toHaveBeenCalledWith('s1', { level: 'nothing' });
    expect(get(REMOTE, 's1', null)).toEqual(answer);
  });

  it('writes a channel setting through the channel route', async () => {
    const answer = setting({ spaceId: 's1', channelId: 'c1', muted: true, mutedUntil: 99, updatedAt: 3 });
    updateChannel.mockResolvedValue(answer);
    await store().update('', { spaceId: 's1', channelId: 'c1' }, { mute: '1h' });
    expect(updateChannel).toHaveBeenCalledWith('c1', { mute: '1h' });
    expect(updateSpace).not.toHaveBeenCalled();
    expect(get('', 's1', 'c1')?.muted).toBe(true);
  });

  it('rejects with the API error and changes nothing', async () => {
    updateSpace.mockRejectedValue(new Error('forbidden'));
    await expect(store().update('', { spaceId: 's1', channelId: null }, { level: 'all' })).rejects.toThrow('forbidden');
    expect(store().settings.size).toBe(0);
  });
});

describe('forgetOrigin', () => {
  it('drops only that instance\'s settings', () => {
    store().apply('', setting({ spaceId: 's1', level: 'all' }));
    store().apply(REMOTE, setting({ spaceId: 's1', level: 'nothing' }));
    store().forgetOrigin(REMOTE);
    expect(get(REMOTE, 's1', null)).toBeUndefined();
    expect(get('', 's1', null)?.level).toBe('all');
  });
});

describe('mute expiry clock', () => {
  it('bumps the clock when the nearest timed mute ends', () => {
    vi.useFakeTimers();
    const now = Date.now();
    store().apply('', setting({ spaceId: 's1', muted: true, mutedUntil: now + HOUR }));
    const before = store().clock;
    vi.advanceTimersByTime(HOUR - 10);
    expect(store().clock).toBe(before);
    vi.advanceTimersByTime(20);
    expect(store().clock).not.toBe(before);
  });

  it('arms nothing for an indefinite mute', () => {
    vi.useFakeTimers();
    store().apply('', setting({ spaceId: 's1', muted: true, mutedUntil: null }));
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe('resolveChannelNotificationPolicy', () => {
  const NOW = 1_000_000;

  it('defaults to mentions, not muted', () => {
    expect(resolveChannelNotificationPolicy(undefined, undefined, NOW)).toEqual({
      level: 'mentions', levelSource: 'default', muted: false, mutedUntil: null, channelMuted: false, spaceMuted: false, suppressEveryone: false, suppressRoles: false,
    });
  });

  it('inherits the space level when the channel has none', () => {
    const policy = resolveChannelNotificationPolicy(setting({ spaceId: 's', level: 'all' }), setting({ spaceId: 's', channelId: 'c', muted: true, mutedUntil: NOW + 5 }), NOW);
    expect(policy).toMatchObject({ level: 'all', levelSource: 'space', muted: true, channelMuted: true, spaceMuted: false, mutedUntil: NOW + 5 });
  });

  it('lets the channel level win over the space level', () => {
    const policy = resolveChannelNotificationPolicy(setting({ spaceId: 's', level: 'nothing' }), setting({ spaceId: 's', channelId: 'c', level: 'all' }), NOW);
    expect(policy).toMatchObject({ level: 'all', levelSource: 'channel' });
  });

  it('mutes the channel while its space is muted', () => {
    const policy = resolveChannelNotificationPolicy(setting({ spaceId: 's', muted: true, mutedUntil: null }), undefined, NOW);
    expect(policy).toMatchObject({ muted: true, spaceMuted: true, channelMuted: false, mutedUntil: null });
  });

  it('reads an ended mute as no mute', () => {
    const policy = resolveChannelNotificationPolicy(undefined, setting({ spaceId: 's', channelId: 'c', muted: true, mutedUntil: NOW }), NOW);
    expect(policy.muted).toBe(false);
  });

  it('reports the later end when both are muted, and none when either is indefinite', () => {
    const space = setting({ spaceId: 's', muted: true, mutedUntil: NOW + 100 });
    expect(resolveChannelNotificationPolicy(space, setting({ spaceId: 's', channelId: 'c', muted: true, mutedUntil: NOW + 50 }), NOW).mutedUntil).toBe(NOW + 100);
    expect(resolveChannelNotificationPolicy(space, setting({ spaceId: 's', channelId: 'c', muted: true, mutedUntil: null }), NOW).mutedUntil).toBeNull();
  });
});

describe('selectChannelNotificationPolicy', () => {
  it('reads the space and channel entries of the right instance', () => {
    store().apply(REMOTE, setting({ spaceId: 's', level: 'nothing' }));
    store().apply('', setting({ spaceId: 's', level: 'all' }));
    expect(selectChannelNotificationPolicy(store(), REMOTE, 's', 'c', Date.now()).level).toBe('nothing');
    expect(selectChannelNotificationPolicy(store(), '', 's', 'c', Date.now()).level).toBe('all');
  });

  it('resolves an unknown space to the defaults', () => {
    expect(selectChannelNotificationPolicy(store(), '', undefined, 'c', Date.now()).level).toBe('mentions');
  });
});


it('inherits mass-mention suppression only from the space, independently of level overrides', () => {
  const space: NotificationSetting = { spaceId: 'space', channelId: null, level: 'mentions', muted: false, mutedUntil: null, updatedAt: 1, suppressEveryone: true, suppressRoles: true };
  const channel: NotificationSetting = { ...space, channelId: 'channel', level: 'all', suppressEveryone: false, suppressRoles: false };
  expect(resolveChannelNotificationPolicy(space, channel, 2)).toMatchObject({ level: 'all', suppressEveryone: true, suppressRoles: true });
});
