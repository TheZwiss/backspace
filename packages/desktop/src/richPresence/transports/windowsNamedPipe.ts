import net from 'net';
import { IPC_SLOTS } from '../protocol';
import type {
  RichPresenceEndpoint,
  RichPresenceTransport,
  RichPresenceTransportServer,
} from './types';

export function discordNamedPipePath(slot: number): string {
  return `\\\\.\\pipe\\discord-ipc-${slot}`;
}

function pipeStatus(address: string, timeoutMs = 400): Promise<'live' | 'free' | 'occupied'> {
  return new Promise((resolve) => {
    const client = net.connect(address);
    let settled = false;
    const finish = (result: 'live' | 'free' | 'occupied') => {
      if (settled) return;
      settled = true;
      client.destroy();
      resolve(result);
    };
    client.once('connect', () => finish('live'));
    client.once('error', (err) => {
      const code = (err as NodeJS.ErrnoException).code;
      finish(code === 'ENOENT' || code === 'ECONNREFUSED' ? 'free' : 'occupied');
    });
    setTimeout(() => finish('live'), timeoutMs);
  });
}

export class WindowsNamedPipeTransport implements RichPresenceTransport {
  readonly kind = 'named-pipe' as const;

  async listAvailableEndpoints(): Promise<RichPresenceEndpoint[]> {
    const endpoints: RichPresenceEndpoint[] = [];
    for (const slot of IPC_SLOTS) {
      const address = discordNamedPipePath(slot);
      if (await pipeStatus(address) === 'free') {
        endpoints.push({ id: address, address, kind: this.kind });
      }
    }
    return endpoints;
  }

  async listen(
    endpoint: RichPresenceEndpoint,
    onConnection: (socket: net.Socket) => void,
  ): Promise<RichPresenceTransportServer | null> {
    const server = net.createServer(onConnection);
    const listening = await new Promise<boolean>((resolve) => {
      server.once('error', () => resolve(false));
      server.listen(endpoint.address, () => resolve(true));
    });
    if (!listening) {
      server.close();
      return null;
    }
    return { endpoint, close: () => server.close() };
  }
}
