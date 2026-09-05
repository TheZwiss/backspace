import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { EventEmitter } from 'node:events';
import { DBusError, Message, MessageBus, MessageType, sessionBus, Variant } from 'dbus-next';
import { KeybindConfig, PortalKeybindStatus, preferredTrigger } from './portalShortcut';

const SERVICE = 'org.freedesktop.portal.Desktop';
const PATH = '/org/freedesktop/portal/desktop';
const INTERFACE = 'org.freedesktop.portal.GlobalShortcuts';
const ACTIONS: Record<string, string> = {
  toggleMute: 'Toggle microphone', toggleDeafen: 'Toggle deafen', pushToTalk: 'Push to talk',
  toggleCamera: 'Toggle camera', toggleScreenShare: 'Toggle screen sharing', disconnect: 'Disconnect from voice',
};
type Properties = Record<string, Variant<unknown>>;
type Shortcut = [string, Properties];

/** One connection/session per configuration. BindShortcuts may only be called once per session. */
export class GlobalShortcutsPortal {
  private bus?: MessageBus;
  private session?: string;
  private owner?: string;
  private connection?: EventEmitter;
  private closed = false;
  private active = new Set<string>();
  private shortcuts: Record<string, string> = {};
  private requested = new Set<string>();
  private responses = new Map<string, (body: unknown[]) => void>();
  private cancellations = new Set<() => void>();

  constructor(
    private readonly action: (id: string, pressed: boolean) => void,
    private readonly status: (status: PortalKeybindStatus) => void,
    private readonly createBus: () => MessageBus = sessionBus,
  ) {}

  async start(bindings: KeybindConfig[]): Promise<void> {
    if (this.closed || this.bus) return;
    const shortcuts: Shortcut[] = [];
    for (const binding of bindings) {
      const trigger = preferredTrigger(binding);
      if (!trigger || !ACTIONS[binding.actionId] || this.requested.has(binding.actionId)) continue;
      this.requested.add(binding.actionId);
      shortcuts.push([binding.actionId, {
        description: new Variant('s', ACTIONS[binding.actionId]),
        preferred_trigger: new Variant('s', trigger),
      }]);
    }
    if (!shortcuts.length) {
      this.status({ state: 'idle', shortcuts: {} });
      return;
    }
    this.status({ state: 'pending', shortcuts: {} });
    try {
      this.bus = this.createBus();
      // dbus-next 0.10.2 forwards errors but not a clean socket EOF to MessageBus.
      // Observe its connection explicitly so a lost bus cannot leave PTT held.
      this.connection = (this.bus as MessageBus & { _connection?: EventEmitter })._connection;
      this.connection?.on('end', this.onEnd);
      this.bus.on('error', this.onError);
      this.bus.on('message', this.onMessage);
      // Register the desktop-file identity on the same connection before portal calls.
      // Flatpak provides a trusted identity itself and rejects host registration.
      if (!process.env.FLATPAK_ID && !existsSync('/.flatpak-info')) {
        try {
          await this.call('org.freedesktop.host.portal.Registry', 'Register', 'sa{sv}',
            ['io.github.TheZwiss.backspace', {}]);
        } catch (error) {
          if (!(error instanceof DBusError) || ![
            'org.freedesktop.DBus.Error.UnknownMethod', 'org.freedesktop.DBus.Error.UnknownInterface',
          ].includes(error.type)) throw error;
        }
      }
      // AddMatch also ensures the bus handshake has finished (and bus.name is set).
      await this.call('org.freedesktop.DBus', 'AddMatch', 's',
        [`type='signal',sender='${SERVICE}'`], '/org/freedesktop/DBus', 'org.freedesktop.DBus');
      await this.call('org.freedesktop.DBus', 'AddMatch', 's',
        [`type='signal',sender='org.freedesktop.DBus',interface='org.freedesktop.DBus',member='NameOwnerChanged',arg0='${SERVICE}'`],
        '/org/freedesktop/DBus', 'org.freedesktop.DBus');
      // Start the service in sandboxed runs too, before resolving its unique sender.
      await this.call('org.freedesktop.DBus', 'StartServiceByName', 'su',
        [SERVICE, 0], '/org/freedesktop/DBus', 'org.freedesktop.DBus');
      const owner = await this.call('org.freedesktop.DBus', 'GetNameOwner', 's',
        [SERVICE], '/org/freedesktop/DBus', 'org.freedesktop.DBus');
      this.owner = owner?.body[0] as string;
      const result = await this.request('CreateSession', 'a{sv}', (token) => [{
        handle_token: new Variant('s', token),
        session_handle_token: new Variant('s', `backspace_${randomUUID().replaceAll('-', '')}`),
      }]);
      const session = result.session_handle?.value;
      if (typeof session !== 'string' || !session.startsWith(`${PATH}/session/`)) {
        throw new Error('Portal returned an invalid session handle');
      }
      this.session = session;
      const bound = await this.request('BindShortcuts', 'oa(sa{sv})sa{sv}',
        (token) => [session, shortcuts, '', { handle_token: new Variant('s', token) }]);
      this.setShortcuts(bound.shortcuts?.value);
    } catch (error) {
      if (!this.closed) this.fail(error);
    }
  }

