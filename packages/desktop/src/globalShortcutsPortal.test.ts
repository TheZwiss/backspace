import { EventEmitter } from 'node:events';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DBusError, Message, MessageBus, MessageType, Variant } from 'dbus-next';
import { GlobalShortcutsPortal } from './globalShortcutsPortal';

const PATH = '/org/freedesktop/portal/desktop';
const IFACE = 'org.freedesktop.portal.GlobalShortcuts';
const SESSION = `${PATH}/session/1_2/test`;

class FakeBus extends EventEmitter {
  name = ':1.2';
  _connection = new EventEmitter();
  disconnect = vi.fn();
  denied = false;
  suspended = false;
  shortcuts = [['pushToTalk', { trigger_description: new Variant('s', 'Ctrl+V') }]];
  call = vi.fn(async (message: Message) => {
    if (message.member === 'GetNameOwner') return new Message({ type: MessageType.METHOD_RETURN, replySerial: '1', body: [':1.99'] });
    if (message.member === 'CreateSession' || message.member === 'BindShortcuts' || message.member === 'ListShortcuts') {
      const options = message.body.at(-1) as Record<string, Variant<string>>;
      const path = `${PATH}/request/1_2/${options.handle_token!.value}`;
      const result = message.member === 'CreateSession'
        ? { session_handle: new Variant('s', SESSION) }
        : { shortcuts: new Variant('a(sa{sv})', this.shortcuts) };
      // Deliberately respond synchronously, BEFORE returning the method reply.
      if (!this.suspended) this.signal('org.freedesktop.portal.Request', 'Response', [this.denied ? 1 : 0, result], path);
      return new Message({ type: MessageType.METHOD_RETURN, replySerial: '1', body: [path] });
    }
    return new Message({ type: MessageType.METHOD_RETURN, replySerial: '1', body: [] });
  });
  signal(iface: string, member: string, body: unknown[], path = PATH, sender = ':1.99') {
    this.emit('message', new Message({ type: MessageType.SIGNAL, interface: iface, member, path, sender, body }));
  }
}

const clients: GlobalShortcutsPortal[] = [];
function setup() {
  const bus = new FakeBus();
  const action = vi.fn();
  const status = vi.fn();
  const client = new GlobalShortcutsPortal(action, status, () => bus as unknown as MessageBus);
  clients.push(client);
  return { bus, action, status, client };
}
afterEach(() => {
  for (const client of clients.splice(0)) client.stop();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe('GlobalShortcuts portal lifecycle', () => {
  it('restores system registration on restart without local bindings', async () => {
    const { bus, client, status } = setup();
    await client.start();
    const calls = bus.call.mock.calls.map(([m]) => m.member);
    expect(calls.indexOf('ListShortcuts')).toBeLessThan(calls.indexOf('BindShortcuts'));
    expect(status).toHaveBeenLastCalledWith({ state: 'ready', shortcuts: { pushToTalk: 'Ctrl+V' } });
  });
  it('refreshes the full list on partial system changes and on focus refresh', async () => {
    const { bus, client, status, action } = setup();
    await client.start(true);
    bus.signal(IFACE, 'Activated', [SESSION, 'pushToTalk']);
    bus.shortcuts = [
      ['pushToTalk', { trigger_description: new Variant('s', 'F9') }],
      ['toggleMute', { trigger_description: new Variant('s', 'F8') }],
    ];
    bus.signal(IFACE, 'ShortcutsChanged', [SESSION, [bus.shortcuts[0]]]);
    await client.refresh();
    expect(status).toHaveBeenLastCalledWith({ state: 'ready', shortcuts: { pushToTalk: 'F9', toggleMute: 'F8' } });
    expect(action).toHaveBeenLastCalledWith('pushToTalk', false);
    // Also recover when the backend did not send a signal while its settings were open.
    bus.shortcuts = [['pushToTalk', { trigger_description: new Variant('s', '') }]];
    await client.refresh();
    expect(status).toHaveBeenLastCalledWith({ state: 'ready', shortcuts: {} });
    expect(bus.call.mock.calls.filter(([m]) => m.member === 'BindShortcuts')).toHaveLength(1);
  });
  it('registers identity, handles early responses, and reports the actual assigned trigger', async () => {
    const { bus, status, client } = setup();
    await client.start(true);
    expect(bus.call.mock.calls[0]![0].member).toBe('Register');
    expect(status).toHaveBeenLastCalledWith({ state: 'ready', shortcuts: { pushToTalk: 'Ctrl+V' } });
    const bind = bus.call.mock.calls.find(([message]) => message.member === 'BindShortcuts')![0];
    expect(bind.signature).toBe('oa(sa{sv})sa{sv}');
    expect(bind.body[1].map((entry: [string, unknown]) => entry[0])).toEqual([
      'toggleMute', 'toggleDeafen', 'pushToTalk', 'toggleCamera', 'toggleScreenShare', 'disconnect',
    ]);
    for (const entry of bind.body[1]) expect(entry[1]).not.toHaveProperty('preferred_trigger');
    await client.start(true);
    expect(bus.call.mock.calls.filter(([message]) => message.member === 'BindShortcuts')).toHaveLength(1);
  });
  it('handles hold/release, rejects foreign signals, and deduplicates repeated activation', async () => {
    const { bus, action, client } = setup();
    await client.start(true);
    bus.signal(IFACE, 'Activated', [SESSION, 'pushToTalk'], PATH, ':1.666');
    bus.signal(IFACE, 'Activated', ['/other', 'pushToTalk']);
    bus.signal(IFACE, 'Activated', [SESSION, 'unknown']);
    expect(action).not.toHaveBeenCalled();
    bus.signal(IFACE, 'Activated', [SESSION, 'pushToTalk']);
    bus.signal(IFACE, 'Activated', [SESSION, 'pushToTalk']);
    bus.signal(IFACE, 'Deactivated', [SESSION, 'pushToTalk']);
    bus.signal(IFACE, 'Deactivated', [SESSION, 'pushToTalk']);
    expect(action.mock.calls).toEqual([['pushToTalk', true], ['pushToTalk', false]]);
  });
  it.each(['stop', 'closed', 'error', 'eof', 'restart', 'removed'])('releases held PTT on %s', async (reason) => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { bus, action, status, client } = setup();
    await client.start(true);
    bus.signal(IFACE, 'Activated', [SESSION, 'pushToTalk']);
    if (reason === 'stop') client.stop();
    if (reason === 'closed') bus.signal('org.freedesktop.portal.Session', 'Closed', [], SESSION);
    if (reason === 'error') bus.emit('error', new Error('disconnected'));
    if (reason === 'eof') bus._connection.emit('end');
    if (reason === 'restart') bus.signal('org.freedesktop.DBus', 'NameOwnerChanged',
      ['org.freedesktop.portal.Desktop', ':1.99', ''], '/org/freedesktop/DBus', 'org.freedesktop.DBus');
    if (reason === 'removed') {
      bus.shortcuts = [];
      bus.signal(IFACE, 'ShortcutsChanged', [SESSION, []]);
      await client.refresh();
    }
    expect(action.mock.calls).toEqual([['pushToTalk', true], ['pushToTalk', false]]);
    if (['closed', 'error', 'restart'].includes(reason)) {
      expect(status).toHaveBeenLastCalledWith({ state: 'unavailable', shortcuts: {} });
    }
  });
  it('keeps declined bindings out of the global set and does not prompt on first launch', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { bus, status, client } = setup();
    bus.denied = true;
    await client.start(true);
    expect(status).toHaveBeenLastCalledWith({ state: 'unavailable', shortcuts: {} });
    expect(bus.disconnect).toHaveBeenCalledOnce();
    const other = setup();
    other.bus.shortcuts = [];
    await other.client.start();
    expect(other.bus.call.mock.calls.some(([m]) => m.member === 'BindShortcuts')).toBe(false);
    expect(other.status).toHaveBeenLastCalledWith({ state: 'idle', shortcuts: {} });
  });
  it('releases resources when stopped during a permission dialog', async () => {
    const { bus, client, status } = setup();
    bus.suspended = true;
    const started = client.start(true);
    await vi.waitFor(() => expect(bus.call.mock.calls.some(([m]) => m.member === 'CreateSession')).toBe(true));
    client.stop();
    await started;
    expect(status).toHaveBeenCalledTimes(1);
    expect(bus.disconnect).toHaveBeenCalledOnce();
  });
  it('times out an unanswered portal method without leaking timers', async () => {
    vi.useFakeTimers();
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { bus, client, status } = setup();
    bus.call.mockImplementation(() => new Promise(() => {}));
    const started = client.start(true);
    await vi.advanceTimersByTimeAsync(15_000);
    await started;
    expect(status).toHaveBeenLastCalledWith({ state: 'unavailable', shortcuts: {} });
    expect(vi.getTimerCount()).toBe(0);
  });
  it('accepts older portals without the optional host Registry', async () => {
    const { bus, client, status } = setup();
    bus.call.mockRejectedValueOnce(new DBusError('org.freedesktop.DBus.Error.UnknownMethod', 'old portal'));
    await client.start(true);
    expect(status).toHaveBeenLastCalledWith({ state: 'ready', shortcuts: { pushToTalk: 'Ctrl+V' } });
  });
});