  private call(iface: string, member: string, signature: string, body: unknown[], path = PATH, destination = SERVICE): Promise<Message | null> {
    if (this.closed || !this.bus) return Promise.reject(new Error('Portal session closed'));
    return this.wait(this.bus.call(new Message({ destination, path, interface: iface, member, signature, body })), 15_000);
  }

  private wait<T>(promise: Promise<T>, timeout: number): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const cancel = () => finish(new Error('Portal session closed'));
      const timer = setTimeout(() => finish(new Error('Portal request timed out')), timeout);
      const finish = (error?: unknown, value?: T) => {
        clearTimeout(timer);
        this.cancellations.delete(cancel);
        if (error) reject(error);
        else resolve(value as T);
      };
      this.cancellations.add(cancel);
      promise.then((value) => finish(undefined, value), (error: unknown) => finish(error));
    });
  }

  private async request(member: string, signature: string, body: (token: string) => unknown[]): Promise<Properties> {
    const token = `backspace_${randomUUID().replaceAll('-', '')}`;
    const name = (this.bus as MessageBus & { name: string }).name;
    const path = `${PATH}/request/${name.slice(1).replaceAll('.', '_')}/${token}`;
    // Subscribe before the method call: a portal may respond before the method reply.
    const response = this.wait(new Promise<unknown[]>((resolve) => this.responses.set(path, resolve)), 120_000);
    // Attach a handler immediately, even if the method call is still outstanding.
    const result = response.then((values) => {
      if (values[0] !== 0) throw new Error('Global shortcut permission was cancelled or denied');
      return values[1] as Properties;
    });
    void result.catch(() => {});
    try {
      const reply = await this.call(INTERFACE, member, signature, body(token));
      if (reply?.body[0] !== path) throw new Error('Portal returned an unexpected request handle');
      return await result;
    } finally {
      this.responses.delete(path);
    }
  }

  private onMessage = (message: Message): void => {
    if (this.closed || message.type !== MessageType.SIGNAL) return;
    if (message.sender === 'org.freedesktop.DBus' && message.interface === 'org.freedesktop.DBus'
      && message.member === 'NameOwnerChanged' && message.body[0] === SERVICE
      && this.owner && message.body[1] === this.owner) {
      this.fail(new Error('Desktop portal restarted'));
      return;
    }
    if (!this.owner || message.sender !== this.owner) return;
    if (message.interface === 'org.freedesktop.portal.Request' && message.member === 'Response') {
      this.responses.get(message.path)?.(message.body);
    } else if (message.interface === 'org.freedesktop.portal.Session'
      && message.path === this.session && message.member === 'Closed') {
      this.fail(new Error('Global shortcut session was closed'));
    } else if (message.interface === INTERFACE && message.path === PATH && message.body[0] === this.session) {
      const id: unknown = message.body[1];
      if (message.member === 'ShortcutsChanged') {
        try { this.setShortcuts(id); } catch (error) { this.fail(error); }
      }
      else if (typeof id === 'string' && Object.hasOwn(this.shortcuts, id)) {
        if (message.member === 'Activated' && !this.active.has(id)) {
          this.active.add(id);
          this.action(id, true);
        } else if (message.member === 'Deactivated' && this.active.delete(id)) this.action(id, false);
      }
    }
  };

  private setShortcuts(value: unknown): void {
    const next: Record<string, string> = {};
    if (!Array.isArray(value)) throw new Error('Portal returned invalid shortcuts');
    for (const entry of value) {
      if (!Array.isArray(entry) || typeof entry[0] !== 'string' || !this.requested.has(entry[0])) continue;
      const description: unknown = entry[1]?.trigger_description?.value;
      if (typeof description === 'string' && description.length) next[entry[0]] = description;
    }
    for (const id of this.active) {
      if (!Object.hasOwn(next, id)) {
        this.active.delete(id);
        this.action(id, false);
      }
    }
    this.shortcuts = next;
    this.status({ state: 'ready', shortcuts: { ...next } });
  }

  private onError = (error: unknown): void => { if (!this.closed) this.fail(error); };
  private onEnd = (): void => { this.onError(new Error('Session bus disconnected')); };

  private fail(error: unknown): void {
    console.warn('[GlobalShortcutsPortal]', error);
    this.stop();
    this.status({ state: 'unavailable', shortcuts: {} });
  }

  stop(): void {
    if (this.closed) return;
    this.closed = true;
    for (const id of this.active) this.action(id, false);
    this.active.clear();
    for (const cancel of this.cancellations) cancel();
    this.cancellations.clear();
    this.responses.clear();
    this.connection?.removeListener('end', this.onEnd);
    this.connection = undefined;
    if (this.bus) {
      // Closing the connection also cancels pending requests and releases the session.
      // Explicit Close is best effort; never wait for a dead service on shutdown.
      if (this.session) {
        void this.bus.call(new Message({ destination: SERVICE, path: this.session,
          interface: 'org.freedesktop.portal.Session', member: 'Close' })).catch(() => {});
      }
      this.bus.removeListener('message', this.onMessage);
      this.bus.disconnect();
      this.bus = undefined;
    }
  }
}
